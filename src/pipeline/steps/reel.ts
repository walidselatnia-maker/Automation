import type { Step } from '../engine.js';
import type { SeoData } from './content.js';
import type { ArticleImages } from './images.js';
import type { PostedRecipe } from '../../integrations/site-api.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { createReel, getReel, pageForNiche, presenterForPage, setReelStage, updateReel } from '../../db/repos.js';
import {
  buildReelPrompt,
  reelMode,
  referenceUrls,
  seedFromRun,
  singleReferenceRoles,
  withoutLinks,
} from '../../reels/compose.js';
import { startGeneration } from '../../reels/engine.js';

const log = createLogger('reel-step');

export interface CreateReelInput {
  seo: SeoData;
  posted: PostedRecipe;
  images: ArticleImages;
  title: string;
}

export interface CreateReelOutput {
  reelId: number | null;
  /** Why no reel was made. Not an error: the article is out either way. */
  skipped?: string;
  /** The reel exists but its video could not be queued; Retry on the reels page. */
  error?: string;
}

/**
 * Turn the article just published into a reel on the page for its niche.
 *
 * The one place that decides a run gets a reel, checkpointed like every other
 * step, so a resumed run does not make a second one. It never fails the run:
 * by now the article is live, and a run marked failed after publishing reads
 * as an article that did not go out. What can go wrong is recorded on the
 * reel instead, where the reels page has a Retry for it.
 *
 * From here the reel engine takes over: it writes the storyboard, films the
 * scenes, assembles them, and publishes with the page's own token, and the
 * link goes in as the first comment.
 */
export const createReelStep: Step<CreateReelInput, CreateReelOutput> = {
  name: 'create-reel',
  title: 'Make the Facebook reel',
  async run(ctx, input) {
    if (!ctx.settings.getBool('fb_enabled')) {
      return { reelId: null, skipped: 'Facebook reels are off' };
    }

    const page = pageForNiche(ctx.keyword.seed_keyword);
    if (!page) {
      const skipped = `no page has the niche "${ctx.keyword.seed_keyword}"`;
      log.info(`run ${ctx.runId}: no reel — ${skipped}`);
      return { reelId: null, skipped };
    }

    const title = input.title || input.seo.title;
    const host = ctx.site.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

    // Written by the model; the title when the model is not there. Never a
    // reason to stop: a plain caption on a reel beats no reel.
    let caption = title;
    try {
      const result = await ctx.prompt('reel-caption', {
        seo: { title },
        spy: {
          group: ctx.keyword.seed_keyword,
          description: ctx.keyword.spy_description,
          annotation: ctx.keyword.annotation,
        },
      });
      caption = withoutLinks(result.content) || title;
    } catch (err) {
      log.warn(`run ${ctx.runId}: reel caption not written, using the title: ${errorMessage(err)}`);
    }

    // Setup -> Reels: one clip from one prompt, or a storyboard of scenes.
    if (reelMode(ctx.settings) === 'single') {
      const presenter = presenterForPage(page.id);
      const reelId = createReel({
        runId: ctx.runId,
        siteId: ctx.site.id,
        keywordId: ctx.keyword.id,
        fbPageId: page.id,
        prompt: buildReelPrompt({
          title,
          presenter: presenter ? { name: presenter.name, voice: presenter.voice_description } : null,
          cta: ctx.settings.get('reel_cta_text'),
        }),
        caption,
        references: referenceUrls(host, input.images, singleReferenceRoles(ctx.settings)),
      });

      try {
        await startGeneration(getReel(reelId)!, ctx.settings, ctx.images);
      } catch (err) {
        const error = errorMessage(err);
        updateReel(reelId, { status: 'failed', error });
        log.warn(`run ${ctx.runId}: reel ${reelId} could not start: ${error}`);
        return { reelId, error };
      }
      log.info(`run ${ctx.runId}: reel ${reelId} queued as one clip for ${page.name || page.page_id}`);
      return { reelId };
    }

    const reelId = createReel({
      runId: ctx.runId,
      siteId: ctx.site.id,
      keywordId: ctx.keyword.id,
      fbPageId: page.id,
      prompt: '',
      caption,
      references: [],
      stage: 'planning',
    });
    setReelStage(reelId, 'planning', {
      planJson: JSON.stringify(seedFromRun(ctx.runId, host, input.images, title)),
    });

    log.info(`run ${ctx.runId}: reel ${reelId} queued for planning on ${page.name || page.page_id}`);
    return { reelId };
  },
};
