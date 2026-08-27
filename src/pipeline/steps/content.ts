import type { Step } from '../engine.js';
import { parseJson, requireFields } from '../json.js';
import { parseJsonOrRepair } from '../parse-with-repair.js';
import type { Category } from '../../integrations/site-api.js';

/**
 * Stages 1-4: gather site context, validate the spy source, derive SEO
 * metadata, generate the recipe, and turn it into image prompts.
 */

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
    const result = await ctx.prompt('spy-validation', {
      spy: {
        title: ctx.keyword.spy_title,
        articleUrl: ctx.keyword.spy_article_url,
        annotation: ctx.keyword.annotation,
      },
      categoryTitles: JSON.stringify(categories.map((c) => c.title)),
      site: { domain: ctx.site.domain },
    });

    if (result.content.includes('FALSE')) {
      throw new SpyRejectedError(result.content.slice(0, 300));
    }

    const parsed = await parseJsonOrRepair<Record<string, string>>(
      ctx,
      result.content,
      'Spy validation output',
      { requiredFields: ['keyword', 'title', 'description', 'category'] },
    );
    requireFields(parsed, ['keyword', 'title', 'description', 'category'], 'Spy validation');

    return {
      value: {
        keyword: parsed.keyword!,
        title: parsed.title!,
        description: parsed.description!,
        category: parsed.category!,
      },
      endpoint: result.endpoint,
      model: result.model,
    };
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
    const result = await ctx.prompt('recipe-generator', {
      seo,
      spy: {
        title: ctx.keyword.spy_title,
        description: ctx.keyword.spy_description,
        annotation: ctx.keyword.annotation,
      },
    });

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
