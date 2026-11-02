import { get, run } from '../db/index.js';
import { articleChat } from '../llm/gemini.js';
import { planLanguage } from './repo.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { similarity, words } from '../seo/rules.js';
import { inventedIngredients } from './article.js';
import { parseRecipe, recipeText, type Recipe } from './recipe.js';
import type { SeoRow } from './seo.js';
import { correctUntilRight, keptNote } from './rounds.js';
import { parseSkeleton, type Skeleton } from './skeleton.js';
import { articleColorStyle, colorStylesOf, type ColorStyle } from './color-styles.js';
import { articlePictureStyle, pictureStylesOf, type Style } from './style-library.js';

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
  /**
   * Recipe pages only: how this page's finished dish looks (shape, layers, colours, topping),
   * repeated in every prompt. Google Flow makes each picture on its own, without seeing the
   * others, so without one shared description every picture invents its own version of the dish.
   */
  dish: string;
  /** The one colour style of the article's pictures, by its name in the website's list (color-styles.ts). */
  colorStyle?: string;
  /** The one picture style of the article, by its name in the website's list (style-library.ts). */
  pictureStyle?: string;
}

export interface ImagePrompt {
  slot: string;
  prompt: string;
  alt: string;
  /** The picture's own title and description, sent with it to the website. Empty in sets written before they were asked for. */
  title?: string;
  description?: string;
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
        shows: `PORTRAIT 3:4 hero image at the top of the article, showing "${keyword}" exactly as the article is about it. A styled, lived-in scene that makes people stop scrolling: the dish as the star, a slice cut or a serving lifted out, a hand reaching in or a fork mid-bite, crumbs and drips, props from the recipe, depth with a soft foreground and background. Never a plain product shot on an empty table.`,
      },
      { slot: 'overhead', shows: `PORTRAIT 3:4 top-down shot of the ${keyword} on its table, the scene around it: plates, a cake server, scattered ingredients from the recipe, a linen napkin, hands at the edge of the frame.` },
      { slot: 'closeup', shows: `PORTRAIT 3:4 macro close-up of the most mouth-catching detail of the ${keyword} (crumb, layers, glaze, frosting swirl, juice), shallow depth of field.` },
      { slot: 'ingredients', shows: 'PORTRAIT 3:4 the raw ingredients from the recipe laid out before cooking, each one recognisable, arranged with care in bowls, spoons and their packaging.' },
      { slot: 'process', shows: 'PORTRAIT 3:4 a key moment while making it, half-way through, with hands at work (whisking, spreading, piping): the "before" of before-and-after.' },
      { slot: 'serving', shows: `PORTRAIT 3:4 one portion of the ${keyword} served (cut, scooped or poured) at a set table, ready to eat, someone about to enjoy it: the "after".` },
      ...recipe.steps.map((s, i, steps) => ({
        slot: `step-${i + 1}`,
        shows:
          `SQUARE 1:1 photo of step ${i + 1} of ${steps.length} of making the ${keyword}, the moment it describes, with hands at work: ${s.text} ` +
          `Show only what exists at this moment: the ingredients and tools this step uses and what the earlier steps made, in the same bowls and pans as the other steps.` +
          (i < steps.length - 1 ? ` The finished ${keyword} is not in this picture yet.` : ''),
      })),
    ];
  }
  const middle = skeleton.sections.slice(1, -1).slice(0, ARTICLE_SECTION_IMAGES);
  return [
    {
      slot: 'feature',
      shows: `PORTRAIT 3:4 hero image at the top of the article, showing "${keyword}" exactly as the article is about it, in the real place where it happens in this niche (not a table, unless the article is about one). A lived-in moment with depth: people, animals or things doing what the article describes.`,
    },
    ...middle.map((s, i) => ({ slot: `section-${i + 1}`, shows: `PORTRAIT 3:4 photo for the section "${s.h2}": ${s.covers}` })),
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
      dish: clean(t.dish, 300),
      colorStyle: clean(t.colorStyle, 80),
      pictureStyle: clean(t.pictureStyle, 80),
    },
    images: o.images.map((im) => {
      const i = (im ?? {}) as Record<string, unknown>;
      return { slot: clean(i.slot, 40), prompt: clean(i.prompt), alt: clean(i.alt ?? i.altText, 200), title: clean(i.title, 120), description: clean(i.description ?? i.caption, 400) };
    }),
  };
}

/**
 * How this website's photos look, for the AI. The website's picture styles
 * when it has some: one is followed as it is; from several, the AI picks ONE
 * for the article (theme.pictureStyle). Otherwise: food photography for a
 * recipe page, and for every other page real-life photography of the subject
 * where it belongs in the niche, never styled like food.
 */
export function pictureStyleFor(site: { niche: string; picture_style?: string }, recipePage: boolean, styles: Style[] = pictureStylesOf(site)): string {
  if (styles.length === 1) return styles[0]!.description || styles[0]!.name;
  if (styles.length > 1) {
    return (
      'Pick ONE of these picture styles for the whole article, the one that fits this article best, name it as the theme\'s pictureStyle exactly as written, ' +
      `and follow it in every picture: ${JSON.stringify(styles)}`
    );
  }
  if (recipePage) {
    return 'Food photography of this recipe: the dish as the star, styled and appetizing, on a table or counter with the props of the recipe, hands at work or reaching in.';
  }
  return (
    `Real-life photography for a website about ${site.niche || 'this topic'}. Decide from the niche and the article where these photos are really taken ` +
    '(a home, a garden, a park, a workshop, a clinic, a street, outdoors…) and show the subject there, the way an expert in this niche would photograph it. ' +
    'Never style it like food photography: no plates, cutlery, dining tables, garnish or serving, unless the article is about exactly that. ' +
    'Animals stand, sit, lie or play where animals really are (the floor, a bed, a sofa, the grass, a car, a vet’s examination table), never on a dining table or a plate.'
  );
}

/** Food styling words: on a page that is not a recipe, a prompt may use them only when the article itself does. */
const FOOD_STYLING: [RegExp, string][] = [
  [/\bplates?\b|\bplated\b/i, 'plate'],
  [/\bplatters?\b/i, 'platter'],
  [/\bcutlery\b|\bforks?\b|\bknife and fork\b/i, 'cutlery'],
  [/\bdining table\b|\bdinner table\b|\btabletop\b|\bon (a|the) table\b/i, 'table'],
  [/\bgarnish(ed)?\b/i, 'garnish'],
  [/\bappetizing\b|\bappetising\b/i, 'appetizing'],
  [/\bserved\b|\bserving\b/i, 'served'],
  [/\bfood photography\b|\bfood styling\b/i, 'food photography'],
];

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
  /** The website's language. Picture prompts are English, so the recipe can be held to them only when it is too. */
  language?: string;
  /** The article's text: on a page that is not a recipe, food styling is allowed only when it talks about it. */
  article?: string;
  /** The colour styles it picks one from, by name. */
  colorStyles?: string[];
  /** The picture styles it picks one from, by name, when there are several. */
  pictureStyles?: string[];
}

/** What is wrong with the set, in words the AI can act on. Empty when it passes. */
export function checkImageSet(set: ImageSet, ctx: ImageContext): string[] {
  const problems: string[] = [];
  for (const field of ['surface', 'lighting', 'palette', 'style', 'mood'] as const) {
    if (!set.theme[field]) problems.push(`The theme needs its ${field}.`);
  }
  // A recipe page: every picture is the same dish, so every prompt carries its description.
  const recipePage = ctx.allowedText !== undefined;
  if (ctx.colorStyles?.length && !ctx.colorStyles.some((n) => n.toLowerCase() === (set.theme.colorStyle ?? '').toLowerCase())) {
    problems.push(`The theme needs its colorStyle: exactly one name from the colour styles given (${ctx.colorStyles.join(', ')}), the one that fits this article best.`);
  }
  if (ctx.pictureStyles && ctx.pictureStyles.length > 1 && !ctx.pictureStyles.some((n) => n.toLowerCase() === (set.theme.pictureStyle ?? '').toLowerCase())) {
    problems.push(`The theme needs its pictureStyle: exactly one name from the picture styles given (${ctx.pictureStyles.join(', ')}), the one that fits this article best.`);
  }
  if (recipePage && !set.theme.dish) problems.push('The theme needs its dish: how this recipe\'s finished dish looks (shape, layers, colours, topping), from the recipe.');

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
    if (recipePage && set.theme.dish && !hasAllWords(im.prompt, set.theme.dish)) {
      problems.push(`${name}: repeat the theme's dish word for word ("${set.theme.dish}"), so the picture shows this recipe and not another version of it.`);
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
    if (ctx.allowedText !== undefined && (!ctx.language || ctx.language === 'English')) {
      // The theme's own words count too: "pumpkin orange" in the palette is a colour.
      const themeText = Object.values(set.theme).join('\n');
      const invented = inventedIngredients(im.prompt, [ctx.allowedText, ctx.keyword, themeText].join('\n'));
      if (invented.length) problems.push(`${name}: these ingredients are not in the recipe: ${invented.join(', ')}.`);
    }
    if (!recipePage && ctx.article !== undefined) {
      for (const [pattern, word] of FOOD_STYLING) {
        if (pattern.test(im.prompt) && !pattern.test(ctx.article)) {
          problems.push(`${name}: "${word}" is food styling and this article never talks about it. Show the subject where it really is in this niche, not on a table or a plate.`);
        }
      }
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
  ask: (promptName: string, variables: Record<string, unknown>, chat?: string) => Promise<string>;
}

interface Context {
  niche: string;
  niche_context: string;
  picture_style: string;
  color_styles: string;
}

/** The style the AI named, from the styles it was given; else the first of them (the website's main one). */
const chosenStyle = (styles: ColorStyle[], named: string | undefined): ColorStyle | null =>
  styles.find((s) => s.name.toLowerCase() === (named ?? '').toLowerCase()) ?? styles[0] ?? null;

/** Write the image prompts for one keyword, correcting mistakes until they pass (rounds.ts). */
export async function makeImagePrompts(row: SeoRow, deps: ImageDeps): Promise<void> {
  const ctx = get<Context>(
    `SELECT w.niche, w.niche_context, w.picture_style, w.color_styles FROM keyword_plans p JOIN new_websites w ON w.id = p.website_id WHERE p.id = ?`,
    row.plan_id,
  );
  const skeleton = row.skeleton_json ? parseSkeleton(row.skeleton_json) : null;
  if (!ctx || !skeleton || !row.article_md) {
    run(
      `UPDATE keyword_seo SET images_status = 'failed', images_problems = ? WHERE id = ?`,
      !ctx ? 'Its keyword plan or website is gone.' : 'The article is missing. Write the article again.',
      row.id,
    );
    return;
  }
  run(`UPDATE keyword_seo SET images_status = 'writing' WHERE id = ?`, row.id);

  const recipe = row.recipe_json ? parseRecipe(row.recipe_json) : null;
  const slots = imageSlots(row.keyword, skeleton, recipe);
  // The pictures show this page's own recipe only. (A main page's article may talk about its
  // sub-recipes, but letting their ingredients into the pictures is how a strawberry cake got
  // blueberries in its step photos.)
  const allowedText = recipe ? recipeText(recipe) + '\n' + recipe.notes : undefined;
  // One colour style for the whole article: the one it already has (made again, it keeps it), or one the AI picks.
  const kept = articleColorStyle(row.id);
  const styles = kept ? [kept] : colorStylesOf(ctx);
  // The same with its picture style: the one kept, or one the AI picks from the website's list.
  const keptPicture = articlePictureStyle(row.id);
  const pictureStyles = keptPicture ? [keptPicture] : pictureStylesOf(ctx);

  const outcome = await correctUntilRight<ImageSet>({
    ask: (corrections) =>
      deps.ask('article-images', {
        language: planLanguage(row.plan_id),
        keyword: row.keyword,
        title: row.title,
        niche: ctx.niche,
        nicheContext: ctx.niche_context || '(none)',
        pictureStyle: pictureStyleFor(ctx, Boolean(recipe), pictureStyles),
        altPattern: row.alt_text || '(none)',
        recipeJson: recipe ? JSON.stringify(recipe) : '(no fixed recipe for this page)',
        article: row.article_md.slice(0, 24000),
        slotsJson: JSON.stringify(slots),
        colorStylesJson: JSON.stringify(styles),
        problemsJson: corrections,
      }, articleChat(row.id)),
    parse: parseImageSet,
    check: (set) =>
      checkImageSet(set, { keyword: row.keyword, slots, allowedText, language: planLanguage(row.plan_id), article: row.article_md, colorStyles: styles.map((s) => s.name), pictureStyles: pictureStyles.map((s) => s.name) }),
    onError: (err) => log.warn(`AI#4 could not reach the AI for "${row.keyword}": ${errorMessage(err)}`),
  });
  const { problems, technical } = outcome;
  const last = outcome.answer;
  const style = last ? chosenStyle(styles, last.theme.colorStyle) : null;
  if (last && style) {
    last.theme.colorStyle = style.name;
    run('UPDATE keyword_seo SET color_style = ? WHERE id = ?', JSON.stringify(style), row.id);
  }
  const picture = last ? chosenStyle(pictureStyles, last.theme.pictureStyle) : null;
  if (last && picture) {
    last.theme.pictureStyle = picture.name;
    run('UPDATE keyword_seo SET picture_style = ? WHERE id = ?', JSON.stringify(picture), row.id);
  }

  run(
    `UPDATE keyword_seo SET images_status = ?, images_json = ?, images_problems = ? WHERE id = ?`,
    technical ? 'failed' : 'done',
    last ? JSON.stringify(last) : '',
    technical ? problems.join('\n') : keptNote(problems.slice(0, 20)),
    row.id,
  );
}
