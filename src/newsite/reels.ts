import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { ImageClient } from '../integrations/images.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { pictureMediaUrl } from '../core/media-links.js';
import { loadTemplate } from '../pipeline/prompts.js';
import type { Settings } from '../settings.js';
import { websiteChannels } from './channels.js';
import { flowProjectFor, isMainSlot, listPictures } from './pictures.js';
import { getKeywordPlan, getNewWebsite } from './repo.js';
import { getSeoRow } from './seo.js';

/**
 * Reels for a published article: one 10-second vertical video per platform
 * (Pinterest, Facebook, Instagram), made in Google Flow from ONE prompt --
 * that platform's own prompt file, prompts/newsite-reel-<platform>.template.txt
 * -- and the article's own pictures. No storyboard, no editing: one prompt,
 * one video, the way the old dashboard's single-clip reel is made.
 */

const log = createLogger('newsite-reels');

/** The platforms that get a reel, each with its own prompt file. */
export const REEL_PLATFORMS = ['pinterest', 'facebook', 'instagram'] as const;
export const reelPromptFile = (platform: string): string => `newsite-reel-${platform}.template.txt`;

/** Flow takes at most this many photos in one request. */
const MAX_REFERENCES = 3;
const FAILED = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);

export interface ReelRow {
  id: number;
  seo_id: number;
  platform: string;
  prompt: string;
  status: 'pending' | 'making' | 'done' | 'failed';
  job_id: string;
  file: string;
  error: string;
  created_at: string;
  done_at: string | null;
}

export const reelDir = (dataDir = resolveDataDir()): string => join(dataDir, 'newsite-reels');
export const getReel = (id: number): ReelRow | undefined => get<ReelRow>('SELECT * FROM newsite_reels WHERE id = ?', id);
export const listPlanReels = (planId: number): ReelRow[] =>
  all<ReelRow>(
    `SELECT r.* FROM newsite_reels r JOIN keyword_seo s ON s.id = r.seo_id WHERE s.plan_id = ? ORDER BY s.position, r.platform`,
    planId,
  );

/** The platforms an article's website shares on that get a reel. */
function reelPlatformsFor(websiteId: number): string[] {
  const own = new Set(websiteChannels(websiteId).map((c) => c.platform));
  return REEL_PLATFORMS.filter((p) => own.has(p));
}

/** Queue a reel for each of the website's reel platforms the article has none for yet. Returns how many. */
export function createReels(seoId: number): number {
  const row = getSeoRow(seoId);
  const plan = row ? getKeywordPlan(row.plan_id) : undefined;
  if (!row || !plan || row.post_status !== 'published') return 0;
  let added = 0;
  for (const platform of reelPlatformsFor(plan.website_id)) {
    const res = run(`INSERT OR IGNORE INTO newsite_reels (seo_id, platform) VALUES (?, ?)`, seoId, platform);
    added += Number(res.changes ?? 0);
  }
  return added;
}

/** Make a reel again from its prompt file (a failed one, or one you want redone). */
export function remakeReel(id: number): boolean {
  const reel = getReel(id);
  if (!reel || reel.status === 'making') return false;
  run(`UPDATE newsite_reels SET status = 'pending', job_id = '', error = '', prompt = '' WHERE id = ?`, id);
  return true;
}

export interface ReelDeps {
  settings: Settings;
  encryptionKey: Buffer;
  dataDir?: string;
  /** Flow, through the old dashboard's image service. Tests pass their own. */
  flow?: {
    submitVideo(input: { prompt: string; referenceUrls: string[]; projectId?: string }): Promise<string>;
    poll(jobId: string): Promise<{ status?: string; image_url?: string; error?: string }>;
  };
  download?: (url: string) => Promise<Buffer>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const flowOf = (settings: Settings) =>
  new ImageClient({
    baseUrl: settings.get('image_base_url'),
    apiKey: settings.get('image_api_key'),
    pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
    maxAttempts: settings.getNumber('image_poll_max_attempts'),
  });

const defaultDownload = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`the video could not be downloaded (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
};

/** The article's own pictures, as links Flow can fetch. */
function referenceLinks(seoId: number, deps: ReelDeps): string[] {
  const base = deps.settings.get('public_base_url').trim();
  if (!base) {
    throw new Error('This platform has no public address yet, so Flow cannot fetch the article pictures. Open the dashboard once at its https address, or set it in Platform settings → Images.');
  }
  const pictures = listPictures(seoId).filter((p) => isMainSlot(p.slot) && p.status === 'done' && p.file);
  if (!pictures.length) throw new Error('The article has no pictures to make the reel from.');
  const days = Number(deps.settings.get('reel_media_link_days')) || 7;
  return pictures
    .slice(0, MAX_REFERENCES)
    .map((p) => pictureMediaUrl(base, p.id, (p.file.split('.').pop() ?? 'png').toLowerCase(), days, deps.encryptionKey, (deps.now ?? Date.now)()));
}

/** Make one reel: its prompt, then Flow, then wait for the video and keep it. */
async function make(reel: ReelRow, deps: ReelDeps): Promise<void> {
  const row = getSeoRow(reel.seo_id);
  const plan = row ? getKeywordPlan(row.plan_id) : undefined;
  const site = plan ? getNewWebsite(plan.website_id) : undefined;
  if (!row || !site) throw new Error('Its article is gone.');
  const prompt = loadTemplate(reelPromptFile(reel.platform), { title: row.title || row.keyword, keyword: row.keyword });
  const references = referenceLinks(reel.seo_id, deps);
  const flow = deps.flow ?? flowOf(deps.settings);
  const project = flowProjectFor(site.project_id, site.domain, deps.settings);
  const jobId = await flow.submitVideo({ prompt, referenceUrls: references, projectId: project.projectId });
  run(`UPDATE newsite_reels SET status = 'making', prompt = ?, job_id = ?, error = '' WHERE id = ?`, prompt, jobId, reel.id);
  log.info(`reel ${reel.id} (${reel.platform}): video job ${jobId} from ${references.length} picture(s)`);

  // A video takes minutes: ask every 15 seconds, for up to 20 minutes.
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < 80; i++) {
    await sleep(15_000);
    const job = await flow.poll(jobId);
    const status = (job.status ?? '').toUpperCase();
    if (status === 'COMPLETED' && job.image_url) {
      const data = await (deps.download ?? defaultDownload)(job.image_url);
      const dir = reelDir(deps.dataDir);
      mkdirSync(dir, { recursive: true });
      const file = `reel-${reel.id}.mp4`;
      writeFileSync(join(dir, file), data);
      run(`UPDATE newsite_reels SET status = 'done', file = ?, error = '', done_at = datetime('now') WHERE id = ?`, file, reel.id);
      log.info(`reel ${reel.id} (${reel.platform}): video made`);
      return;
    }
    if (FAILED.has(status)) throw new Error(`Flow could not make the video: ${job.error ?? status}`);
  }
  throw new Error('Flow took more than 20 minutes to make the video.');
}

let running: Promise<void> | null = null;

/** Make every waiting reel, one at a time. Calling it while it runs does nothing extra. */
export function kickReels(deps: ReelDeps): Promise<void> {
  if (running) return running;
  running = (async () => {
    try {
      for (;;) {
        const next = get<ReelRow>(`SELECT * FROM newsite_reels WHERE status = 'pending' ORDER BY id LIMIT 1`);
        if (!next) return;
        try {
          await make(next, deps);
        } catch (err) {
          run(`UPDATE newsite_reels SET status = 'failed', error = ? WHERE id = ?`, errorMessage(err), next.id);
          log.warn(`reel ${next.id} (${next.platform}) failed: ${errorMessage(err)}`);
        }
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

/** A restart leaves a reel half made: it starts again. */
export function resetInterruptedReels(): void {
  run(`UPDATE newsite_reels SET status = 'pending', job_id = '' WHERE status = 'making'`);
}
