import type { Step } from '../engine.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { LlmJsonError, parseJson } from '../json.js';
import { parseJsonOrRepair } from '../parse-with-repair.js';
import type { PipelineContext } from '../context.js';
import type { ArticleImages } from './images.js';
import type { RecipeData, SeoData } from './content.js';
import type { PostedRecipe } from '../../integrations/site-api.js';

const log = createLogger('article');

/**
 * Article generation and publishing.
 *
 * The original generated three parts, each with a hand-wired fallback node
 * pointing at a different Ollama account AND a shorter prompt. Endpoint
 * failover is now the pool's job; what remains here is the *prompt*
 * fallback, which is a genuine quality strategy: try the full prompt, and if
 * it fails or returns unusable JSON, try the simpler one.
 */

export interface ArticleInput {
  seo: SeoData;
  recipe: RecipeData;
  images: ArticleImages;
}

/** Variables every article prompt interpolates. */
function promptVariables(input: ArticleInput): Record<string, unknown> {
  return {
    seo: input.seo,
    recipe: { raw: input.recipe.raw },
    images: {
      feature: input.images.feature,
      topShot: input.images.topShot,
      textureMacro: input.images.textureMacro,
      beforeAfter: input.images.beforeAfter,
    },
  };
}

/**
 * Generate one part, falling back to the simpler prompt variant on failure.
 * Endpoint-level retries have already happened inside the pool by this point,
 * so reaching the fallback means the prompt itself is the problem.
 */
async function generatePart(
  ctx: PipelineContext,
  part: 'part-1' | 'part-2' | 'part-3',
  input: ArticleInput,
): Promise<{ data: Record<string, unknown>; endpoint: string; model: string }> {
  const variables = promptVariables(input);

  try {
    const result = await ctx.prompt(part, variables);
    return {
      data: await parseJsonOrRepair<Record<string, unknown>>(ctx, result.content, `${part} output`),
      endpoint: result.endpoint,
      model: result.model,
    };
  } catch (err) {
    log.warn(`${part} failed with the primary prompt, trying the fallback`, errorMessage(err));

    const result = await ctx.prompt(`${part}.fallback`, variables);
    return {
      data: await parseJsonOrRepair<Record<string, unknown>>(
        ctx,
        result.content,
        `${part} fallback output`,
      ),
      endpoint: result.endpoint,
      model: result.model,
    };
  }
}

/**
 * Assemble the recipe document from three generated parts.
 *
 * The original read allItems[0], [1], [2] positionally out of a merge node,
 * so a reordered merge would silently produce a scrambled article. Named
 * values make that impossible.
 */
export const generateArticle: Step<ArticleInput, Record<string, unknown>> = {
  name: 'generate-article',
  title: 'Generate article (3 parts)',
  async run(ctx, input) {
    const part1 = await generatePart(ctx, 'part-1', input);
    const part2 = await generatePart(ctx, 'part-2', input);
    const part3 = await generatePart(ctx, 'part-3', input);

    const article = { ...part1.data, ...part2.data, ...part3.data };

    if (!article.title) {
      throw new Error('Assembled article has no title; the parts did not merge as expected.');
    }

    return {
      value: article,
      endpoint: [part1.endpoint, part2.endpoint, part3.endpoint].join(', '),
      model: part1.model,
    };
  },
};

/**
 * Publish the article, repairing malformed JSON if the site rejects it.
 *
 * Mirrors the original's Posting → error → Article Json (repair) → Posting
 * loop, with the retry ceiling honoured consistently.
 */
const MAX_POST_ATTEMPTS = 3;

export const postArticle: Step<Record<string, unknown>, PostedRecipe> = {
  name: 'post-article',
  title: 'Publish article to site',
  async run(ctx, article) {
    let payload = article;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS; attempt++) {
      try {
        const posted = await ctx.siteApi.postRecipe(payload);
        if (!posted.id) throw new Error('Site accepted the post but returned no id');
        log.info(`published to ${ctx.site.domain} as ${posted.id} (attempt ${attempt})`);
        return posted;
      } catch (err) {
        lastError = errorMessage(err);
        log.warn(`post attempt ${attempt}/${MAX_POST_ATTEMPTS} failed: ${lastError}`);

        if (attempt === MAX_POST_ATTEMPTS) break;

        // Ask the model to repair the document against the site's complaint.
        try {
          const repaired = await ctx.prompt('repair-json', {
            postError: lastError,
            articleJson: JSON.stringify(payload),
          });
          payload = parseJson<Record<string, unknown>>(repaired.content, 'Repaired article JSON');
          log.info('article JSON repaired, retrying');
        } catch (repairErr) {
          if (repairErr instanceof LlmJsonError) {
            log.warn('JSON repair produced invalid JSON; retrying with the original payload');
          } else {
            log.warn('JSON repair failed', errorMessage(repairErr));
          }
        }

        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }

    throw new Error(
      `Publishing to ${ctx.site.domain} failed after ${MAX_POST_ATTEMPTS} attempts. ` +
        `Last error: ${lastError}`,
    );
  },
};
