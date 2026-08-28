import { runStep, StepFailedError } from './engine.js';
import { PipelineContext } from './context.js';
import {
  fetchCategories,
  generateImagePrompts,
  generateRecipe,
  SpyRejectedError,
  validateSpy,
} from './steps/content.js';
import { generateArticleImages, generatePinImage } from './steps/images.js';
import { generateArticle, postArticle } from './steps/article.js';
import {
  generatePinDescription,
  notify,
  publishToBuffer,
  resolveBufferTarget,
} from './steps/publish.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import {
  markRunFailed,
  markRunHeld,
  markRunPublished,
  publishedTitles,
  setKeywordStatus,
  setLink,
  setRunTitle,
  getLinksForKeyword,
} from '../db/repos.js';
import { findDuplicate } from '../core/similar-title.js';

const log = createLogger('pipeline');

/** Ordered list of steps, for display in the UI before a run starts. */
export const PIPELINE_STEPS = [
  fetchCategories,
  validateSpy,
  generateRecipe,
  generateImagePrompts,
  generateArticleImages,
  generateArticle,
  postArticle,
  generatePinImage,
  generatePinDescription,
  resolveBufferTarget,
  publishToBuffer,
  notify,
].map((s) => ({ name: s.name, title: s.title }));

export interface PipelineOutcome {
  status: 'published' | 'failed' | 'spy-rejected' | 'held';
  postId?: string;
  postUrl?: string;
  error?: string;
  failedStep?: string;
  /** Why it stopped short of publishing, when it did. */
  hold?: 'awaiting' | 'dry';
}

/**
 * The article's own title, however the model chose to name the field.
 *
 * Used for the near-duplicate check and to give a held run something readable
 * to be listed under. A missing title is not worth failing a run over — the
 * assembled article is already checked for one in generate-article.
 */
function articleTitle(article: Record<string, unknown>): string {
  const candidate = article.title ?? article.name ?? article.headline;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

/**
 * Execute the full generation and publishing pipeline for one run.
 *
 * Every step is checkpointed, so calling this again with the same runId
 * resumes rather than restarting.
 */
export async function executePipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
  const host = ctx.site.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  try {
    const categories = await runStep(ctx, fetchCategories, undefined);
    const seo = await runStep(ctx, validateSpy, categories);
    const recipe = await runStep(ctx, generateRecipe, seo);
    const imagePrompts = await runStep(ctx, generateImagePrompts, { seo, recipe });
    const images = await runStep(ctx, generateArticleImages, imagePrompts);

    const article = await runStep(ctx, generateArticle, { seo, recipe, images });
    const title = articleTitle(article);

    // Recorded before publishing, so a run held for approval is listed under
    // its title and a run that fails at the post still says what it wrote.
    if (title) setRunTitle(ctx.runId, title);

    warnOnNearDuplicate(ctx, title);

    // -- The gate before anything reaches a live site. ---------------------
    const hold = holdReason(ctx);
    if (hold) {
      markRunHeld(ctx.runId, hold, title);
      log.info(
        `run ${ctx.runId}: stopping before publish (${hold}) — ` +
          'resume it to publish, every completed step is reused',
      );
      return { status: 'held', hold, postUrl: undefined };
    }

    const posted = await runStep(ctx, postArticle, article);

    // -- Published. Everything after this point is distribution. -----------
    const postUrl = `https://${host}${String(posted.href ?? '')}`;
    markRunPublished(ctx.runId, String(posted.id), postUrl, title);
    markPairDone(ctx);

    const pinImage = await runStep(ctx, generatePinImage, { seo, prompts: imagePrompts });
    const pin = { seo, posted, pinImageUrl: pinImage.url, cta: pinImage.cta };

    // The Pinterest block is skipped wholesale when Buffer is off. Resolving
    // a channel and board calls the Buffer API, so checking the flag only at
    // the final publish step would still hit a service the operator disabled.
    if (ctx.settings.getBool('buffer_enabled')) {
      const description = await runStep(ctx, generatePinDescription, pin);
      const target = await runStep(ctx, resolveBufferTarget, seo);
      await runStep(ctx, publishToBuffer, { pin, description, target });
    } else {
      log.info(`run ${ctx.runId}: Buffer disabled, skipping Pinterest distribution`);
    }

    await runStep(ctx, notify, { seo, posted, pinImageUrl: pinImage.url });

    log.info(`run ${ctx.runId}: complete — ${postUrl}`);
    return { status: 'published', postId: String(posted.id), postUrl };
  } catch (err) {
    const cause = err instanceof StepFailedError ? err.cause : err;
    const failedStep = err instanceof StepFailedError ? err.step : 'unknown';

    // A rejected spy source is a data verdict, not a system failure. Mark the
    // keyword unusable so the selector stops offering it, and end cleanly.
    if (cause instanceof SpyRejectedError) {
      log.info(`run ${ctx.runId}: spy source rejected, marking keyword 'no'`);
      setKeywordStatus(ctx.keyword.id, 'no');
      markRunFailed(ctx.runId, `Spy source rejected: ${cause.detail}`, failedStep);
      return { status: 'spy-rejected', error: cause.detail, failedStep };
    }

    const message = errorMessage(cause);
    markRunFailed(ctx.runId, message, failedStep);
    log.error(`run ${ctx.runId}: failed at "${failedStep}"`, message);

    return { status: 'failed', error: message, failedStep };
  }
}

/**
 * Record that this keyword has now been used on this site, and close the
 * keyword globally once no site is still waiting for it.
 */
function markPairDone(ctx: PipelineContext): void {
  setLink(ctx.keyword.id, ctx.site.id, 'done');

  const remaining = getLinksForKeyword(ctx.keyword.id).filter((l) => l.status === 'go');
  if (remaining.length === 0) {
    setKeywordStatus(ctx.keyword.id, 'done');
    log.info(`keyword ${ctx.keyword.id} complete on every linked site`);
  }
}

export { PipelineContext };

/**
 * Whether this run stops before publishing, and why.
 *
 * Two different requests with one mechanism: a dry run was never going to
 * publish, and a site with auto-publish off wants a person to read the article
 * first. Both stop at the same place and both are released the same way — by
 * resuming the run, which reuses every completed step, so releasing an article
 * costs one HTTP post rather than a second pipeline.
 */
function holdReason(ctx: PipelineContext): 'awaiting' | 'dry' | null {
  // Approving is a resume, and the site's setting has not changed by then —
  // so without this the article is held again and approval publishes nothing.
  if (ctx.approved) return null;

  if (ctx.mode === 'dry') return 'dry';
  if (ctx.site.auto_publish === 0) return 'awaiting';
  return null;
}

/**
 * Say so when this site already has an article with almost this title.
 *
 * A warning, never a failure. The article exists and the images are paid for
 * by the time this runs, so throwing it away over a similarity score would
 * cost more than the duplicate does — and the score is a heuristic, which is
 * not something that should be able to bin finished work on its own.
 *
 * It goes into the run's step log and, on a held run, onto the page where the
 * article is read before release.
 */
function warnOnNearDuplicate(ctx: PipelineContext, title: string): void {
  if (!title) return;

  try {
    const match = findDuplicate(title, publishedTitles(ctx.site.id));
    if (!match) return;

    log.warn(
      `run ${ctx.runId}: "${title}" looks like "${match.title}" already on ` +
        `${ctx.site.domain} (${Math.round(match.similarity * 100)}% overlap)` +
        (match.url ? ` — ${match.url}` : ''),
    );
  } catch (err) {
    // A duplicate check must never be the reason a finished article is lost.
    log.warn(`could not check for a duplicate title: ${errorMessage(err)}`);
  }
}
