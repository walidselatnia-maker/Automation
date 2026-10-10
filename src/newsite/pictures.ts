import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { describeProjectId, resolveProjectId, type ResolvedProjectId } from '../core/project-id.js';
import { ImageClient } from '../integrations/images.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { parseImageSet } from './images.js';

/**
 * The pictures themselves: each AI#4 prompt made into a picture by the image
 * service, exactly the way the old dashboard makes article images
 * (src/pipeline/context.ts and src/pipeline/steps/images.ts):
 * - the same ImageClient, built from the same settings;
 * - the same Flow project, from resolveProjectId (the website's own, else the
 *   shared one from Settings, else the old placeholder);
 * - the same call, generate(prompt, 'VERTICAL');
 * - the same pause between images (image_gap_seconds), counted from when the
 *   previous image came back;
 * - one image at a time, and a failed image stops its article there, like a
 *   failed step stops an old run. Pressing Make again carries on from it.
 * Nothing is sent until someone presses "Make pictures". Each picture is
 * downloaded the moment it is made and kept in the platform's data folder.
 */

const log = createLogger('newsite-pictures');

export interface PictureRow {
  id: number;
  seo_id: number;
  slot: string;
  position: number;
  prompt: string;
  alt: string;
  status: 'queued' | 'making' | 'done' | 'failed';
  attempts: number;
  error: string;
  file: string;
  made_at: string | null;
}

/** Where one keyword's pictures are kept. */
export const pictureDir = (seoId: number, dataDir = resolveDataDir()): string =>
  join(dataDir, 'newsite-pictures', String(seoId));

export const listPictures = (seoId: number): PictureRow[] =>
  all<PictureRow>('SELECT * FROM newsite_pictures WHERE seo_id = ? ORDER BY position', seoId);

export const listPlanPictures = (planId: number): PictureRow[] =>
  all<PictureRow>(
    `SELECT p.* FROM newsite_pictures p JOIN keyword_seo s ON s.id = p.seo_id WHERE s.plan_id = ? ORDER BY s.position, p.position`,
    planId,
  );

export const getPicture = (id: number): PictureRow | undefined =>
  get<PictureRow>('SELECT * FROM newsite_pictures WHERE id = ?', id);

/** The current prompts of one keyword, by slot. Empty when it has none that passed. */
function currentPrompts(seoId: number): { slot: string; prompt: string; alt: string }[] {
  const row = get<{ images_status: string; images_json: string }>('SELECT images_status, images_json FROM keyword_seo WHERE id = ?', seoId);
  if (!row || row.images_status !== 'done') return [];
  return parseImageSet(row.images_json)?.images ?? [];
}

/** Forget one keyword's pictures, files included. */
export function clearPictures(seoId: number, dataDir = resolveDataDir()): void {
  run('DELETE FROM newsite_pictures WHERE seo_id = ?', seoId);
  rmSync(pictureDir(seoId, dataDir), { recursive: true, force: true });
}

/**
 * Put one keyword's pictures in the queue. A picture already made from the
 * same prompt is kept; a failed one gets fresh tries; one whose prompt was
 * rewritten since is made again. Returns how many were queued.
 */
export function queuePictures(seoId: number, dataDir = resolveDataDir()): number {
  const prompts = currentPrompts(seoId);
  if (!prompts.length) return 0;
  const have = new Map(listPictures(seoId).map((p) => [p.slot, p]));
  const wanted = new Set(prompts.map((p) => p.slot));
  // Slots the prompts no longer have.
  for (const old of have.values()) {
    if (wanted.has(old.slot)) continue;
    if (old.file) rmSync(join(pictureDir(seoId, dataDir), old.file), { force: true });
    run('DELETE FROM newsite_pictures WHERE id = ?', old.id);
  }
  let queued = 0;
  prompts.forEach((p, position) => {
    const old = have.get(p.slot);
    if (old && old.prompt === p.prompt && (old.status === 'done' || old.status === 'making' || old.status === 'queued')) {
      run('UPDATE newsite_pictures SET position = ?, alt = ? WHERE id = ?', position, p.alt, old.id);
      if (old.status === 'queued') queued += 1;
      return;
    }
    if (old) {
      if (old.file) rmSync(join(pictureDir(seoId, dataDir), old.file), { force: true });
      run(
        `UPDATE newsite_pictures SET position = ?, prompt = ?, alt = ?, status = 'queued', attempts = 0, error = '', file = '', made_at = NULL WHERE id = ?`,
        position, p.prompt, p.alt, old.id,
      );
    } else {
      run(
        `INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status) VALUES (?, ?, ?, ?, ?, 'queued')`,
        seoId, p.slot, position, p.prompt, p.alt,
      );
    }
    queued += 1;
  });
  return queued;
}

/** A restart mid-picture: it goes back in the queue, and the cut-off try does not count. */
export function resetInterruptedPictures(): void {
  run(`UPDATE newsite_pictures SET status = 'queued', attempts = MAX(0, attempts - 1) WHERE status = 'making'`);
}

/* -- The maker ------------------------------------------------------------ */

export interface PictureDeps {
  settings: Settings;
  /** Makes one picture. The real one is the old dashboard's ImageClient; tests pass their own. */
  make?: (prompt: string, projectId: string) => Promise<{ data: Buffer; contentType: string }>;
  dataDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

let running: Promise<void> | null = null;
let lastImageGeneratedAt: number | null = null;

/** For tests: forget the gap between cases. */
export function resetPictureMakerState(): void {
  lastImageGeneratedAt = null;
}

/** The Flow project a website's pictures go into: the old dashboard's own rule. */
export const flowProjectFor = (siteProjectId: string, domain: string, settings: Settings): ResolvedProjectId =>
  resolveProjectId(siteProjectId, settings.get('flow_project_id'), domain);

export { describeProjectId };

/** The old dashboard's image client (PipelineContext), built from the same settings. */
const oldDashboardMaker = (settings: Settings) => (prompt: string, projectId: string) =>
  new ImageClient({
    baseUrl: settings.get('image_base_url'),
    apiKey: settings.get('image_api_key'),
    pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
    maxAttempts: settings.getNumber('image_poll_max_attempts'),
    projectId,
    imageModel: settings.get('image_model'),
  })
    .generate(prompt, 'VERTICAL')
    .then(({ data, contentType }) => ({ data, contentType }));

const extension = (contentType: string): string =>
  contentType.includes('png') ? 'png' : contentType.includes('jpeg') ? 'jpg' : 'webp';

/**
 * Make every queued picture, one at a time. Calling it while it runs does
 * nothing extra: the running pass picks up pictures queued meanwhile.
 */
export function kickPictureMaker(deps: PictureDeps): Promise<void> {
  if (running) return running;
  const make = deps.make ?? oldDashboardMaker(deps.settings);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dataDir = deps.dataDir ?? resolveDataDir();

  running = Promise.resolve()
    .then(async () => {
      for (;;) {
        const next = get<PictureRow & { domain: string; project_id: string }>(
          `SELECT p.*, w.domain, w.project_id FROM newsite_pictures p
             JOIN keyword_seo s ON s.id = p.seo_id
             JOIN keyword_plans k ON k.id = s.plan_id
             JOIN new_websites w ON w.id = k.website_id
            WHERE p.status = 'queued' ORDER BY p.id LIMIT 1`,
        );
        if (!next) break;

        // A prompt rewritten after it was queued is not sent: it is stale.
        const current = currentPrompts(next.seo_id).find((p) => p.slot === next.slot);
        if (!current || current.prompt !== next.prompt) {
          run('DELETE FROM newsite_pictures WHERE id = ?', next.id);
          continue;
        }

        const project = flowProjectFor(next.project_id, next.domain, deps.settings);
        const explanation = describeProjectId(project, next.domain);
        if (project.source === 'placeholder') log.warn(explanation);
        else log.debug(explanation);

        // The old waitOutImageGap: only the remainder of the gap is waited.
        const gapMs = Math.max(0, deps.settings.getNumber('image_gap_seconds')) * 1000;
        if (lastImageGeneratedAt !== null && gapMs > 0) {
          const remaining = gapMs - (now() - lastImageGeneratedAt);
          if (remaining > 0) await sleep(remaining);
        }

        run(`UPDATE newsite_pictures SET status = 'making', attempts = attempts + 1 WHERE id = ?`, next.id);
        try {
          const { data, contentType } = await make(next.prompt, project.projectId);
          lastImageGeneratedAt = now();
          const dir = pictureDir(next.seo_id, dataDir);
          mkdirSync(dir, { recursive: true });
          const file = `${next.slot}-${next.id}.${extension(contentType)}`;
          writeFileSync(join(dir, file), data);
          run(`UPDATE newsite_pictures SET status = 'done', error = '', file = ?, made_at = datetime('now') WHERE id = ?`, file, next.id);
        } catch (err) {
          const message = errorMessage(err).slice(0, 400);
          log.warn(`Picture "${next.slot}" (${next.id}) failed: ${message}`);
          run(`UPDATE newsite_pictures SET status = 'failed', error = ? WHERE id = ?`, message, next.id);
          // Like a failed step in an old run: this article stops here, and
          // its other pictures wait until Make pictures is pressed again.
          run(`DELETE FROM newsite_pictures WHERE seo_id = ? AND status = 'queued'`, next.seo_id);
        }
      }
    })
    .finally(() => {
      running = null;
    });
  return running;
}
