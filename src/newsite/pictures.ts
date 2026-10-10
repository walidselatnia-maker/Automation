import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { resolveProjectId } from '../core/project-id.js';
import { ImageClient } from '../integrations/images.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { parseImageSet } from './images.js';

/**
 * The pictures themselves: each AI#4 prompt sent to Google Flow through the
 * Flowkit image service, one at a time.
 *
 * Flowkit drives the Flow web app, so it is treated gently:
 * - nothing is sent until someone presses "Make pictures";
 * - one picture at a time, never two at once, with the platform's gap
 *   (Platform -> Images) between one picture and the next;
 * - every picture is its own row, so a failure never makes a finished
 *   picture again, and each gets at most MAX_TRIES tries;
 * - STOP_AFTER failures in a row pause all picture making and send a
 *   Telegram message; nothing more is sent until someone presses Resume.
 *   A broken Flow session then costs a few captchas, not a whole queue's.
 * Flow's links expire, so each picture is downloaded the moment it is made
 * and kept in the platform's data folder.
 */

const log = createLogger('newsite-pictures');

export const MAX_TRIES = 2;
export const STOP_AFTER = 3;
/** Set while picture making is paused; its value says why. */
export const PAUSE_KEY = 'newsite_pictures_paused';

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

/** Try one failed picture again, with fresh tries. */
export function retryPicture(id: number): void {
  run(`UPDATE newsite_pictures SET status = 'queued', attempts = 0, error = '' WHERE id = ? AND status = 'failed'`, id);
}

/** A restart mid-picture: it goes back in the queue, and the cut-off try does not count. */
export function resetInterruptedPictures(): void {
  run(`UPDATE newsite_pictures SET status = 'queued', attempts = MAX(0, attempts - 1) WHERE status = 'making'`);
}

export const pausedReason = (settings: Settings): string => settings.get(PAUSE_KEY);

/* -- The maker ------------------------------------------------------------ */

export interface PictureDeps {
  settings: Settings;
  /** Makes one picture. The real one goes through Flowkit; tests pass their own. */
  make?: (prompt: string, projectId: string) => Promise<{ data: Buffer; contentType: string }>;
  notify?: (message: string) => Promise<void>;
  dataDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

let running: Promise<void> | null = null;
let lastPictureAt: number | null = null;
let failStreak = 0;

/** For tests: forget the gap and the failure streak between cases. */
export function resetPictureMakerState(): void {
  lastPictureAt = null;
  failStreak = 0;
}

const flowMaker = (settings: Settings) => (prompt: string, projectId: string) =>
  new ImageClient({
    baseUrl: settings.get('image_base_url'),
    apiKey: settings.get('image_api_key'),
    pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
    maxAttempts: settings.getNumber('image_poll_max_attempts'),
    projectId,
    imageModel: settings.get('image_model'),
  })
    .generate(prompt, 'HORIZONTAL')
    .then(({ data, contentType }) => ({ data, contentType }));

const extension = (contentType: string): string =>
  contentType.includes('png') ? 'png' : contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'webp';

/** Resume after a stop: clears the pause and the failure streak. */
export function resumePictures(settings: Settings): void {
  settings.set(PAUSE_KEY, '');
  failStreak = 0;
}

/**
 * Make every queued picture, one at a time. Calling it while it runs does
 * nothing extra: the running pass picks up pictures queued meanwhile.
 */
export function kickPictureMaker(deps: PictureDeps): Promise<void> {
  if (running) return running;
  const make = deps.make ?? flowMaker(deps.settings);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dataDir = deps.dataDir ?? resolveDataDir();

  running = Promise.resolve()
    .then(async () => {
      for (;;) {
        if (pausedReason(deps.settings)) break;
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

        // The gap, counted from when the previous picture came back.
        const gapMs = Math.max(0, deps.settings.getNumber('image_gap_seconds')) * 1000;
        if (lastPictureAt !== null) {
          const wait = lastPictureAt + gapMs - now();
          if (wait > 0) await sleep(wait);
        }
        if (pausedReason(deps.settings)) break;

        run(`UPDATE newsite_pictures SET status = 'making', attempts = attempts + 1 WHERE id = ?`, next.id);
        const projectId = resolveProjectId(next.project_id, deps.settings.get('flow_project_id'), next.domain).projectId;
        try {
          const { data, contentType } = await make(next.prompt, projectId);
          const dir = pictureDir(next.seo_id, dataDir);
          mkdirSync(dir, { recursive: true });
          const file = `${next.slot}-${next.id}.${extension(contentType)}`;
          writeFileSync(join(dir, file), data);
          run(`UPDATE newsite_pictures SET status = 'done', error = '', file = ?, made_at = datetime('now') WHERE id = ?`, file, next.id);
          failStreak = 0;
        } catch (err) {
          const message = errorMessage(err).slice(0, 400);
          failStreak += 1;
          const tries = next.attempts + 1;
          log.warn(`Picture "${next.slot}" (${next.id}) failed, try ${tries} of ${MAX_TRIES}: ${message}`);
          run(
            `UPDATE newsite_pictures SET status = ?, error = ? WHERE id = ?`,
            tries >= MAX_TRIES ? 'failed' : 'queued',
            message,
            next.id,
          );
          if (failStreak >= STOP_AFTER) {
            const reason = `${STOP_AFTER} pictures failed in a row. The last error: ${message}`;
            deps.settings.set(PAUSE_KEY, reason);
            log.error(`Picture making paused: ${reason}`);
            await deps.notify?.(`<b>New website: picture making paused</b>\n${reason}\nCheck the image service, then press Resume on the Images page.`).catch(() => {});
          }
        } finally {
          lastPictureAt = now();
        }
      }
    })
    .finally(() => {
      running = null;
    });
  return running;
}
