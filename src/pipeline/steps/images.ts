import { randomUUID } from 'node:crypto';
import type { Step } from '../engine.js';
import { createLogger } from '../../lib/logger.js';
import type { ImagePromptSet } from './content.js';
import { loadTemplate } from '../prompts.js';
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
interface Uploaded {
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

/** Generate one image and upload it to the site. */
async function generateAndUpload(
  ctx: import('../context.js').PipelineContext,
  prompt: string,
  label: string,
): Promise<Uploaded> {
  log.debug(`generating "${label}"`);

  const { data, contentType, jobId } = await ctx.images.generate(prompt, 'VERTICAL');
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

/**
 * The four article images.
 *
 * Generated sequentially rather than in parallel: the image service is shared
 * across all sites and a burst of four is the kind of load that produces the
 * rate-limit failures this system exists to avoid. Sequential is slower and
 * far more predictable.
 *
 * When this keyword's link to this site has sharing on, the first site to run
 * records the four public URLs and every later site copies them rather than
 * generating again — four generations per keyword instead of four per site.
 * A cached URL that will not download is treated as no cache at all: the row
 * is dropped and the images are generated, because a stale link must never be
 * able to fail a run.
 *
 * The Pinterest graphic is deliberately not part of this. It is the asset that
 * has to stay unique per site, so `generatePinImage` always generates.
 */
export const generateArticleImages: Step<ImagePromptSet, ArticleImages> = {
  name: 'generate-images',
  title: 'Generate and upload article images',
  async run(ctx, prompts) {
    const cached = ctx.shareImages ? ctx.sharedImages.get(ctx.keyword.id) : undefined;

    if (cached) {
      try {
        const feature = await copyFromUrl(ctx, cached.feature, 'feature');
        const topShot = await copyFromUrl(ctx, cached.topShot, 'top shot');
        const textureMacro = await copyFromUrl(ctx, cached.textureMacro, 'texture macro');
        const beforeAfter = await copyFromUrl(ctx, cached.beforeAfter, 'before/after');

        log.info(`reused the shared images for "${ctx.keyword.seed_keyword}"`);
        return {
          feature: feature.path,
          topShot: topShot.path,
          textureMacro: textureMacro.path,
          beforeAfter: beforeAfter.path,
        };
      } catch (err) {
        log.warn(
          `shared images for keyword ${ctx.keyword.id} could not be copied ` +
            `(${err instanceof Error ? err.message : String(err)}); generating fresh ones`,
        );
        ctx.sharedImages.clear(ctx.keyword.id);
      }
    }

    const feature = await generateAndUpload(ctx, prompts.feature, 'feature');
    const topShot = await generateAndUpload(ctx, prompts.topShot, 'top shot');
    const textureMacro = await generateAndUpload(ctx, prompts.textureMacro, 'texture macro');
    const beforeAfter = await generateAndUpload(ctx, prompts.beforeAfter, 'before/after');

    if (ctx.shareImages) {
      ctx.sharedImages.save(ctx.keyword.id, ctx.site.id, {
        feature: feature.absolute,
        topShot: topShot.absolute,
        textureMacro: textureMacro.absolute,
        beforeAfter: beforeAfter.absolute,
      });
    }

    return {
      feature: feature.path,
      topShot: topShot.path,
      textureMacro: textureMacro.path,
      beforeAfter: beforeAfter.path,
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
