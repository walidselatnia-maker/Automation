import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { all, get, getDb, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { ImageClient } from '../integrations/images.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { html, raw } from '../web/views/layout.js';
import { newLayout, type NewFlash } from './layout.js';
import { flowProjectFor, pictureMakerBusy, type PictureShape } from './pictures.js';
import { getNewWebsite, listNewWebsites, websiteApiKey, type NewWebsiteRow } from './repo.js';

/**
 * Photo jobs: a website hands out posts that are missing photos, one job at
 * a time (GET /api/v1/photo-jobs/next). Each photo is made here, one by one,
 * with the same image service and Flow project as article pictures, uploaded
 * to the site's media library, and the job is handed back with
 * POST /api/v1/photo-jobs/:id/done. The site places the photos itself and
 * paces the jobs; a failed job is reported with /failed and the site requeues it.
 */

const log = createLogger('newsite-photo-jobs');

interface JobRow {
  id: number;
  website_id: number;
  site_job_id: string;
  post_id: number;
  title: string;
  url: string;
  status: 'making' | 'done' | 'failed';
  error: string;
  created_at: string;
}

interface PhotoRow {
  id: number;
  job_id: number;
  slot: string;
  kind: string;
  text: string;
  prompt: string;
  alt: string;
  status: 'queued' | 'done' | 'failed';
  attempts: number;
  error: string;
  file: string;
  media_id: number | null;
}

const MAX_TRIES = 2;

function ensureTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS photo_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER NOT NULL,
      site_job_id TEXT NOT NULL,
      post_id INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'making',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (website_id, site_job_id)
    );
    CREATE TABLE IF NOT EXISTS photo_job_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      slot TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      alt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      file TEXT NOT NULL DEFAULT '',
      media_id INTEGER,
      UNIQUE (job_id, slot)
    );
  `);
}

export interface PhotoJobDeps {
  settings: Settings;
  encryptionKey: Buffer;
  readFlash: (query: unknown) => NewFlash;
  fetchImpl?: typeof fetch;
  dataDir?: string;
  /** Start the poller. Tests turn it off. */
  autoStart?: boolean;
  make?: (prompt: string, projectId: string, shape: PictureShape) => Promise<{ data: Buffer; contentType: string }>;
  /** Whether article pictures are being made. Tests stand it in. */
  mainBusy?: () => boolean;
}

const PAUSED_KEY = 'photo_jobs_paused';

const call = async (deps: PhotoJobDeps, site: NewWebsiteRow, path: string, body?: unknown): Promise<any> => {
  const response = await (deps.fetchImpl ?? fetch)(`https://${site.domain}/api/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${websiteApiKey(site, deps.encryptionKey)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${site.domain} answered HTTP ${response.status} for ${path}`);
  return response.json().catch(() => ({}));
};

const shapeOf = (kind: string): PictureShape => (kind === 'step' ? 'SQUARE' : 'PORTRAIT_3_4');

/** A detailed photo prompt from the site's own words for the photo, the post and the website's picture style. */
function promptFor(site: NewWebsiteRow, post: Record<string, unknown>, photo: { kind: string; text: string }): string {
  const title = String(post.title ?? '');
  const ingredients = Array.isArray(post.ingredients) ? ` Ingredients in view where they belong: ${post.ingredients.slice(0, 12).join(', ')}.` : '';
  const what =
    photo.kind === 'cover'
      ? `Hero photo for "${title}": the finished result as the star, a styled, lived-in scene with depth.`
      : photo.kind === 'step'
        ? `Photo of this step of making "${title}", hands at work, only what exists at this moment: ${photo.text}`
        : `Photo for "${title}": ${photo.text}`;
  const style = site.picture_style.trim() ? ` Style: ${site.picture_style.trim()}.` : ' Realistic natural-light photograph, true colours, no text, no watermark.';
  return `${what}${ingredients}${style}`.replace(/\s+/g, ' ').trim();
}

/**
 * Photo jobs give way: to Pause, and to article pictures. The articles are the
 * main work, and both send pictures to the one Flow tab, so a photo is only
 * made when no article picture is being made.
 */
const mustWait = (deps: PhotoJobDeps): boolean =>
  deps.settings.get(PAUSED_KEY) === '1' || (deps.mainBusy ?? pictureMakerBusy)();

let busy = false;
/** Which website is asked first next time, so every website gets its turn. */
let turn = 0;

/** One look: carry on the job being made, else ask each website for its next job. */
export async function photoJobTick(deps: PhotoJobDeps): Promise<void> {
  if (busy || mustWait(deps)) return;
  busy = true;
  try {
    let job = get<JobRow>(`SELECT * FROM photo_jobs WHERE status = 'making' ORDER BY id LIMIT 1`);
    if (!job) {
      const sites = listNewWebsites().filter((s) => s.status === 'active');
      const start = sites.length ? turn++ % sites.length : 0;
      for (const site of [...sites.slice(start), ...sites.slice(0, start)]) {
        const answer = await call(deps, site, 'photo-jobs/next').catch(() => null);
        const j = answer?.job;
        if (!j || !Array.isArray(j.photos)) continue;
        const post = (j.post ?? {}) as Record<string, unknown>;
        run(
          `INSERT INTO photo_jobs (website_id, site_job_id, post_id, title, url, status, error) VALUES (?, ?, ?, ?, ?, 'making', '')
           ON CONFLICT (website_id, site_job_id) DO UPDATE SET status = 'making', error = ''`,
          site.id, String(j.id), Number(post.id) || 0, String(post.title ?? ''), String(post.url ?? ''),
        );
        job = get<JobRow>('SELECT * FROM photo_jobs WHERE website_id = ? AND site_job_id = ?', site.id, String(j.id))!;
        for (const p of j.photos as { slot: string; kind?: string; text?: string }[]) {
          const kind = String(p.kind ?? '');
          const text = String(p.text ?? '');
          run(
            `INSERT INTO photo_job_photos (job_id, slot, kind, text, prompt, alt) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (job_id, slot) DO UPDATE SET status = CASE status WHEN 'done' THEN 'done' ELSE 'queued' END, attempts = 0`,
            job.id, String(p.slot), kind, text, promptFor(site, post, { kind, text }), `${String(post.title ?? '')} ${text}`.trim().slice(0, 160),
          );
        }
        break;
      }
    }
    if (job) await makeJob(job, deps);
  } catch (err) {
    log.warn(`Photo jobs: ${errorMessage(err)}`);
  } finally {
    busy = false;
  }
}

/** Make the job's photos one at a time, then hand it back to the website. */
async function makeJob(job: JobRow, deps: PhotoJobDeps): Promise<void> {
  const site = getNewWebsite(job.website_id);
  if (!site) return void run(`UPDATE photo_jobs SET status = 'failed', error = 'Website removed.' WHERE id = ?`, job.id);
  const settings = deps.settings;
  const project = flowProjectFor(site.project_id, site.domain, settings);
  const make =
    deps.make ??
    ((prompt: string, projectId: string, shape: PictureShape) =>
      new ImageClient({
        baseUrl: settings.get('image_base_url'),
        apiKey: settings.get('image_api_key'),
        pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
        maxAttempts: settings.getNumber('image_poll_max_attempts'),
        projectId,
        imageModel: settings.get('image_model'),
      }).generate(prompt, shape));
  const dir = join(deps.dataDir ?? resolveDataDir(), 'photo-jobs', String(job.id));
  const gapMs = Math.max(0, settings.getNumber('image_gap_seconds')) * 1000;

  for (;;) {
    const photo = get<PhotoRow>(`SELECT * FROM photo_job_photos WHERE job_id = ? AND status = 'queued' ORDER BY id LIMIT 1`, job.id);
    if (!photo) break;
    // Checked before every photo, not only before the job: Pause stops it
    // after the photo in hand, and article pictures go first. The job stays
    // Making and carries on from here on a later tick.
    if (mustWait(deps)) return;
    run('UPDATE photo_job_photos SET attempts = attempts + 1 WHERE id = ?', photo.id);
    try {
      const { data, contentType } = await make(photo.prompt, project.projectId, shapeOf(photo.kind));
      const ext = contentType.includes('png') ? 'png' : contentType.includes('jpeg') ? 'jpg' : 'webp';
      mkdirSync(dir, { recursive: true });
      const file = `${photo.slot}.${ext}`;
      writeFileSync(join(dir, file), data);
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(readFileSync(join(dir, file)))], { type: contentType || 'image/webp' }), file);
      form.set('alt', photo.alt);
      const response = await (deps.fetchImpl ?? fetch)(`https://${site.domain}/api/v1/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${websiteApiKey(site, deps.encryptionKey)}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`${site.domain} did not take the photo (HTTP ${response.status}).`);
      const mediaId = Number(((await response.json().catch(() => null)) as { media?: { id?: unknown } } | null)?.media?.id);
      if (!Number.isFinite(mediaId)) throw new Error(`${site.domain} took the photo but did not say its id.`);
      run(`UPDATE photo_job_photos SET status = 'done', error = '', file = ?, media_id = ? WHERE id = ?`, file, mediaId, photo.id);
    } catch (err) {
      const message = errorMessage(err).slice(0, 400);
      run(`UPDATE photo_job_photos SET status = ?, error = ? WHERE id = ?`, photo.attempts + 1 >= MAX_TRIES ? 'failed' : 'queued', message, photo.id);
    }
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }

  const photos = all<PhotoRow>('SELECT * FROM photo_job_photos WHERE job_id = ? ORDER BY id', job.id);
  const done = photos.filter((p) => p.status === 'done' && p.media_id);
  const failed = photos.filter((p) => p.status === 'failed');
  try {
    if (done.length) await call(deps, site, `photo-jobs/${job.site_job_id}/done`, { photos: done.map((p) => ({ slot: p.slot, mediaId: p.media_id })) });
    if (failed.length) {
      const error = failed[0]!.error || 'A photo could not be made.';
      if (!done.length) await call(deps, site, `photo-jobs/${job.site_job_id}/failed`, { error }).catch(() => {});
      run(`UPDATE photo_jobs SET status = 'failed', error = ? WHERE id = ?`, `${failed.length} of ${photos.length} photos failed: ${error}`, job.id);
    } else {
      run(`UPDATE photo_jobs SET status = 'done', error = '' WHERE id = ?`, job.id);
    }
  } catch (err) {
    run(`UPDATE photo_jobs SET status = 'failed', error = ? WHERE id = ?`, errorMessage(err).slice(0, 400), job.id);
  }
}

const CSS = `
.pj-table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); }
.pj-table th, .pj-table td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
.pj-table th { color: var(--faint); font-size: 13px; font-weight: 600; }
.pj-table form { margin: 0; }
.pj-err { color: var(--bad); font-size: 13px; margin-top: 4px; }
.pj-bar { display: flex; flex-wrap: wrap; gap: 8px; }
.pj-site { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 18px 22px; margin-bottom: 16px; }
.pj-site-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 12px; }
.pj-site-head h2 { font-size: 19px; }
.pj-more { margin-top: 12px; }
.pj-more summary { cursor: pointer; font-weight: 600; color: var(--idle-ink); }
.pj-more .pj-table { margin-top: 10px; }
h2.pj-h { font-size: 19px; margin: 28px 0 12px; }
`;

interface MissingPhotos {
  totals?: { noImages?: number; anyMissing?: number };
  queue?: { queued?: number; working?: number; done?: number; failed?: number };
  posts?: { id: number; title: string; type?: string; noImages?: boolean; missing?: string[]; queue?: string | null }[];
}

/** One website's posts missing photos, from the website itself; null when it cannot say. */
const missingOn = (deps: PhotoJobDeps, site: NewWebsiteRow): Promise<MissingPhotos | null> =>
  call(deps, site, 'missing-photos').catch(() => null);

const SHOWN = 100;

function siteSection(site: NewWebsiteRow, m: MissingPhotos | null) {
  if (!m) {
    return html`<section class="pj-site"><div class="pj-site-head"><h2>${site.name}</h2><span class="ns-mono">${site.domain}</span></div>
      <p class="pj-err">Could not read the missing photos of this website.</p></section>`;
  }
  const posts = m.posts ?? [];
  const q = m.queue ?? {};
  return html`<section class="pj-site">
    <div class="pj-site-head">
      <h2>${site.name}</h2><span class="ns-mono">${site.domain}</span>
      <span class="ns-tag">No photos ${String(m.totals?.noImages ?? 0)}</span>
      <span class="ns-tag">Missing some ${String(m.totals?.anyMissing ?? 0)}</span>
      <span class="ns-tag">Queued ${String(q.queued ?? 0)}</span>
      <span class="ns-tag">Working ${String(q.working ?? 0)}</span>
      <span class="ns-tag">Done ${String(q.done ?? 0)}</span>
      <span class="ns-tag">Failed ${String(q.failed ?? 0)}</span>
    </div>
    ${posts.length
      ? html`<form method="post" action="/new-website/photo-jobs/site/${String(site.id)}/queue">
          <div class="pj-bar">
            <button class="ns-btn small primary" name="what" value="picked">Queue picked</button>
            <button class="ns-btn small" name="what" value="none">Queue all with no photos</button>
            <button class="ns-btn small" name="what" value="all">Queue all</button>
          </div>
          <details class="pj-more"><summary>${String(posts.length)} posts</summary>
          <table class="pj-table">
            <thead><tr><th></th><th>Post</th><th>Missing</th><th>Queue</th></tr></thead>
            <tbody>${posts.slice(0, SHOWN).map(
              (p) => html`<tr>
                <td><input type="checkbox" name="ids" value="${String(p.id)}" ${raw(p.queue === 'queued' || p.queue === 'working' ? 'disabled' : '')}></td>
                <td>${p.title}</td>
                <td>${p.noImages ? 'All photos' : String((p.missing ?? []).length)}</td>
                <td>${p.queue ?? ''}</td>
              </tr>`,
            )}</tbody>
          </table></details>
        </form>`
      : raw('')}
  </section>`;
}

export function registerPhotoJobRoutes(app: FastifyInstance, deps: PhotoJobDeps): void {
  ensureTables();
  // A restart mid-photo: that photo goes back in the queue.
  if (deps.autoStart !== false) {
    setInterval(() => void photoJobTick(deps), 60_000).unref();
    setTimeout(() => void photoJobTick(deps), 20_000).unref();
  }

  app.get('/new-website/photo-jobs', async (request, reply) => {
    const jobs = all<JobRow & { domain: string; made: number; total: number }>(
      `SELECT j.*, COALESCE(w.domain, '') AS domain,
              (SELECT COUNT(*) FROM photo_job_photos p WHERE p.job_id = j.id AND p.status = 'done') AS made,
              (SELECT COUNT(*) FROM photo_job_photos p WHERE p.job_id = j.id) AS total
         FROM photo_jobs j LEFT JOIN new_websites w ON w.id = j.website_id ORDER BY j.id DESC LIMIT 200`,
    );
    const paused = deps.settings.get(PAUSED_KEY) === '1';
    const sites = listNewWebsites().filter((s) => s.status === 'active');
    const missing = await Promise.all(sites.map((s) => missingOn(deps, s)));
    const badge = (s: JobRow['status']) =>
      s === 'done' ? html`<span class="ns-badge ok">Done</span>` : s === 'failed' ? html`<span class="ns-badge bad">Failed</span>` : html`<span class="ns-badge busy">Making</span>`;
    const body = html`
      <style>${raw(CSS)}</style>
      <div class="ns-head">
        <div><h1 class="ns-title">Photo jobs</h1></div>
        <div class="pj-bar">
          <form method="post" action="/new-website/photo-jobs/check"><button class="ns-btn primary">Check now</button></form>
          <form method="post" action="/new-website/photo-jobs/pause"><button class="ns-btn">${paused ? 'Start' : 'Pause'}</button></form>
        </div>
      </div>
      ${sites.map((site, i) => siteSection(site, missing[i]!))}
      <h2 class="pj-h">Jobs</h2>
      <table class="pj-table">
        <thead><tr><th>Website</th><th>Post</th><th>Photos</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${jobs.length
            ? jobs.map(
                (j) => html`<tr>
                  <td class="ns-mono">${j.domain}</td>
                  <td>${j.url ? html`<a href="${j.url}" target="_blank" rel="noopener">${j.title || j.url}</a>` : j.title}${j.error ? html`<div class="pj-err">${j.error}</div>` : raw('')}</td>
                  <td class="ns-num">${String(j.made)} / ${String(j.total)}</td>
                  <td>${badge(j.status)}</td>
                  <td>${j.status === 'failed' ? html`<form method="post" action="/new-website/photo-jobs/${String(j.id)}/retry"><button class="ns-btn small">Try again</button></form>` : raw('')}</td>
                </tr>`,
              )
            : html`<tr><td colspan="5">No photo jobs yet.</td></tr>`}
        </tbody>
      </table>`;
    return reply.type('text/html; charset=utf-8').send(newLayout({ title: 'Photo jobs', active: '/new-website/photo-jobs', body, flash: deps.readFlash(request.query) }));
  });

  app.post('/new-website/photo-jobs/check', async (_request, reply) => {
    void photoJobTick(deps);
    return reply.redirect('/new-website/photo-jobs?ok=' + encodeURIComponent('Checking the websites for photo jobs.'), 303);
  });

  app.post('/new-website/photo-jobs/site/:id/queue', async (request, reply) => {
    const site = getNewWebsite(Number((request.params as { id: string }).id) || 0);
    if (!site) return reply.redirect('/new-website/photo-jobs', 303);
    const form = (request.body ?? {}) as { what?: string; ids?: string | string[] };
    const ids = (Array.isArray(form.ids) ? form.ids : form.ids ? [form.ids] : []).map(Number).filter(Number.isFinite);
    const body = form.what === 'all' ? { all: true } : form.what === 'none' ? { all: true, only: 'none' } : { ids };
    if (form.what === 'picked' && !ids.length) return reply.redirect('/new-website/photo-jobs?error=' + encodeURIComponent('Tick the posts to queue first.'), 303);
    try {
      const answer = (await call(deps, site, 'missing-photos/queue', body)) as { added?: number };
      void photoJobTick(deps);
      return reply.redirect('/new-website/photo-jobs?ok=' + encodeURIComponent(`${String(answer.added ?? 0)} posts queued on ${site.domain}.`), 303);
    } catch (err) {
      return reply.redirect('/new-website/photo-jobs?error=' + encodeURIComponent(errorMessage(err)), 303);
    }
  });

  app.post('/new-website/photo-jobs/pause', async (_request, reply) => {
    const paused = deps.settings.get(PAUSED_KEY) === '1';
    deps.settings.set(PAUSED_KEY, paused ? '0' : '1');
    return reply.redirect('/new-website/photo-jobs', 303);
  });

  app.post('/new-website/photo-jobs/:id/retry', async (request, reply) => {
    const id = Number((request.params as { id: string }).id) || 0;
    run(`UPDATE photo_job_photos SET status = 'queued', attempts = 0, error = '' WHERE job_id = ? AND status = 'failed'`, id);
    run(`UPDATE photo_jobs SET status = 'making', error = '' WHERE id = ?`, id);
    void photoJobTick(deps);
    return reply.redirect('/new-website/photo-jobs', 303);
  });
}
