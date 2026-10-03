import type { Step } from '../engine.js';
import { parseJson, requireFields } from '../json.js';
import { parseJsonOrRepair } from '../parse-with-repair.js';
import type { Category } from '../../integrations/site-api.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { checkDescription, checkTitle, rulesPrompt, words } from '../../seo/rules.js';
import { feedbackFor, refineOnce } from '../../seo/refine.js';

const log = createLogger('content');

/**
 * Stages 1-4: gather site context, validate the spy source, derive SEO
 * metadata, generate the recipe, and turn it into image prompts.
 */

/**
 * The operator's research about this one recipe, as prompts receive it.
 *
 * `group` is the seed keyword — a label many recipes share, because spying on
 * one topic yields five or ten different dishes under it. It is passed so a
 * prompt can be told explicitly to ignore it as a subject.
 *
 * The rest was being collected and thrown away. Only `spy.title` ever reached
 * a model, and only in validate-spy; description and annotation were put into
 * the context by the step and then never referenced by the template. So the
 * whole article was written from one line of text, distilled into four SEO
 * fields — and five recipes sharing a topic came out as five copies of the
 * same article with the same pictures.
 */
function spyContext(ctx: import('../context.js').PipelineContext) {
  return {
    group: ctx.keyword.seed_keyword,
    title: ctx.keyword.spy_title,
    description: ctx.keyword.spy_description,
    annotation: stripMachineTags(ctx.keyword.annotation),
    articleUrl: ctx.keyword.spy_article_url,
  };
}

/** A keyword the guide added, whose seed is the exact keyword the operator chose. */
export const isGuideRow = (annotation: string): boolean => annotation.trim().startsWith('guide:');

/**
 * The annotation without the tags the platform writes into it ("guide:Dinners",
 * "seo:fallback"). They are bookkeeping for the Keywords page; shown to a model
 * they read like part of the dish's notes. The operator's own notes are kept.
 */
export function stripMachineTags(annotation: string): string {
  return annotation
    .split(' | ')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('guide:') && part !== 'seo:fallback')
    .join(' | ');
}

/** The prompt section for a guide row; empty for any other row. */
export const targetSectionFor = (seed: string): string =>
  seed.trim()
    ? `TARGET KEYWORD: ${seed.trim()}\n` +
      'This is the exact keyword the page must be found for: the output keyword must be it, ' +
      'and the title and description must be about that dish.'
    : '';

/**
 * Keep the derived keyword on the operator's chosen one.
 *
 * The prompt asks for this, but a model drifts, and the keyword drives the
 * title checks and every later step. A keyword that does not contain every
 * word of the seed is replaced by the seed.
 */
export function holdToTarget(keyword: string, seed: string): string {
  const have = new Set(words(keyword));
  return words(seed).every((w) => have.has(w)) ? keyword : seed.trim().toLowerCase();
}

export interface SeoData {
  keyword: string;
  title: string;
  description: string;
  category: string;
}

export interface ImagePromptSet {
  feature: string;
  topShot: string;
  angleShot: string;
  textureMacro: string;
  cookingProcess: string;
  beforeAfter: string;
}

/** GET /api/categories on the target site. */
export const fetchCategories: Step<void, Category[]> = {
  name: 'fetch-categories',
  title: 'Fetch site categories',
  async run(ctx) {
    const categories = await ctx.siteApi.getCategories();
    if (categories.length === 0) {
      throw new Error(
        `${ctx.site.domain} returned no categories. The article cannot be filed without one.`,
      );
    }
    return categories;
  },
};

/**
 * Validate the spy source against the site's categories.
 *
 * The model answers with FALSE when the source is unusable. The original
 * routed that to "mark the keyword No"; we surface it as a typed outcome and
 * let the runner decide.
 */
export class SpyRejectedError extends Error {
  constructor(readonly detail: string) {
    super(`Spy source rejected during validation: ${detail}`);
    this.name = 'SpyRejectedError';
  }
}

export const validateSpy: Step<Category[], SeoData> = {
  name: 'validate-spy',
  title: 'Validate spy source and derive SEO',
  async run(ctx, categories) {
    if (!ctx.keyword.spy_title.trim()) {
      // Without it the only thing describing this row is the topic group, and
      // every recipe under that group would be written from the same words.
      throw new SpyRejectedError(
        'This keyword has no spy title, so there is nothing to say which dish it is. ' +
          'The seed keyword is a topic group, not a recipe.',
      );
    }

    // For a guide row the seed is the long-tail keyword itself, not a topic
    // group shared by several recipes, so it is the target and there is no group.
    const guide = isGuideRow(ctx.keyword.annotation);
    const seed = ctx.keyword.seed_keyword;

    const ask = (feedback: string) =>
      ctx.prompt('spy-validation', {
        spy: guide ? { ...spyContext(ctx), group: '' } : spyContext(ctx),
        targetSection: guide ? targetSectionFor(seed) : '',
        categoryTitles: JSON.stringify(categories.map((c) => c.title)),
        site: { domain: ctx.site.domain },
        seoRules: rulesPrompt({ slug: false, focus: false }),
        seoFeedback: feedback,
      });

    const derive = async (content: string): Promise<SeoData> => {
      if (content.includes('FALSE')) throw new SpyRejectedError(content.slice(0, 300));
      const parsed = await parseJsonOrRepair<Record<string, string>>(
        ctx,
        content,
        'Spy validation output',
        { requiredFields: ['keyword', 'title', 'description', 'category'] },
      );
      requireFields(parsed, ['keyword', 'title', 'description', 'category'], 'Spy validation');
      return {
        keyword: guide ? holdToTarget(parsed.keyword!, seed) : parsed.keyword!,
        title: parsed.title!,
        description: parsed.description!,
        category: parsed.category!,
      };
    };

    const result = await ask('');
    // Rejection and unreadable JSON still stop the run, exactly as before.
    const first = await derive(result.content);

    // Wording is different: ask once more with the exact problems, and if it
    // still breaks a rule keep the answer and say so rather than stop.
    const refined = await refineOnce(
      first,
      (s) => [
        ...checkTitle(s.title, { keyword: s.keyword }),
        ...checkDescription(s.description, { keyword: s.keyword }),
      ],
      async (problems) => {
        try {
          return await derive((await ask(feedbackFor(problems))).content);
        } catch (err) {
          log.warn(`run ${ctx.runId}: second attempt at the SEO text failed: ${errorMessage(err)}`);
          return null;
        }
      },
    );
    if (refined.problems.length) {
      log.warn(`run ${ctx.runId}: SEO text for "${refined.value.keyword}" still breaks rules: ${refined.problems.join(' ')}`);
    }
    const seo = refined.value;

    // The failure this whole change exists to stop, caught where it happens
    // rather than three steps later in a photograph. Not fatal: a genuinely
    // one-recipe topic will trip it, and refusing to write that article would
    // be worse than writing it.
    if (!guide && collapsedToGroup(seo.keyword, ctx.keyword.seed_keyword)) {
      log.warn(
        `run ${ctx.runId}: "${ctx.keyword.spy_title}" produced the keyword ` +
          `"${seo.keyword}", which is just the topic group "${ctx.keyword.seed_keyword}". ` +
          'Every recipe in that group will come out the same. Check the spy title, ' +
          'description and annotation are filled in for this keyword.',
      );
    }

    return { value: seo, endpoint: result.endpoint, model: result.model };
  },
};

export interface RecipeData {
  raw: string;
  parsed: Record<string, unknown>;
}

export const generateRecipe: Step<SeoData, RecipeData> = {
  name: 'generate-recipe',
  title: 'Generate recipe',
  async run(ctx, seo) {
    const result = await ctx.prompt('recipe-generator', { seo, spy: spyContext(ctx) });

    // Parsed for validation; the raw string is what later prompts interpolate,
    // matching the original which passed Recipe generator's content through.
    const parsed = await parseJsonOrRepair<Record<string, unknown>>(
      ctx,
      result.content,
      'Recipe output',
    );

    // The repaired document is what downstream prompts see. Passing the
    // original raw text on would hand every later step the same broken JSON
    // this step just spent a model call fixing.
    return {
      value: { raw: JSON.stringify(parsed), parsed },
      endpoint: result.endpoint,
      model: result.model,
    };
  },
};

export const generateImagePrompts: Step<
  { seo: SeoData; recipe: RecipeData },
  ImagePromptSet
> = {
  name: 'generate-image-prompts',
  title: 'Generate image prompts',
  async run(ctx, input) {
    const result = await ctx.prompt('image-prompts', {
      seo: input.seo,
      // The images have to show this dish, not a generic member of its topic
      // group, so the step that draws them sees the source too.
      spy: spyContext(ctx),
      recipe: { raw: input.recipe.raw },
      recipeJson: JSON.stringify(input.recipe.parsed),
    });

    const parsed = await parseJsonOrRepair<Record<string, string>>(
      ctx,
      result.content,
      'Image prompt output',
    );
    requireFields(
      parsed,
      [
        'image_1_feature',
        'image_2_top_shot',
        'image_3_angle_shot',
        'image_4_texture_macro',
        'image_5_cooking_process',
        'image_6_before_after_split',
      ],
      'Image prompts',
    );

    return {
      value: {
        feature: parsed.image_1_feature!,
        topShot: parsed.image_2_top_shot!,
        angleShot: parsed.image_3_angle_shot!,
        textureMacro: parsed.image_4_texture_macro!,
        cookingProcess: parsed.image_5_cooking_process!,
        beforeAfter: parsed.image_6_before_after_split!,
      },
      endpoint: result.endpoint,
      model: result.model,
    };
  },
};

/**
 * Did the model answer with the topic group instead of the dish?
 *
 * A research label like "chicken thighs" covers five different recipes. When
 * the derived keyword is that label and nothing more, every one of them writes
 * the same article and generates the same pictures — which is exactly the
 * symptom that led here.
 *
 * Compared on significant words so "Chicken Thighs" and "chicken thigh" are
 * the same answer, and "honey soy chicken thighs" is not.
 */
export function collapsedToGroup(keyword: string, group: string): boolean {
  const words = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map((w) => w.replace(/s$/, ''))
        .filter((w) => w.length > 2),
    );

  const derived = words(keyword);
  const label = words(group);

  if (derived.size === 0 || label.size === 0) return false;

  // Adding nothing to the group's own words is the collapse. Any extra
  // significant word — a sauce, a method, a vessel — means it stayed specific.
  for (const word of derived) if (!label.has(word)) return false;
  return true;
}
