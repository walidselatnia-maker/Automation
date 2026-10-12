import { get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { SeoRow } from './seo.js';
import { correctUntilRight, keptNote } from './rounds.js';

/**
 * The fixed recipe for one keyword on a recipe website.
 *
 * Made after the keyword's SEO metadata and before its skeleton. It is the
 * single source of truth: the skeleton and the article are built from it and
 * may not add ingredients or steps it does not have. Its shape is the
 * blog-engine recipe card's own `details`, so it can be published as it is.
 */

const log = createLogger('newsite-recipe');

export interface Recipe {
  prepMinutes: number;
  cookMinutes: number;
  servings: number;
  difficulty: 'easy' | 'medium' | 'hard';
  cuisine: string;
  course: string;
  ingredients: { title: string; items: string[] }[];
  steps: { text: string }[];
  nutrition: { calories: number; protein: number; carbs: number; fat: number };
  notes: string;
}

const text = (v: unknown, max = 300): string =>
  (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : -1;
};

/** The model's JSON as a recipe, whatever wrapper it came in. */
export function parseRecipe(raw: string): Recipe | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    try {
      value = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null;
    } catch {
      value = null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const n = (o.nutrition ?? {}) as Record<string, unknown>;
  const difficulty = text(o.difficulty).toLowerCase();
  return {
    prepMinutes: int(o.prepMinutes),
    cookMinutes: int(o.cookMinutes),
    servings: int(o.servings),
    difficulty: (['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : '') as Recipe['difficulty'],
    cuisine: text(o.cuisine, 60),
    course: text(o.course, 60),
    ingredients: (Array.isArray(o.ingredients) ? (o.ingredients as Record<string, unknown>[]) : []).map((g) => ({
      title: text(g?.title, 80),
      items: (Array.isArray(g?.items) ? (g.items as unknown[]) : []).map((i) => text(i, 160)).filter(Boolean),
    })),
    steps: (Array.isArray(o.steps) ? (o.steps as unknown[]) : [])
      .map((s) => ({ text: text(typeof s === 'string' ? s : (s as { text?: unknown })?.text, 600) }))
      .filter((s) => s.text),
    nutrition: { calories: int(n.calories), protein: int(n.protein), carbs: int(n.carbs), fat: int(n.fat) },
    notes: text(o.notes, 800),
  };
}

/** A quantity or a measure, so "flour" alone is caught but "a pinch of salt" is fine. */
const HAS_AMOUNT =
  /\d|½|¼|¾|⅓|⅔|\b(a|an|one|two|three|half|pinch|dash|handful|splash|to taste|as needed|for (serving|garnish|greasing|dusting))\b/i;

/**
 * What each diet keyword rules out. A keyword that promises a diet gets a
 * recipe that keeps the promise; anything else would mislead the reader.
 */
const DIETS: { when: RegExp; label: string; banned: RegExp; unless: RegExp }[] = [
  {
    when: /\bvegan\b|\bplant[- ]based\b/i,
    label: 'vegan',
    banned: /\b(eggs?|butter|milk|cream|cheese|yogh?urt|honey|gelatin|buttermilk|ghee|lard|chicken|beef|pork|fish|bacon)\b/i,
    unless: /\b(vegan|plant[- ]based|dairy[- ]free|non[- ]dairy|almond|oat|soy|coconut|cashew|flax|chia|peanut|nut)\b/i,
  },
  {
    when: /\bgluten[- ]free\b/i,
    label: 'gluten-free',
    banned: /\b(all[- ]purpose flour|wheat|bread flour|cake flour|self[- ]rising flour|plain flour|barley|rye|semolina|spelt)\b/i,
    unless: /\bgluten[- ]free\b/i,
  },
  {
    when: /\bdairy[- ]free\b/i,
    label: 'dairy-free',
    banned: /\b(butter|milk|cream|cheese|yogh?urt|buttermilk|ghee)\b/i,
    unless: /\b(dairy[- ]free|vegan|non[- ]dairy|almond|oat|soy|coconut|cashew|peanut|nut)\b/i,
  },
  {
    when: /\b(egg[- ]free|eggless|without eggs?|no eggs?)\b/i,
    label: 'egg-free',
    banned: /\beggs?\b/i,
    unless: /\b(egg[- ]free|eggless|flax egg|chia egg|egg replacer|vegan egg)\b/i,
  },
];

/** What is wrong with a recipe, in words the AI can act on. Empty when it passes. */
export function checkRecipe(r: Recipe, keyword: string): string[] {
  const problems: string[] = [];
  if (r.prepMinutes < 0 || r.prepMinutes > 1440) problems.push('Prep minutes must be a whole number from 0 to 1440.');
  if (r.cookMinutes < 0 || r.cookMinutes > 1440) problems.push('Cook minutes must be a whole number from 0 to 1440.');
  if (r.prepMinutes + r.cookMinutes <= 0) problems.push('The recipe needs a prep or cook time.');
  if (r.servings < 1 || r.servings > 100) problems.push('Servings must be a whole number from 1 to 100.');
  if (!r.difficulty) problems.push('Difficulty must be easy, medium or hard.');
  if (!r.cuisine) problems.push('Give the cuisine, for example American or Italian.');
  if (!r.course) problems.push('Give the course, for example Dessert or Main course.');

  const items = r.ingredients.flatMap((g) => g.items);
  if (r.ingredients.length === 0 || items.length < 3) problems.push('List at least 3 ingredients, grouped.');
  if (items.length > 40) problems.push('List at most 40 ingredients.');
  if (r.ingredients.some((g) => g.items.length === 0)) problems.push('Every ingredient group needs at least one ingredient.');
  const vague = items.filter((i) => !HAS_AMOUNT.test(i));
  if (vague.length) problems.push(`Give an exact amount for: ${vague.slice(0, 5).join('; ')}.`);

  if (r.steps.length < 3 || r.steps.length > 25) problems.push(`There are ${r.steps.length} steps; use 3 to 25.`);
  const thin = r.steps.filter((s) => s.text.length < 20);
  if (thin.length) problems.push('Each step must say what to do in a full sentence.');

  const n = r.nutrition;
  if (n.calories < 20 || n.calories > 3000) problems.push('Calories per serving must be between 20 and 3000.');
  if ([n.protein, n.carbs, n.fat].some((g) => g < 0 || g > 500)) problems.push('Protein, carbs and fat must be grams from 0 to 500.');

  for (const diet of DIETS) {
    if (!diet.when.test(keyword)) continue;
    const broken = items.filter((i) => diet.banned.test(i) && !diet.unless.test(i));
    if (broken.length) problems.push(`The keyword promises ${diet.label}, but these break it: ${broken.slice(0, 5).join('; ')}.`);
  }
  return problems;
}

/** Every ingredient line and step, for the skeleton and article prompts and their checks. */
export const recipeText = (r: Recipe): string =>
  [...r.ingredients.flatMap((g) => g.items), ...r.steps.map((s) => s.text)].join('\n');

/* -- The writer step ----------------------------------------------------- */

export interface RecipeDeps {
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
}

interface Context {
  pillar: string;
  niche: string;
  niche_context: string;
  persona: string;
}

/** Make one keyword's recipe, correcting mistakes until it passes (rounds.ts). */
export async function makeRecipe(row: SeoRow, deps: RecipeDeps): Promise<void> {
  const ctx = get<Context>(
    `SELECT p.pillar, w.niche, w.niche_context, w.persona
       FROM keyword_plans p JOIN new_websites w ON w.id = p.website_id WHERE p.id = ?`,
    row.plan_id,
  );
  if (!ctx) {
    run(`UPDATE keyword_seo SET recipe_status = 'failed', recipe_problems = 'Its keyword plan or website is gone.' WHERE id = ?`, row.id);
    return;
  }
  run(`UPDATE keyword_seo SET recipe_status = 'writing' WHERE id = ?`, row.id);

  const outcome = await correctUntilRight<Recipe>({
    ask: (corrections) =>
      deps.ask('recipe-card', {
        keyword: row.keyword,
        role:
          row.role === 'pillar'
            ? 'the pillar: the classic, definitive version of this dish'
            : 'a sub-page: a genuinely different version (its own diet, method, format or flavor), not the pillar with one swap',
        pillar: ctx.pillar,
        title: row.title,
        description: row.description,
        niche: ctx.niche,
        nicheContext: ctx.niche_context || '(none)',
        persona: ctx.persona,
        problemsJson: corrections,
      }),
    parse: parseRecipe,
    check: (r) => checkRecipe(r, row.keyword),
    onError: (err) => log.warn(`Recipe step could not reach the AI for "${row.keyword}": ${errorMessage(err)}`),
  });
  const { problems, technical } = outcome;
  const last = outcome.answer;

  const ok = !technical;
  run(
    `UPDATE keyword_seo SET recipe_status = ?, recipe_json = ?, recipe_problems = ?,
       skeleton_status = ?, skeleton_json = '', skeleton_problems = '',
       article_status = '', article_md = '', article_words = 0, article_problems = '',
       images_status = '', images_json = '', images_problems = ''
     WHERE id = ?`,
    ok ? 'done' : 'failed',
    last ? JSON.stringify(last) : '',
    ok ? keptNote(problems) : problems.join('\n'),
    // The skeleton is built from the recipe, so it waits for a good one.
    ok ? 'pending' : '',
    row.id,
  );
}
