import { FacebookClient, FacebookError } from '../integrations/facebook.js';
import { ImageClient } from '../integrations/images.js';
import { TelegramClient } from '../integrations/telegram.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { resolveProjectId } from '../core/project-id.js';
import type { Settings } from '../settings.js';
import {
  activeReels,
  fbPageToken,
  getFbPage,
  getSite,
  markFbPageFailed,
  markFbPageUsed,
  updateReel,
  type ReelView,
} from '../db/repos.js';

const log = createLogger('reels');

/**
 * Moving a reel from "asked for" to "on Facebook".
 *
 * Deliberately not a pipeline. The article pipeline checkpoints every step
 * because a failure at step twelve would otherwise repay thirteen LLM calls;
 * a reel has three states and one expensive artefact, and the video URL in the
 * row is a better checkpoint than a step table would be.
 *
 * Nothing here blocks. Video generation takes minutes and publishing takes
 * more, and the scheduler tick that drives this also drives article runs — so
 * each pass advances what it can and returns.
 *
 *   draft -> generating -> ready -> publishing -> published
 *                       \-> failed <-/
 */

export interface ReelTickResult {
  advanced: number;
  failed: number;
}

/** Everything the engine is allowed to reach, so it can be tested with fakes. */
export interface ReelDeps {
  images: ImageClient;
  /**
   * A client for the token this page was found under. Pages from different
   * apps sit side by side, and each publishes with its own token.
   */
  facebookFor(pageRowId: number): Pick<FacebookClient, 'publishReel' | 'commentOnReel'>;
  telegram: TelegramClient;
  /** Download a finished video. Separate so tests need no network. */
  download(url: string): Promise<Buffer>;
}

export function defaultDeps(settings: Settings, key: Buffer): ReelDeps {
  return {
    images: new ImageClient({
      baseUrl: settings.get('image_base_url'),
      apiKey: settings.get('image_api_key'),
      pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
      maxAttempts: settings.getNumber('image_poll_max_attempts'),
    }),
    facebookFor: (pageRowId) =>
      new FacebookClient({ systemUserToken: fbPageToken(pageRowId, key) }),
    telegram: new TelegramClient(
      settings.get('telegram_bot_token'),
      settings.get('telegram_chat_id'),
    ),
    async download(url) {
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok) {
        throw new Error(`Downloading the video failed: HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

/**
 * Advance every reel that has somewhere to go.
 *
 * One reel per state per tick, on purpose: publishing uploads a video and
 * generating waits on Google, and doing several at once is how a shared image
 * service earns a rate limit.
 */
export async function tickReels(
  settings: Settings,
  deps: ReelDeps,
): Promise<ReelTickResult> {
  if (!settings.getBool('fb_enabled')) return { advanced: 0, failed: 0 };

  const result: ReelTickResult = { advanced: 0, failed: 0 };

  for (const reel of activeReels()) {
    try {
      const moved = await advance(reel, settings, deps);
      if (moved) result.advanced += 1;
    } catch (err) {
      const message = errorMessage(err);
      log.error(`reel ${reel.id} failed`, message);
      updateReel(reel.id, { status: 'failed', error: message });
      result.failed += 1;

      if (reel.fb_page_id) markFbPageFailed(reel.fb_page_id, message);
      await notify(deps, `<b>Reel failed</b>\n${escapeHtml(reel.run_title ?? '')}\n${message}`);
    }
  }

  return result;
}

async function advance(
  reel: ReelView,
  settings: Settings,
  deps: ReelDeps,
): Promise<boolean> {
  switch (reel.status) {
    case 'generating':
      return pollGeneration(reel, deps);
    case 'ready':
      return publishIfAllowed(reel, settings, deps);
    case 'publishing':
      // Left behind by a process that died mid-upload. Retried rather than
      // resumed: Facebook's upload session is gone with the process, and the
      // video we already have is the expensive part, not the upload.
      log.warn(`reel ${reel.id} was left publishing; retrying`);
      updateReel(reel.id, { status: 'ready' });
      return true;
    default:
      return false;
  }
}

/** Ask the image service whether the video is done yet. */
async function pollGeneration(reel: ReelView, deps: ReelDeps): Promise<boolean> {
  if (!reel.job_id) {
    throw new Error('This reel is generating but has no job id to poll.');
  }

  const job = await deps.images.poll(reel.job_id);
  const status = (job.status ?? '').toUpperCase();

  if (status === 'COMPLETED') {
    const url = job.image_url;
    if (!url) throw new Error('The video job completed but returned no URL.');

    updateReel(reel.id, { status: 'ready', videoUrl: url, error: null });
    log.info(`reel ${reel.id}: video ready`);
    return true;
  }

  if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status)) {
    throw new Error(`Video generation failed: ${job.error ?? 'no detail given'}`);
  }

  // Still working. Not an advance, and not worth a log line every tick.
  return false;
}

/**
 * Publish, if this reel's page says it may.
 *
 * The gate is per page rather than per site: a niche page that has earned
 * trust can publish unattended while a newer one still waits to be read. A
 * reel with no page waits indefinitely, which is the intended behaviour —
 * guessing a page posts a recipe to the wrong audience.
 */
async function publishIfAllowed(
  reel: ReelView,
  settings: Settings,
  deps: ReelDeps,
): Promise<boolean> {
  if (!reel.fb_page_id) return false;

  const page = getFbPage(reel.fb_page_id);
  if (!page || page.enabled !== 1) return false;
  if (page.auto_publish !== 1) return false;

  await publishReel(reel, deps);
  return true;
}

/**
 * Publish one reel now, regardless of the page's auto-publish setting.
 *
 * Shared by the scheduler and the Publish button, so a reel released by hand
 * goes out the same way an automatic one does.
 */
export async function publishReel(reel: ReelView, deps: ReelDeps): Promise<void> {
  if (!reel.fb_page_id) throw new Error('This reel has no Facebook page to publish to.');
  if (!reel.video_url) throw new Error('This reel has no video to publish.');

  const page = getFbPage(reel.fb_page_id);
  if (!page) throw new Error('The Facebook page for this reel no longer exists.');

  updateReel(reel.id, { status: 'publishing', error: null });

  const facebook = deps.facebookFor(page.id);
  const video = await deps.download(reel.video_url);

  const published = await facebook.publishReel({
    pageId: page.page_id,
    video,
    description: reel.caption,
  });

  updateReel(reel.id, {
    status: 'published',
    fbVideoId: published.videoId,
    error: null,
  });
  markFbPageUsed(page.id);

  log.info(`reel ${reel.id} published to ${page.name || page.page_id}: ${published.permalink}`);

  // The article link goes in the first comment, and only there. Recorded as
  // published before this runs, on purpose: the reel is live on the page
  // whether or not the comment lands, and a failure here must read as "the
  // link is missing" -- something a person can fix in ten seconds -- rather
  // than as a failed publish that the scheduler then tries to post again.
  let linkNote = '';
  if (reel.post_url) {
    try {
      await facebook.commentOnReel({
        pageId: page.page_id,
        videoId: published.videoId,
        message: reel.post_url,
      });
      log.info(`reel ${reel.id}: article link posted as the first comment`);
    } catch (err) {
      const why = errorMessage(err);
      log.warn(`reel ${reel.id}: published, but the link comment failed: ${why}`);
      linkNote =
        `\n\n<b>The link comment did not post.</b> Add it by hand:\n${escapeHtml(reel.post_url)}\n` +
        `<i>${escapeHtml(why)}</i>`;
    }
  }

  await notify(
    deps,
    `<b>Reel published</b>\n${escapeHtml(reel.run_title ?? '')}\n\n` +
      `Page: ${escapeHtml(page.name || page.page_id)}\n${published.permalink}${linkNote}`,
  );
}

/**
 * Queue the video for a draft reel.
 *
 * The Flow project comes from the site, exactly as it does for article images,
 * so a reel generates into the same project as the images it is built from.
 */
export async function startGeneration(
  reel: ReelView,
  settings: Settings,
  images: Pick<ImageClient, 'submitVideo'>,
): Promise<void> {
  const references = JSON.parse(reel.reference_json) as string[];
  if (references.length === 0) {
    throw new Error('A reel needs at least one reference image.');
  }

  const site = reel.site_id ? getSite(reel.site_id) : undefined;
  const project = resolveProjectId(
    site?.project_id ?? '',
    settings.get('flow_project_id'),
    site?.domain ?? '',
  );

  const jobId = await images.submitVideo({
    prompt: reel.prompt,
    referenceUrls: references,
    projectId: project.projectId,
  });

  updateReel(reel.id, { status: 'generating', jobId, error: null });
  log.info(`reel ${reel.id}: queued video job ${jobId} from ${references.length} image(s)`);
}

/** Never throws: a published reel whose notification failed is still published. */
async function notify(deps: ReelDeps, message: string): Promise<void> {
  try {
    await deps.telegram.sendMessage(message);
  } catch (err) {
    log.warn(`could not send a reel notification: ${errorMessage(err)}`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { FacebookError };
