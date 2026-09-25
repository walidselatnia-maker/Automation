/**
 * One blog article, start to published.
 *
 * Runs in place of the recipe pipeline when the site says its content is
 * articles. Kept as its own function rather than a branch inside
 * executePipeline because only the ends are shared: both fetch the site's
 * categories at the start and both hand a published page to Pinterest at the
 * end, and everything between is a different document written a different way.
 *
 * Every step is checkpointed by the same runner, so a resume owes only what is
 * missing -- which matters most at the photographs, where an article costs
 * four to seven generations.
 */
import { runStep } from './engine.js';
import { fetchCategories } from './steps/content.js';
import { blogImageStep } from './steps/images.js';
import {
  articlePayload,
  assembleArticle,
  categoryIdFor,
  planArticle,
  writeArticle,
  type ArticlePlan,
} from './steps/blog.js';
import { createLogger } from '../lib/logger.js';
import type { PipelineContext } from './context.js';
import type { Step } from './engine.js';
import type { PostedArticle } from '../integrations/site-api.js';

const log = createLogger('blog');

/** Publishing is its own step so a rejected POST is resumable on its own. */
function publishStep(
  plan: ArticlePlan,
  assembled: { content: string; featuredImage: string; featuredImageAlt: string },
  categoryId: string | undefined,
): Step<void, PostedArticle> {
  return {
    name: 'post-blog-article',
    title: 'Publish the article',
    async run(ctx) {
      const payload = articlePayload(plan, assembled, { categoryId });
      const posted = await ctx.siteApi.postArticle(payload);
      return posted;
    },
  };
}

export interface BlogOutcome {
  title: string;
  slug: string;
  postUrl: string;
  featuredImage: string;
  excerpt: string;
}

/**
 * Plan, write, photograph, assemble, publish.
 *
 * The photographs come after the prose on purpose: the writer marks where each
 * belongs with [IMAGE_n] and never sees a url, because the urls do not exist
 * until the files are uploaded, and a model asked to paste them back into
 * prose gets one wrong eventually and does it silently.
 */
export async function runBlogArticle(ctx: PipelineContext): Promise<BlogOutcome> {
  const host = ctx.site.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  const categories = await runStep(ctx, fetchCategories, undefined);
  const plan = await runStep(ctx, planArticle, categories);
  const written = await runStep(ctx, writeArticle, plan);

  log.info(
    `run ${ctx.runId}: "${plan.title}" — ${plan.sections.length} sections, ` +
      `${plan.images.length} photographs`,
  );

  // One step per photograph, named by its position, so a failure at the fifth
  // leaves the first four alone on a resume.
  const uploaded: { url: string; alt: string }[] = [];
  for (const [index, image] of plan.images.entries()) {
    const step = blogImageStep(index, plan.images.length);
    const result = await runStep(ctx, step, image.brief);
    uploaded.push({ url: result.path, alt: image.alt || plan.title });
  }

  const assembled = assembleArticle(written.html, plan, uploaded);
  const posted = await runStep(
    ctx,
    publishStep(plan, assembled, categoryIdFor(categories, plan.category)),
    undefined,
  );

  const slug = String(posted.slug ?? plan.slug);
  return {
    title: plan.title,
    slug,
    postUrl: `https://${host}/${slug}`,
    featuredImage: assembled.featuredImage
      ? ctx.siteApi.absoluteUrl(assembled.featuredImage)
      : '',
    excerpt: plan.excerpt,
  };
}
