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
 * - the same call, generate(prompt, shape): every article picture 3:4
 *   portrait (PORTRAIT_3_4), which the websites' home page and post cards
 *   show without cutting the dish off (a wide 16:9 picture lost its sides
 *   there); a Pinterest pin 3:4 too;
 * - the same pause between images (image_gap_seconds), counted from when the
 *   previous image came back;
 * - one image at a time, and a failed image stops its article there, like a
 *   failed step stops an old run. Pressing Make again carries on from it.
 * Nothing is sent until someone presses "Make pictures". Each picture is
 * downloaded the moment it is made and kept in the platform's data folder.
 *
 * A recipe has a picture per step, often 15 or more: too many to ask Flow
 * for at once. So pictures come in two lanes. "Make pictures" makes the main
 * ones (feature, top-down, close-up and the like). The step pictures go to a
 * slow queue: one at a time, with a random 15 to 30 minutes between them,
 * across every article. An article's steps join that queue once it is posted
 * (publish.ts), and each is added to the post's recipe card as it is made.
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
  /** The picture's id in the website's media library, once uploaded. */
  media_id: number | null;
  /** A social picture's shape, from its platform's rules file; empty means by slot. */
  shape: string;
}

/** A recipe step's picture: made in the slow queue. */
export const isStepSlot = (slot: string): boolean => slot.startsWith('step-');

/**
 * A social picture, made in the sharing phase after publishing: a Pinterest
 * pin (slot "pin-<social post id>") or a Facebook post picture ("fb-<id>"),
 * both 3:4. It goes through the same queue, one at a time with the same gap,
 * but it is not one of the article's pictures: its prompt is its own.
 */
export const isPinSlot = (slot: string): boolean => /^(pin|fb|social)-/.test(slot);

/** One of the article's main pictures (not a step, not a pin). */
export const isMainSlot = (slot: string): boolean => !isStepSlot(slot) && !isPinSlot(slot);

/** The shape Flow is asked for. */
export type PictureShape = 'HORIZONTAL' | 'PORTRAIT_3_4';
// every picture of an article, its steps included, is 3:4 portrait; a social picture's own rules file can say otherwise (its row's shape)
export const shapeOf = (_slot: string): PictureShape => 'PORTRAIT_3_4';

/** Minutes between two step pictures: a random wait in this range. */
export const STEP_GAP_MINUTES = [15, 30] as const;
/** When the next step picture may be made (ms since 1970), kept across restarts. */
export const NEXT_STEP_KEY = 'newsite_next_step_picture_at';

/** Where one keyword's pictures are kept. */
export const pictureDir = (seoId: number, dataDir = resolveDataDir()): string =>
  join(dataDir, 'newsite-pictures', String(seoId));

export const listPictures = (seoId: number): PictureRow[] =>
  all<PictureRow>('SELECT * FROM newsite_pictures WHERE seo_id = ? ORDER BY position', seoId);

/** A plan's social pictures (pins and Facebook post pictures), for the Share step. */
export const listPlanSocialPictures = (planId: number): PictureRow[] =>
  all<PictureRow>(
    `SELECT p.* FROM newsite_pictures p JOIN keyword_seo s ON s.id = p.seo_id WHERE s.plan_id = ? AND (p.slot LIKE 'pin-%' OR p.slot LIKE 'fb-%' OR p.slot LIKE 'social-%') ORDER BY p.id`,
    planId,
  );

export const listPlanPictures = (planId: number): PictureRow[] =>
  all<PictureRow>(
    `SELECT p.* FROM newsite_pictures p JOIN keyword_seo s ON s.id = p.seo_id WHERE s.plan_id = ? AND p.slot NOT LIKE 'pin-%' AND p.slot NOT LIKE 'fb-%' AND p.slot NOT LIKE 'social-%' ORDER BY s.position, p.position`,
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
 * Put one keyword's main pictures in the queue. A picture already made from
 * the same prompt is kept; a failed one gets fresh tries; one whose prompt was
 * rewritten since is made again. Returns how many were queued.
 */
export const queuePictures = (seoId: number, dataDir = resolveDataDir()): number =>
  queueLane(seoId, isMainSlot, dataDir);

/** Put one keyword's step pictures in the slow queue. Returns how many were queued. */
export function queueStepPictures(seoId: number, settings: Settings, now = Date.now(), random = Math.random, dataDir = resolveDataDir()): number {
  const queued = queueLane(seoId, isStepSlot, dataDir);
  // The first one waits too: the slow queue never starts with a burst.
  if (queued && Number(settings.get(NEXT_STEP_KEY) || 0) < now) settings.set(NEXT_STEP_KEY, String(now + stepGapMs(random)));
  return queued;
}

const stepGapMs = (random: () => number): number => {
  const [min, max] = STEP_GAP_MINUTES;
  return Math.round((min + random() * (max - min)) * 60_000);
};

function queueLane(seoId: number, inLane: (slot: string) => boolean, dataDir: string): number {
  const prompts = currentPrompts(seoId).filter((p) => inLane(p.slot));
  if (!prompts.length) return 0;
  const have = new Map(listPictures(seoId).filter((p) => inLane(p.slot)).map((p) => [p.slot, p]));
  const wanted = new Set(prompts.map((p) => p.slot));
  const order = new Map(currentPrompts(seoId).map((p, i) => [p.slot, i]));
  // Slots the prompts no longer have.
  for (const old of have.values()) {
    if (wanted.has(old.slot)) continue;
    if (old.file) rmSync(join(pictureDir(seoId, dataDir), old.file), { force: true });
    run('DELETE FROM newsite_pictures WHERE id = ?', old.id);
  }
  let queued = 0;
  prompts.forEach((p) => {
    const position = order.get(p.slot) ?? 0;
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

/**
 * Put failed article pictures back in the queue: one picture, one keyword's, or a whole plan's.
 * Social post pictures are left out: their posts remake them. Step pictures go back in the slow queue.
 */
export function retryFailedPictures(where: { pictureId?: number; seoId?: number; planId?: number }): number {
  const [filter, value] = where.pictureId
    ? ['id = ?', where.pictureId]
    : where.seoId
      ? ['seo_id = ?', where.seoId]
      : ['seo_id IN (SELECT id FROM keyword_seo WHERE plan_id = ?)', where.planId ?? 0];
  const failed = all<PictureRow>(`SELECT * FROM newsite_pictures WHERE status = 'failed' AND ${filter}`, value);
  const prompts = new Map<number, Map<string, string>>();
  const promptOf = (seoId: number, slot: string) => {
    if (!prompts.has(seoId)) prompts.set(seoId, new Map(currentPrompts(seoId).map((p) => [p.slot, p.prompt])));
    return prompts.get(seoId)!.get(slot);
  };
  // Only article pictures made from the prompt as it is now: an old prompt is remade by Make pictures.
  const again = failed.filter((p) => promptOf(p.seo_id, p.slot) === p.prompt);
  for (const p of again) run(`UPDATE newsite_pictures SET status = 'queued', attempts = 0, error = '' WHERE id = ?`, p.id);
  return again.length;
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
  random?: () => number;
  /** Wakes the maker when the next step picture is due. Tests pass their own. */
  wakeIn?: (ms: number, wake: () => void) => void;
  /** Called with each step picture once it is made: publishing adds it to the post. */
  afterStep?: (pictureId: number) => Promise<void>;
  /** Called when all of an article's main pictures are made: it may be published now. */
  afterMain?: (seoId: number) => Promise<void>;
  /** Called when a pin's picture is made (ok) or failed: its social post carries on. */
  afterPin?: (pictureId: number, ok: boolean) => Promise<void>;
}

let running: Promise<void> | null = null;
let lastImageGeneratedAt: number | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

/** For tests: forget the gap and any pending wake-up between cases. */
export function resetPictureMakerState(): void {
  lastImageGeneratedAt = null;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
}

const defaultWake = (ms: number, wake: () => void): void => {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wake();
  }, ms);
  wakeTimer.unref?.();
};

/** The Flow project a website's pictures go into: the old dashboard's own rule. */
export const flowProjectFor = (siteProjectId: string, domain: string, settings: Settings): ResolvedProjectId =>
  resolveProjectId(siteProjectId, settings.get('flow_project_id'), domain);

export { describeProjectId };

/** The old dashboard's image client (PipelineContext), built from the same settings. */
const oldDashboardMaker = (settings: Settings) => (prompt: string, projectId: string, shape: PictureShape) =>
  new ImageClient({
    baseUrl: settings.get('image_base_url'),
    apiKey: settings.get('image_api_key'),
    pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
    maxAttempts: settings.getNumber('image_poll_max_attempts'),
    projectId,
    imageModel: settings.get('image_model'),
  })
    .generate(prompt, shape)
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
  const random = deps.random ?? Math.random;
  const wakeIn = deps.wakeIn ?? defaultWake;

  const pick = (stepLane: boolean) =>
    get<PictureRow & { domain: string; project_id: string }>(
      `SELECT p.*, w.domain, w.project_id FROM newsite_pictures p
         JOIN keyword_seo s ON s.id = p.seo_id
         JOIN keyword_plans k ON k.id = s.plan_id
         JOIN new_websites w ON w.id = k.website_id
        WHERE p.status = 'queued' AND (p.slot LIKE 'step-%') = ? ORDER BY p.id LIMIT 1`,
      stepLane ? 1 : 0,
    );

  running = Promise.resolve()
    .then(async () => {
      for (;;) {
        // Main pictures first; a step picture only when the slow queue says so.
        let next = pick(false);
        if (!next) {
          next = pick(true);
          if (!next) break;
          const due = Number(deps.settings.get(NEXT_STEP_KEY) || 0);
          if (now() < due) {
            wakeIn(due - now(), () => void kickPictureMaker(deps));
            break;
          }
        }
        const step = isStepSlot(next.slot);
        const pin = isPinSlot(next.slot);

        // A prompt rewritten after it was queued is not sent: it is stale.
        // (A pin's prompt is its own, so it cannot go stale this way.)
        const current = pin ? null : currentPrompts(next.seo_id).find((p) => p.slot === next.slot);
        if (!pin && (!current || current.prompt !== next.prompt)) {
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
          const { data, contentType } = await make(next.prompt, project.projectId, (next.shape as PictureShape) || shapeOf(next.slot));
          lastImageGeneratedAt = now();
          const dir = pictureDir(next.seo_id, dataDir);
          mkdirSync(dir, { recursive: true });
          const file = `${next.slot}-${next.id}.${extension(contentType)}`;
          writeFileSync(join(dir, file), data);
          run(`UPDATE newsite_pictures SET status = 'done', error = '', file = ?, made_at = datetime('now') WHERE id = ?`, file, next.id);
          if (step) await deps.afterStep?.(next.id).catch((err) => log.warn(`After ${next.slot}: ${errorMessage(err)}`));
          else if (pin) void deps.afterPin?.(next.id, true).catch((err) => log.warn(`After ${next.slot}: ${errorMessage(err)}`));
          else if (listPictures(next.seo_id).filter((p) => isMainSlot(p.slot)).every((p) => p.status === 'done')) {
            void deps.afterMain?.(next.seo_id).catch((err) => log.warn(`After the main pictures: ${errorMessage(err)}`));
          }
        } catch (err) {
          const message = errorMessage(err).slice(0, 400);
          log.warn(`Picture "${next.slot}" (${next.id}) failed: ${message}`);
          run(`UPDATE newsite_pictures SET status = 'failed', error = ? WHERE id = ?`, message, next.id);
          // Like a failed step in an old run: this article's main pictures
          // stop here until Make pictures is pressed again. A failed step
          // picture only waits for its own retry; the slow queue goes on.
          if (pin) void deps.afterPin?.(next.id, false).catch((e) => log.warn(`After ${next.slot}: ${errorMessage(e)}`));
          else if (!step) {
            run(`DELETE FROM newsite_pictures WHERE seo_id = ? AND status = 'queued' AND slot NOT LIKE 'step-%' AND slot NOT LIKE 'pin-%' AND slot NOT LIKE 'fb-%' AND slot NOT LIKE 'social-%'`, next.seo_id);
          }
        } finally {
          if (step) deps.settings.set(NEXT_STEP_KEY, String(now() + stepGapMs(random)));
        }
      }
    })
    .finally(() => {
      running = null;
    });
  return running;
}
