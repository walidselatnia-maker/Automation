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
  markRunPublished,
  setKeywordStatus,
  setLink,
  getLinksForKeyword,
} from '../db/repos.js';

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
  status: 'published' | 'failed' | 'spy-rejected';
  postId?: string;
  postUrl?: string;
  error?: string;
  failedStep?: string;
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
    const posted = await runStep(ctx, postArticle, article);

    // -- Published. Everything after this point is distribution. -----------
    const postUrl = `https://${host}${String(posted.href ?? '')}`;
    markRunPublished(ctx.runId, String(posted.id), postUrl);
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
