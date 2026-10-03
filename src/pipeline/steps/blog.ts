/**
 * The article pipeline: plan, write, photograph, assemble, publish.
 *
 * A second kind of content beside recipes, and deliberately its own file. It
 * shares the image service, the uploader and the Pinterest tail, and almost
 * nothing else: a recipe is a structured document the site renders, and an
 * article is one long HTML string the site prints as-is.
 *
 * The order is forced by the API rather than chosen. Articles carry their
 * pictures inside the HTML, as <img src>, and those addresses do not exist
 * until the files are uploaded. So the writer never sees a url: it writes
 * [IMAGE_1] where a picture belongs, the pictures are made and uploaded
 * afterwards, and the markers are swapped for real tags last. The alternative
 * -- generating first and asking the model to paste long urls into prose --
 * fails the moment it mistypes one, and mistyping one is silent.
 */
import { createLogger, errorMessage } from '../../lib/logger.js';
import { requireFields } from '../json.js';
import { parseJsonOrRepair } from '../parse-with-repair.js';
import type { Category } from '../../integrations/site-api.js';
import type { Step } from '../engine.js';
import type { PipelineContext } from '../context.js';
import { checkAlt, checkDescription, checkFocusKeyword, checkSlug, checkTitle, rulesPrompt } from '../../seo/rules.js';
import { feedbackFor, refineOnce } from '../../seo/refine.js';

const log = createLogger('blog');

/** How many photographs an article may carry. The plan picks inside this. */
export const MIN_IMAGES = 4;
export const MAX_IMAGES = 7;

export interface ArticleSection {
  heading: string;
  covers: string;
}

export interface ArticleImageBrief {
  /** The heading it sits under, or 'top' for the one above the article. */
  after: string;
  alt: string;
  brief: string;
}

export interface ArticlePlan {
  title: string;
  slug: string;
  excerpt: string;
  metaTitle: string;
  metaDescription: string;
  focusKeyword: string;
  tags: string[];
  category: string;
  sections: ArticleSection[];
  images: ArticleImageBrief[];
}

/** A slug the site will accept: lowercase words, single dashes, nothing else. */
export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** The marker the writer leaves where a photograph belongs. */
export const marker = (index: number): string => `[IMAGE_${index + 1}]`;

/**
 * What is wrong with a plan's search text, each problem labelled with its
 * field so the model can be told exactly what to fix. Empty means it passes.
 */
export function planSeoProblems(plan: Record<string, unknown>, keyword: string): string[] {
  const supplied = String(plan.focusKeyword ?? '').trim();
  const focus = supplied || keyword;
  const label = (field: string, problems: string[]): string[] => problems.map((p) => `${field}: ${p}`);
  const images = Array.isArray(plan.images) ? plan.images : [];
  return [
    // Only a focus keyword the plan actually supplied is held to the 3-word rule.
    ...(supplied ? label('focusKeyword', checkFocusKeyword(focus)) : []),
    // Articles can be in any niche, so the recipe-site word policy does not apply.
    ...label('metaTitle', checkTitle(String(plan.metaTitle ?? ''), { keyword: focus, restricted: false })),
    ...label('metaDescription', checkDescription(String(plan.metaDescription ?? ''), { keyword: focus, restricted: false })),
    ...label('slug', checkSlug(String(plan.slug ?? ''), { keyword: focus })),
    ...images.flatMap((image, i) =>
      label(`images[${i}].alt`, checkAlt(String((image as { alt?: unknown })?.alt ?? ''))),
    ),
  ];
}

/**
 * Plan the article: what it says, how it is found, and what it shows.
 *
 * The category comes back as a title the model picked from the site's own
 * list, and is resolved to an id before publishing -- the articles API wants
 * the id, and a wrong one is the usual cause of its 500.
 */
export const planArticle: Step<Category[], ArticlePlan> = {
  name: 'plan-article',
  title: 'Plan the article',
  async run(ctx, categories) {
    const spy = ctx.keyword.spy_title.trim();
    const ask = (feedback: string) =>
      ctx.prompt('article-outline', {
        keyword: ctx.keyword.seed_keyword,
        niche: ctx.keyword.niche || 'general interest',
        // Optional on purpose: an article keyword is a topic, and unlike a
        // recipe it does not need a source page to be written from.
        spyNote: spy
          ? `It was found from a page titled "${spy}". Cover the same ground, better.`
          : '',
        categoryTitles: JSON.stringify(categories.map((c) => c.title)),
        seoRules: rulesPrompt(),
        seoFeedback: feedback,
      });

    const read = async (content: string): Promise<Record<string, unknown>> => {
      const plan = await parseJsonOrRepair<Record<string, unknown>>(ctx, content, 'Article plan', {
        requiredFields: ['title', 'sections', 'images'],
      });
      requireFields(plan, ['title', 'sections', 'images'], 'Article plan');
      return plan;
    };

    const result = await ask('');
    const firstPlan = await read(result.content);

    // Ask once more with the exact problems; keep the plan and log a warning if
    // it still breaks a rule, since the .slice() guards below are the last resort.
    const refined = await refineOnce(
      firstPlan,
      (p) => planSeoProblems(p, ctx.keyword.seed_keyword),
      async (problems) => {
        try {
          return await read((await ask(feedbackFor(problems))).content);
        } catch (err) {
          log.warn(`run ${ctx.runId}: second attempt at the article plan failed: ${errorMessage(err)}`);
          return null;
        }
      },
    );
    if (refined.problems.length) {
      log.warn(`run ${ctx.runId}: article plan SEO text still breaks rules: ${refined.problems.join(' ')}`);
    }
    const parsed = refined.value;

    const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
      .map((entry) => entry as ArticleSection)
      .filter((entry) => entry && typeof entry.heading === 'string' && entry.heading.trim());
    if (sections.length === 0) throw new Error('The plan has no sections.');

    // Clamped rather than trusted: the count drives how many generations this
    // article costs, and a model that answers "images": [] or lists twenty is
    // deciding the bill.
    const images = (Array.isArray(parsed.images) ? parsed.images : [])
      .map((entry) => entry as ArticleImageBrief)
      .filter((entry) => entry && typeof entry.brief === 'string' && entry.brief.trim())
      .slice(0, MAX_IMAGES);
    if (images.length < MIN_IMAGES) {
      throw new Error(
        `The plan asks for ${images.length} photographs; an article needs at least ${MIN_IMAGES}.`,
      );
    }

    const title = String(parsed.title).trim();

    return {
      value: {
        title,
        slug: toSlug(String(parsed.slug ?? '') || title),
        excerpt: String(parsed.excerpt ?? '').trim(),
        metaTitle: String(parsed.metaTitle ?? title).slice(0, 60),
        metaDescription: String(parsed.metaDescription ?? parsed.excerpt ?? '').slice(0, 160),
        focusKeyword: String(parsed.focusKeyword ?? ctx.keyword.seed_keyword).trim(),
        tags: (Array.isArray(parsed.tags) ? parsed.tags : []).map(String).filter(Boolean),
        category: String(parsed.category ?? '').trim(),
        sections,
        images,
      },
      endpoint: result.endpoint,
      model: result.model,
    };
  },
};

/**
 * Write the body, with a marker where each photograph goes.
 *
 * What comes back is checked for the two things that silently ruin the page:
 * an <h1>, which the site already prints, and a missing marker, which would
 * leave a generated picture with nowhere to appear. A marker the writer
 * invented is dropped instead — there is no image behind it.
 */
export const writeArticle: Step<ArticlePlan, { html: string; plan: ArticlePlan }> = {
  name: 'write-article',
  title: 'Write the article',
  async run(ctx, plan) {
    const markers = plan.images.map((_, index) => marker(index));

    const result = await ctx.prompt('article-write', {
      title: plan.title,
      niche: ctx.keyword.niche || 'general interest',
      focusKeyword: plan.focusKeyword,
      planJson: JSON.stringify({ sections: plan.sections, images: plan.images }, null, 2),
      markers: markers.join(', '),
      words: String(Math.max(1200, plan.sections.length * 220)),
    });

    let html = result.content.trim();
    // A fenced answer is common enough to be worth unwrapping rather than
    // failing over: the content is right, the wrapper is not.
    html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();

    if (!html) throw new Error('The writer returned nothing.');
    if (/<h1[\s>]/i.test(html)) {
      html = html.replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, '').trim();
      log.warn(`run ${ctx.runId}: the article carried an <h1>; removed it`);
    }

    // An invented marker points at no picture, so it is dropped rather than
    // left to print as literal text in the published article.
    html = html.replace(/\[IMAGE_(\d+)\]/g, (whole, n: string) =>
      Number(n) >= 1 && Number(n) <= plan.images.length ? whole : '',
    );

    const missing = markers.filter((m) => !html.includes(m));
    if (missing.length) {
      // Appended rather than failed: the prose is written and paid for, and a
      // picture at the end is worth more than losing the article.
      log.warn(`run ${ctx.runId}: the writer skipped ${missing.join(', ')}; appending them`);
      html += `\n${missing.join('\n')}`;
    }

    return { value: { html, plan }, endpoint: result.endpoint, model: result.model };
  },
};

/**
 * Put the uploaded pictures into the HTML, and say which one leads.
 *
 * Every marker becomes a figure with alt text; the first picture is also the
 * featured image, which is what the site shows in listings and what the pin
 * is built from.
 */
export function assembleArticle(
  html: string,
  plan: ArticlePlan,
  uploaded: { url: string; alt: string }[],
): { content: string; featuredImage: string; featuredImageAlt: string } {
  let content = html;

  uploaded.forEach((image, index) => {
    const tag = `<img src="${image.url}" alt="${escapeAttribute(image.alt)}">`;
    content = content.split(marker(index)).join(tag);
  });

  // Any marker left over had no picture behind it -- a generation that failed
  // after the prose was written. Removed, because the alternative is the text
  // "[IMAGE_5]" on a live page.
  content = content.replace(/\[IMAGE_\d+\]/g, '').trim();

  const first = uploaded[0];
  return {
    content,
    featuredImage: first?.url ?? '',
    // `||` and not `??`: a picture with empty alt text is the case this is
    // for, and an empty string is not nullish.
    featuredImageAlt: first?.alt || plan.title,
  };
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The body the articles API takes, built from the plan and the assembled HTML. */
export function articlePayload(
  plan: ArticlePlan,
  assembled: { content: string; featuredImage: string; featuredImageAlt: string },
  extras: { categoryId?: string; authorId?: string },
): Record<string, unknown> {
  return {
    title: plan.title,
    slug: plan.slug,
    content: assembled.content,
    excerpt: plan.excerpt,
    featuredImage: assembled.featuredImage,
    featuredImageAlt: assembled.featuredImageAlt,
    tags: plan.tags,
    metaTitle: plan.metaTitle,
    metaDescription: plan.metaDescription,
    focusKeyword: plan.focusKeyword,
    status: 'published',
    ...(extras.categoryId ? { categoryId: extras.categoryId } : {}),
    ...(extras.authorId ? { authorId: extras.authorId } : {}),
  };
}

/** The category id for the title the plan picked, or none when it matched nothing. */
export function categoryIdFor(categories: Category[], title: string): string | undefined {
  const wanted = title.trim().toLowerCase();
  if (!wanted) return undefined;
  const hit =
    categories.find((c) => c.title.trim().toLowerCase() === wanted) ??
    categories.find((c) => c.slug?.trim().toLowerCase() === wanted);
  return hit?.id;
}

export type { PipelineContext };
