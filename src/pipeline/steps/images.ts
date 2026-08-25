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

/** Generate one image and upload it to the site, returning the site-relative URL. */
async function generateAndUpload(
  ctx: import('../context.js').PipelineContext,
  prompt: string,
  label: string,
): Promise<string> {
  log.debug(`generating "${label}"`);

  const { data, contentType, jobId } = await ctx.images.generate(prompt, 'VERTICAL');
  const extension = contentType.includes('png') ? 'png' : contentType.includes('jpeg') ? 'jpg' : 'webp';
  const upload = await ctx.siteApi.uploadImage(
    data,
    `${randomUUID()}.${extension}`,
    contentType,
    'recipes',
  );

  log.debug(`"${label}" uploaded to ${upload.url} (job ${jobId})`);
  return upload.url;
}

/**
 * The four article images. Generated sequentially rather than in parallel:
 * the image service is shared across all sites and a burst of four is the
 * kind of load that produces the rate-limit failures this system exists to
 * avoid. Sequential is slower and far more predictable.
 */
export const generateArticleImages: Step<ImagePromptSet, ArticleImages> = {
  name: 'generate-images',
  title: 'Generate and upload article images',
  async run(ctx, prompts) {
    const feature = await generateAndUpload(ctx, prompts.feature, 'feature');
    const topShot = await generateAndUpload(ctx, prompts.topShot, 'top shot');
    const textureMacro = await generateAndUpload(ctx, prompts.textureMacro, 'texture macro');
    const beforeAfter = await generateAndUpload(ctx, prompts.beforeAfter, 'before/after');

    return { feature, topShot, textureMacro, beforeAfter };
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

    const url = await generateAndUpload(ctx, prompt, 'pinterest graphic');
    return { url, cta };
  },
};
