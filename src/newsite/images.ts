import { all, get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { similarity, words } from '../seo/rules.js';
import { inventedIngredients } from './article.js';
import { parseRecipe, recipeText, type Recipe } from './recipe.js';
import type { SeoRow } from './seo.js';
import { parseSkeleton, type Skeleton } from './skeleton.js';

/**
 * AI#4: the image prompts for one keyword's article, made after the article.
 *
 * Code decides which images an article gets (its slots); the AI first sets
 * one visual theme (surface, light, palette, style, mood) and then writes a
 * detailed prompt per slot that follows it, so every picture looks like the
 * same photoshoot. The checks below hold every prompt to the plan's rules.
 * Pictures are made from these prompts by Google Flow in the next step.
 */

const log = createLogger('newsite-images');
const ROUNDS = 3;

export const PROMPT_WORDS = [40, 160] as const;
export const ALT_WORDS = [8, 12] as const;
const ARTICLE_SECTION_IMAGES = 5;

export interface ImageSlot {
  slot: string;
  /** What the picture shows, in words for the AI. */
  shows: string;
}

export interface ImageTheme {
  surface: string;
  lighting: string;
  palette: string;
  style: string;
  mood: string;
}

export interface ImagePrompt {
  slot: string;
  prompt: string;
  alt: string;
}

export interface ImageSet {
  theme: ImageTheme;
  images: ImagePrompt[];
}

/** Words that make a prompt generic instead of specific. */
export const BANNED_WORDS: RegExp[] = [
  /\bbeautiful(ly)?\b/i,
  /\bstunning\b/i,
  /\bgorgeous\b/i,
  /\bbreathtaking\b/i,
  /\bmagical\b/i,
  /\bfantasy\b/i,
  /\bdreamy\b/i,
  /\bepic\b/i,
  /\bmasterpiece\b/i,
  /\bmouth[- ]watering\b/i,
  /\bperfect(ly)?\b/i,
  /\b(8|4)k\b/i,
  /\bhyper[- ]?realistic\b/i,
];

/**
 * The images one article gets. A recipe page: six photos of the dish, then
 * one per recipe step. Any other page: a feature image, then one per main
 * section (not the opening or the closing), six at most.
 */
export function imageSlots(keyword: string, skeleton: Skeleton, recipe: Recipe | null): ImageSlot[] {
  if (recipe) {
    return [
      {
        slot: 'feature',
        shows: `WIDE 16:9 hero image at the top of the article, showing "${keyword}" exactly as the article is about it. A styled, lived-in scene that makes people stop scrolling: the dish as the star, a slice cut or a serving lifted out, a hand reaching in or a fork mid-bite, crumbs and drips, props from the recipe, depth with a soft foreground and background. Never a plain product shot on an empty table.`,
      },
      { slot: 'overhead', shows: `WIDE 16:9 top-down shot of the ${keyword} on its table, the scene around it: plates, a cake server, scattered ingredients from the recipe, a linen napkin, hands at the edge of the frame.` },
      { slot: 'closeup', shows: `WIDE 16:9 macro close-up of the most mouth-catching detail of the ${keyword} (crumb, layers, glaze, frosting swirl, juice), shallow depth of field.` },
      { slot: 'ingredients', shows: 'WIDE 16:9 the raw ingredients from the recipe laid out before cooking, each one recognisable, arranged with care in bowls, spoons and their packaging.' },
      { slot: 'process', shows: 'WIDE 16:9 a key moment while making it, half-way through, with hands at work (whisking, spreading, piping): the "before" of before-and-after.' },
      { slot: 'serving', shows: `WIDE 16:9 one portion of the ${keyword} served (cut, scooped or poured) at a set table, ready to eat, someone about to enjoy it: the "after".` },
      ...recipe.steps.map((s, i) => ({ slot: `step-${i + 1}`, shows: `WIDE 16:9 photo of step ${i + 1} of the recipe, the moment it describes, with hands at work: ${s.text}` })),
    ];
  }
  const middle = skeleton.sections.slice(1, -1).slice(0, ARTICLE_SECTION_IMAGES);
  return [
    {
      slot: 'feature',
      shows: `WIDE 16:9 hero image at the top of the article, showing "${keyword}" exactly as the article is about it. A styled, lived-in scene with people's hands, the moment of doing it, props and depth. Never a plain object on an empty table.`,
    },
    ...middle.map((s, i) => ({ slot: `section-${i + 1}`, shows: `WIDE 16:9 photo for the section "${s.h2}": ${s.covers}` })),
  ];
}

const clean = (v: unknown, max = 1200): string =>
  (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The model's JSON as an image set, whatever wrapper it came in. */
export function parseImageSet(raw: string): ImageSet | null {
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
  const o = value as { theme?: Record<string, unknown>; images?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.images)) return null;
  const t = o.theme ?? {};
  return {
    theme: {
      surface: clean(t.surface, 200),
      lighting: clean(t.lighting, 200),
      palette: clean(t.palette, 200),
      style: clean(t.style, 200),
      mood: clean(t.mood, 200),
    },
    images: o.images.map((im) => {
      const i = (im ?? {}) as Record<string, unknown>;
      return { slot: clean(i.slot, 40), prompt: clean(i.prompt), alt: clean(i.alt ?? i.altText, 200) };
    }),
  };
}

/** Every content word of `phrase` appears in `text` (plurals count as the same word). */
const hasAllWords = (text: string, phrase: string): boolean => {
  const have = new Set(words(text));
  return words(phrase).every((w) => have.has(w));
};

export interface ImageContext {
  keyword: string;
  slots: ImageSlot[];
  /** The recipe's own text, when the page has a fixed recipe. */
  allowedText?: string;
}

/** What is wrong with the set, in words the AI can act on. Empty when it passes. */
export function checkImageSet(set: ImageSet, ctx: ImageContext): string[] {
  const problems: string[] = [];
  for (const field of ['surface', 'lighting', 'palette', 'style', 'mood'] as const) {
    if (!set.theme[field]) problems.push(`The theme needs its ${field}.`);
  }

  const got = set.images.map((i) => i.slot);
  const wanted = ctx.slots.map((s) => s.slot);
  if (JSON.stringify(got) !== JSON.stringify(wanted)) {
    problems.push(`Write exactly one image per slot, in this order: ${wanted.join(', ')}.`);
  }

  const subject = words(ctx.keyword);
  set.images.forEach((im, i) => {
    const name = `Image "${im.slot || i + 1}"`;
    const n = im.prompt.split(/\s+/).filter(Boolean).length;
    if (n < PROMPT_WORDS[0] || n > PROMPT_WORDS[1]) {
      problems.push(`${name}: the prompt has ${n} words; write ${PROMPT_WORDS[0]} to ${PROMPT_WORDS[1]}.`);
    }
    if (set.theme.surface && !hasAllWords(im.prompt, set.theme.surface)) {
      problems.push(`${name}: repeat the theme's surface word for word ("${set.theme.surface}").`);
    }
    if (set.theme.lighting && !hasAllWords(im.prompt, set.theme.lighting)) {
      problems.push(`${name}: repeat the theme's lighting word for word ("${set.theme.lighting}").`);
    }
    if (!/\b\d{2,3}\s?mm\b|\bmacro lens\b/i.test(im.prompt)) problems.push(`${name}: give the lens (for example "50mm").`);
    if (!/\bf\/\d+(\.\d)?\b/i.test(im.prompt)) problems.push(`${name}: give the aperture (for example "f/4").`);
    if (!/\b\d{4}\s?K\b/.test(im.prompt)) problems.push(`${name}: give the light temperature (for example "5500K").`);
    if (!/\bno text\b/i.test(im.prompt)) problems.push(`${name}: end with "no text, no labels, no watermarks".`);
    if (!words(im.prompt).some((w) => subject.includes(w))) {
      problems.push(`${name}: name the subject ("${ctx.keyword}") or a part of it, so the picture matches the article.`);
    }
    for (const pattern of BANNED_WORDS) {
      const hit = im.prompt.match(pattern);
      if (hit) problems.push(`${name}: replace the generic word "${hit[0]}" with a specific detail.`);
    }
    if (ctx.allowedText !== undefined) {
      // The theme's own words count too: "pumpkin orange" in the palette is a colour.
      const themeText = Object.values(set.theme).join('\n');
      const invented = inventedIngredients(im.prompt, [ctx.allowedText, ctx.keyword, themeText].join('\n'));
      if (invented.length) problems.push(`${name}: these ingredients are not in the recipe: ${invented.join(', ')}.`);
    }
    const twin = set.images.slice(0, i).find((other) => similarity(other.prompt, im.prompt) >= 0.85);
    if (twin) problems.push(`${name}: too close to image "${twin.slot}"; show something different.`);

    const altWords = im.alt.split(/\s+/).filter(Boolean).length;
    if (altWords < ALT_WORDS[0] || altWords > ALT_WORDS[1]) {
      problems.push(`${name}: the alt text has ${altWords} words; write ${ALT_WORDS[0]} to ${ALT_WORDS[1]}.`);
    }
    if (/^(an? )?(image|picture|photo) of\b/i.test(im.alt)) problems.push(`${name}: the alt text must not start with "image of".`);
  });
  return problems;
}

/* -- The writer step ----------------------------------------------------- */

export interface ImageDeps {
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
}

interface Context {
  niche: string;
  niche_context: string;
}

/** Write the image prompts for one keyword: up to three rounds, then done or failed. */
export async function makeImagePrompts(row: SeoRow, deps: ImageDeps): Promise<void> {
  const ctx = get<Context>(
    `SELECT w.niche, w.niche_context FROM keyword_plans p JOIN new_websites w ON w.id = p.website_id WHERE p.id = ?`,
    row.plan_id,
  );
  const skeleton = row.skeleton_json ? parseSkeleton(row.skeleton_json) : null;
  if (!ctx || !skeleton || !row.article_md) return;
  run(`UPDATE keyword_seo SET images_status = 'writing' WHERE id = ?`, row.id);

  const recipe = row.recipe_json ? parseRecipe(row.recipe_json) : null;
  const slots = imageSlots(row.keyword, skeleton, recipe);
  let allowedText: string | undefined;
  if (recipe) {
    allowedText = recipeText(recipe) + '\n' + recipe.notes;
    if (row.role === 'pillar') {
      for (const r of all<{ recipe_json: string }>(`SELECT recipe_json FROM keyword_seo WHERE plan_id = ? AND role = 'sub' AND recipe_json != ''`, row.plan_id)) {
        const sub = parseRecipe(r.recipe_json);
        if (sub) allowedText += '\n' + recipeText(sub);
      }
    }
  }

  let problems: string[] = [];
  let last: ImageSet | null = null;
  for (let round = 0; round < ROUNDS; round++) {
    let raw: string;
    try {
      raw = await deps.ask('article-images', {
        keyword: row.keyword,
        title: row.title,
        niche: ctx.niche,
        nicheContext: ctx.niche_context || '(none)',
        altPattern: row.alt_text || '(none)',
        recipeJson: recipe ? JSON.stringify(recipe) : '(no fixed recipe for this page)',
        article: row.article_md.slice(0, 24000),
        slotsJson: JSON.stringify(slots),
        problemsJson: JSON.stringify(problems),
      });
    } catch (err) {
      log.warn(`AI#4 could not reach the AI for "${row.keyword}": ${errorMessage(err)}`);
      problems = ['The AI could not be reached. Check the AI keys on the Platform page.'];
      break;
    }
    last = parseImageSet(raw);
    problems = last ? checkImageSet(last, { keyword: row.keyword, slots, allowedText }) : ['The AI answer could not be read.'];
    if (problems.length === 0) break;
  }

  run(
    `UPDATE keyword_seo SET images_status = ?, images_json = ?, images_problems = ? WHERE id = ?`,
    problems.length ? 'failed' : 'done',
    last ? JSON.stringify(last) : '',
    problems.slice(0, 20).join('\n'),
    row.id,
  );
}
