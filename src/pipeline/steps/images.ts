import { randomUUID } from 'node:crypto';
import type { Step } from '../engine.js';
import { createLogger } from '../../lib/logger.js';
import type { ImagePromptSet } from './content.js';
import { loadTemplate } from '../prompts.js';
import { describeProjectId } from '../../core/project-id.js';
import type { SeoData } from './content.js';

const log = createLogger('images-step');

/**
 * Image generation.
 *
 * The previous workflow implemented this as 28 nodes: four copies of
 * generate → poll → check → download → upload → capture-url. Here it is one
 * function called in a loop, which is the same behaviour with a quarter of
 * the surface area and no possibility of the copies drifting apart.
 */

export interface ArticleImages {
  feature: string;
  topShot: string;
  textureMacro: string;
  beforeAfter: string;
}

/** One uploaded image: the path the article uses, and the link other sites use. */
export interface Uploaded {
  path: string;
  absolute: string;
}

async function upload(
  ctx: import('../context.js').PipelineContext,
  data: Buffer,
  contentType: string,
): Promise<Uploaded> {
  const extension = contentType.includes('png') ? 'png' : contentType.includes('jpeg') ? 'jpg' : 'webp';
  const result = await ctx.siteApi.uploadImage(
    data,
    `${randomUUID()}.${extension}`,
    contentType,
    'recipes',
  );

  return { path: result.url, absolute: ctx.siteApi.absoluteUrl(result.url) };
}

/**
 * Let the image service breathe between generations.
 *
 * It reloads its browser tab before every job, and the next request arriving
 * while that page is still coming back is what showed up as runs failing at
 * the third or fourth image. The size of the gap is Settings -> Image
 * generation, because how long that browser needs depends on the machine it
 * is on. Only the remainder is waited: an article written in between already
 * spent the gap.
 */
async function waitOutImageGap(
  ctx: import('../context.js').PipelineContext,
  label: string,
): Promise<void> {
  if (ctx.lastImageGeneratedAt === null || ctx.imageGapMs <= 0) return;

  const remaining = ctx.imageGapMs - (ctx.now() - ctx.lastImageGeneratedAt);
  if (remaining <= 0) return;

  log.debug(`waiting ${Math.round(remaining / 1000)}s before "${label}"`);
  await ctx.pause(remaining);
}

/** Generate one image and upload it to the site. */
async function generateAndUpload(
  ctx: import('../context.js').PipelineContext,
  prompt: string,
  label: string,
): Promise<Uploaded> {
  // Reported here rather than once per step, because this is the only path
  // that reaches Google. Copying a shared image is a plain download and needs
  // no project at all, so warning about one there would be noise about a call
  // that never happens.
  const explanation = describeProjectId(ctx.projectId, ctx.site.domain);
  if (ctx.projectId.source === 'placeholder') log.warn(explanation);
  else log.debug(explanation);

  await waitOutImageGap(ctx, label);

  log.debug(`generating "${label}"`);

  const { data, contentType, jobId } = await ctx.images.generate(prompt, 'VERTICAL');
  ctx.lastImageGeneratedAt = ctx.now();

  // Counted only on this path. A copied image cost a download, not a slot in
  // Google's queue, and the number is here to answer "how many generations did
  // this article need" rather than "how many files moved".
  ctx.countImages(1);

  const uploaded = await upload(ctx, data, contentType);

  log.debug(`"${label}" uploaded to ${uploaded.path} (job ${jobId})`);
  return uploaded;
}

/** Copy an image another site already published into this site's library. */
async function copyFromUrl(
  ctx: import('../context.js').PipelineContext,
  sourceUrl: string,
  label: string,
): Promise<Uploaded> {
  log.debug(`copying "${label}" from ${sourceUrl}`);

  const { data, contentType } = await ctx.images.download(sourceUrl);
  return upload(ctx, data, contentType);
}

/** The four article images, in the order they are made. */
export const ARTICLE_IMAGE_SLOTS = ['feature', 'topShot', 'textureMacro', 'beforeAfter'] as const;
export type ArticleImageSlot = (typeof ARTICLE_IMAGE_SLOTS)[number];

const SLOT_LABELS: Record<ArticleImageSlot, { step: string; title: string; label: string }> = {
  feature: { step: 'generate-image-feature', title: 'Generate feature image', label: 'feature' },
  topShot: { step: 'generate-image-top-shot', title: 'Generate top shot', label: 'top shot' },
  textureMacro: {
    step: 'generate-image-texture-macro',
    title: 'Generate texture macro',
    label: 'texture macro',
  },
  beforeAfter: {
    step: 'generate-image-before-after',
    title: 'Generate before/after image',
    label: 'before/after',
  },
};

/** The four uploads, keyed by slot: what the image steps hand the collector. */
export type ArticleImageUploads = Record<ArticleImageSlot, Uploaded>;

/**
 * One article image as its own checkpoint.
 *
 * The four images used to be one step, and a step is the unit the engine
 * resumes at. So a failure at the third image threw the first two away: the
 * resume ran the step again from the top and asked Google for all four, and
 * nothing on the run page said which image it had been on. Now each image is
 * a step of its own -- the page shows which one is running, a failure names
 * it, and a resume generates only the ones that are missing.
 *
 * Generated sequentially rather than in parallel: the image service is shared
 * across all sites and a burst of four is the kind of load that produces the
 * rate-limit failures this system exists to avoid.
 *
 * When this keyword's link to this site has sharing on, the first site to run
 * records the four public URLs and every later site copies them rather than
 * generating again -- four generations per keyword instead of four per site.
 * A cached URL that will not download is treated as no cache at all: the row
 * is dropped and this image is generated, because a stale link must never be
 * able to fail a run. Only this image: the ones already copied are kept.
 */
function articleImageStep(slot: ArticleImageSlot): Step<string, Uploaded> {
  const { step, title, label } = SLOT_LABELS[slot];
  return {
    name: step,
    title,
    async run(ctx, prompt) {
      const cached = ctx.shareImages ? ctx.sharedImages.get(ctx.keyword.id) : undefined;

      if (cached) {
        try {
          return await copyFromUrl(ctx, cached[slot], label);
        } catch (err) {
          log.warn(
            `shared "${label}" for keyword ${ctx.keyword.id} could not be copied ` +
              `(${err instanceof Error ? err.message : String(err)}); generating it`,
          );
          ctx.sharedImages.clear(ctx.keyword.id);
        }
      }

      return generateAndUpload(ctx, prompt, label);
    },
  };
}

export const ARTICLE_IMAGE_STEPS: readonly (Step<string, Uploaded> & { slot: ArticleImageSlot })[] =
  ARTICLE_IMAGE_SLOTS.map((slot) => ({ ...articleImageStep(slot), slot }));

/**
 * Collect the four images into the shape the article uses, and record them
 * for the keyword's other sites.
 *
 * Recorded only when nothing is recorded yet: a run that copied the set has
 * nothing new to say, and a run that found a dead link dropped the row on the
 * way, so what it uploaded -- copied or generated -- becomes the set the next
 * site copies.
 *
 * The Pinterest graphic is deliberately not part of this. It is the asset that
 * has to stay unique per site, so `generatePinImage` always generates.
 */
export const generateArticleImages: Step<ArticleImageUploads, ArticleImages> = {
  name: 'generate-images',
  title: 'Collect article images',
  async run(ctx, uploads) {
    if (ctx.shareImages && !ctx.sharedImages.get(ctx.keyword.id)) {
      ctx.sharedImages.save(ctx.keyword.id, ctx.site.id, {
        feature: uploads.feature.absolute,
        topShot: uploads.topShot.absolute,
        textureMacro: uploads.textureMacro.absolute,
        beforeAfter: uploads.beforeAfter.absolute,
      });
    }

    return {
      feature: uploads.feature.path,
      topShot: uploads.topShot.path,
      textureMacro: uploads.textureMacro.path,
      beforeAfter: uploads.beforeAfter.path,
    };
  },
};

/** A random call to action, matching the original list verbatim. */
const CTAS = [
  'Must-Try Recipe!',
  "Don't Miss Out!",
  "Can't-Miss Dish!",
  'Must-Try Today!',
  'Make This Now!',
  'You Need This!',
  'Game-Changer Recipe!',
  'Secret Weapon Dish!',
  'Hidden Gem Alert!',
  'This Changes Everything!',
  'Worth the Hype!',
  'Cook This Tonight!',
  'Save This Recipe!',
  'Add to Your Menu!',
  'Make It This Weekend!',
  'Try It Tonight!',
  'Pure Comfort Food!',
  'Instant Pleaser!',
  'Guaranteed Hit!',
  'Total Game Day Win!',
  'Weeknight Savior!',
  'Just Perfect!',
  'Holiday Essential!',
  'A Recipe Must-Have!',
  'Spring Favorite!',
  'Pin This Now!',
  'Save for Later!',
  'Share the Love!',
  'Your Guests Will Thank You!',
  'Brag-Worthy Results!',
];

export const pickCta = (): string => CTAS[Math.floor(Math.random() * CTAS.length)]!;

/**
 * The Pinterest graphic: a composed 40/20/40 layout built from the same
 * template the original assembled in a Set node.
 */
export const generatePinImage: Step<
  { seo: SeoData; prompts: ImagePromptSet },
  { url: string; cta: string }
> = {
  name: 'generate-pin-image',
  title: 'Generate Pinterest graphic',
  async run(ctx, input) {
    const cta = pickCta();

    const prompt = loadTemplate('pin-graphic.template.txt', {
      seo: input.seo,
      cta,
      site: { domain: ctx.site.domain },
      imagePrompts: {
        feature: input.prompts.feature,
        textureMacro: input.prompts.textureMacro,
      },
    });

    // Never shared: this is the asset that has to be unique per site.
    const pin = await generateAndUpload(ctx, prompt, 'pinterest graphic');
    return { url: pin.path, cta };
  },
};
