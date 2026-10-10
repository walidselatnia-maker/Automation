import { all, get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { words } from '../seo/rules.js';
import { parseRecipe, recipeText, type Recipe } from './recipe.js';
import type { SeoRow } from './seo.js';
import { parseSkeleton, type SkeletonSection } from './skeleton.js';

/**
 * AI#3: the article for one keyword, written from its skeleton.
 *
 * One H2 section per request, so even a long pillar stays within what one
 * answer can hold. Each section is checked before the next is written, and
 * its problems go back to the AI, up to three rounds.
 *
 * After three rounds the best attempt is kept when only soft problems are
 * left (a little long or short, a little hard to read). A hard problem
 * (wrong headings, a generic AI phrase, an ingredient the recipe does not
 * have) stops the article at that section. The sections already written are
 * kept, so trying again carries on from the section that failed.
 */

const log = createLogger('newsite-article');
const ROUNDS = 3;

/** Phrases that mark text as generic AI writing (the plan's "AI slop" list and its relatives). */
export const BANNED_PHRASES: RegExp[] = [
  /\bin this (article|guide|post|blog post)\b/i,
  /\blet'?s dive in\b/i,
  /\bdive (deep )?into\b/i,
  /\bhave you ever wondered\b/i,
  /\bin conclusion\b/i,
  /\bin today'?s (fast[- ]paced )?world\b/i,
  /\bdelve\b/i,
  /\btapestry\b/i,
  /\bgame[- ]changer\b/i,
  /\blook no further\b/i,
  /\bunlock the (secrets?|power)\b/i,
  /\belevate your\b/i,
  /\bembark on\b/i,
  /\bit'?s important to note\b/i,
  /\bwhether you'?re a\b/i,
  /\bwithout further ado\b/i,
  /\ba testament to\b/i,
  /\bmouth[- ]watering\b/i,
  /\bculinary journey\b/i,
];

/** Ingredients the recipe check knows. One not in the recipe may not appear in its article. */
const INGREDIENTS = [
  'flour', 'sugar', 'butter', 'egg', 'milk', 'cream', 'cheese', 'yogurt', 'buttermilk', 'oil', 'salt', 'pepper',
  'vanilla', 'cinnamon', 'nutmeg', 'ginger', 'clove', 'cardamom', 'allspice', 'cocoa', 'chocolate', 'honey', 'syrup',
  'molasses', 'yeast', 'cornstarch', 'gelatin', 'lemon', 'lime', 'orange', 'apple', 'banana', 'strawberry', 'blueberry',
  'raspberry', 'cherry', 'peach', 'pumpkin', 'carrot', 'zucchini', 'potato', 'onion', 'garlic', 'tomato', 'spinach',
  'mushroom', 'pepperoni', 'chicken', 'beef', 'pork', 'bacon', 'ham', 'turkey', 'lamb', 'fish', 'salmon', 'tuna',
  'shrimp', 'rice', 'pasta', 'noodle', 'oat', 'oatmeal', 'almond', 'walnut', 'pecan', 'peanut', 'cashew', 'hazelnut',
  'pistachio', 'coconut', 'raisin', 'mascarpone', 'ricotta', 'mozzarella', 'parmesan', 'cheddar', 'avocado',
  'basil', 'parsley', 'cilantro', 'thyme', 'rosemary', 'oregano', 'mint', 'wine', 'beer', 'rum', 'vinegar', 'mayonnaise',
  'mustard', 'ketchup', 'soy', 'tofu', 'flax', 'chia', 'quinoa', 'lentil', 'bean', 'chickpea', 'corn', 'pea',
].map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

/** Plain-language check: an estimate of the US school grade needed to read the text. */
export function readingGrade(text: string): number {
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const ws = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (ws.length === 0) return 0;
  const syllables = ws.reduce((sum, w) => {
    const groups = w.toLowerCase().replace(/e\b/, '').match(/[aeiouy]+/g);
    return sum + Math.max(1, groups ? groups.length : 1);
  }, 0);
  return 0.39 * (ws.length / sentences) + 11.8 * (syllables / ws.length) - 15.59;
}

export const READING_GRADE_MAX = 8;

const bodyWords = (md: string): number =>
  md
    .split('\n')
    .filter((l) => !/^#{1,6}\s/.test(l))
    .join(' ')
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w)).length;

export const sectionTarget = (s: SkeletonSection): number => Math.max(s.words, s.h3.reduce((n, h) => n + h.words, 0));

/** The words this section may use: 70% to 140% of its target, never below 40. */
export const wordRange = (target: number): [number, number] => [Math.max(40, Math.round(target * 0.7)), Math.round(target * 1.4) + 40];

export interface SectionContext {
  section: SkeletonSection;
  first: boolean;
  focusKeyword: string;
  /**
   * Text of the recipe(s) the article may use, when it is held to a recipe,
   * plus the plan's keywords and the skeleton, whose words may also be used.
   */
  allowedText?: string;
  keyword: string;
}

/** Problems that may stay in the best attempt after the last round. */
export const isSoftProblem = (problem: string): boolean =>
  /^The section has \d+ words|^The writing is too hard to read/.test(problem);

/** What is wrong with one written section, in words the AI can act on. Empty when it passes. */
export function checkSection(md: string, ctx: SectionContext): string[] {
  const problems: string[] = [];
  const lines = md.split('\n').map((l) => l.trim());
  const h2s = lines.filter((l) => /^##\s/.test(l));
  const h3s = lines.filter((l) => /^###\s/.test(l)).map((l) => l.replace(/^###\s+/, ''));

  if (lines.some((l) => /^#\s/.test(l))) problems.push('Do not write an H1 (a line starting with "# ").');
  if (lines.find((l) => l) !== `## ${ctx.section.h2}`) problems.push(`Start with exactly this line: "## ${ctx.section.h2}".`);
  if (h2s.length > 1) problems.push('Write only this one H2 section; no other "## " headings.');
  const wanted = ctx.section.h3.map((h) => h.h3);
  if (JSON.stringify(h3s) !== JSON.stringify(wanted)) {
    problems.push(
      wanted.length
        ? `Use exactly these H3 headings, in this order: ${wanted.map((h) => `"### ${h}"`).join(', ')}.`
        : 'This section has no H3 headings; do not add any.',
    );
  }

  const n = bodyWords(md);
  const [min, max] = wordRange(sectionTarget(ctx.section));
  if (n < min || n > max) problems.push(`The section has ${n} words; write ${min} to ${max}.`);

  for (const pattern of BANNED_PHRASES) {
    const hit = md.match(pattern);
    if (hit) problems.push(`Remove the generic phrase "${hit[0]}" and say something specific instead.`);
  }

  const prose = lines.filter((l) => l && !/^#{1,6}\s/.test(l)).join(' ');
  const grade = readingGrade(prose);
  if (grade > READING_GRADE_MAX) {
    problems.push(`The writing is too hard to read (about grade ${Math.round(grade)}); use shorter sentences and simpler words.`);
  }

  if (ctx.first) {
    const opening = new Set(words(prose.split(/\s+/).slice(0, 120).join(' ')));
    if (!words(ctx.focusKeyword).every((w) => opening.has(w))) {
      problems.push(`Use the focus keyword "${ctx.focusKeyword}" naturally in the first 100 words.`);
    }
  }

  if (ctx.allowedText !== undefined) {
    const allowed = new Set([...words(ctx.allowedText), ...words(ctx.keyword)]);
    const used = new Set(words(prose));
    const invented = INGREDIENTS.filter((i) => used.has(i) && !allowed.has(i));
    if (invented.length) {
      problems.push(`These ingredients are not in the recipe; do not mention them: ${invented.join(', ')}.`);
    }
    const temps = prose.match(/\b\d{2,3}\s?°\s?[CF]?\b/g) ?? [];
    const badTemp = temps.find((t) => !ctx.allowedText!.includes(t.replace(/\s/g, '').replace('°', '').slice(0, 3)));
    if (badTemp) problems.push(`The temperature "${badTemp}" is not in the recipe; use the recipe's own.`);
  }
  return problems;
}

/* -- The writer step ----------------------------------------------------- */

export interface ArticleDeps {
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
}

interface Context {
  pillar: string;
  niche: string;
  niche_context: string;
  persona: string;
}

/** The section's markdown out of the model's answer, which may come wrapped in a code fence. */
export const cleanMarkdown = (raw: string): string =>
  raw
    .replace(/^\s*```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .replace(/\r/g, '')
    .trim();

/** Write one keyword's article, section by section, then done or failed. */
export async function writeArticle(row: SeoRow, deps: ArticleDeps): Promise<void> {
  const ctx = get<Context>(
    `SELECT p.pillar, w.niche, w.niche_context, w.persona
       FROM keyword_plans p JOIN new_websites w ON w.id = p.website_id WHERE p.id = ?`,
    row.plan_id,
  );
  const skeleton = row.skeleton_json ? parseSkeleton(row.skeleton_json) : null;
  if (!ctx || !skeleton) return;
  run(`UPDATE keyword_seo SET article_status = 'writing' WHERE id = ?`, row.id);

  const recipe: Recipe | null = row.recipe_json ? parseRecipe(row.recipe_json) : null;
  // A recipe page is held to its recipe. The pillar also discusses its
  // sub-pages' versions, so it may use their recipes' ingredients too.
  let allowedText: string | undefined;
  if (recipe) {
    allowedText = recipeText(recipe) + '\n' + recipe.notes;
    if (row.role === 'pillar') {
      for (const r of all<{ recipe_json: string }>(`SELECT recipe_json FROM keyword_seo WHERE plan_id = ? AND role = 'sub' AND recipe_json != ''`, row.plan_id)) {
        const sub = parseRecipe(r.recipe_json);
        if (sub) allowedText += '\n' + recipeText(sub) + '\n' + sub.notes;
      }
    }
  }

  if (allowedText !== undefined) {
    // The plan's own keywords and the skeleton are allowed too: a pillar names
    // its sub-pages, and a section may say what its heading says.
    const keywords = all<{ keyword: string }>('SELECT keyword FROM keyword_seo WHERE plan_id = ?', row.plan_id).map((r) => r.keyword);
    const outlineText = skeleton.sections.flatMap((s) => [s.h2, s.covers, ...s.keyPoints, ...s.h3.flatMap((h) => [h.h3, ...h.keyPoints])]);
    allowedText += '\n' + [ctx.pillar, ...keywords, ...outlineText].join('\n');
  }

  const outline = skeleton.sections.map((s) => s.h2);
  // Sections kept from an earlier attempt that stopped part-way: writing
  // carries on after them.
  const earlier = row.article_md ? row.article_md.split(/\n(?=## )/).map((p) => p.trim()) : [];
  const parts: string[] = [];
  let failure = '';

  for (const [i, section] of skeleton.sections.entries()) {
    const kept = earlier[i];
    if (kept && kept.split('\n')[0]!.trim() === `## ${section.h2}` && parts.length === i) {
      parts.push(kept);
      continue;
    }
    const target = sectionTarget(section);
    const [min, max] = wordRange(target);
    let problems: string[] = [];
    let text = '';
    let best: { text: string; problems: string[] } | null = null;
    for (let round = 0; round < ROUNDS; round++) {
      let raw: string;
      try {
        raw = await deps.ask('article-section', {
          keyword: row.keyword,
          role: row.role === 'pillar' ? 'the pillar page' : 'a sub-page of the pillar',
          pillar: ctx.pillar,
          title: row.title,
          focusKeyword: row.focus_keyword,
          niche: ctx.niche,
          nicheContext: ctx.niche_context || '(none)',
          persona: ctx.persona,
          outlineJson: JSON.stringify(outline),
          position:
            i === 0
              ? 'the FIRST section: it opens the article, so use the focus keyword naturally in the first 100 words'
              : i === skeleton.sections.length - 1
                ? 'the LAST section of the article'
                : `section ${i + 1} of ${skeleton.sections.length}`,
          sectionJson: JSON.stringify(section),
          wordRange: `${min} to ${max} words (target ${target})`,
          previousEnding: parts.length ? parts[parts.length - 1]!.slice(-500) : '(this is the first section)',
          recipeJson: recipe ? JSON.stringify(recipe) : '(no fixed recipe for this page)',
          problemsJson: JSON.stringify(problems),
        });
      } catch (err) {
        log.warn(`AI#3 could not reach the AI for "${row.keyword}": ${errorMessage(err)}`);
        problems = ['The AI could not be reached. Check the AI keys on the Platform page.'];
        break;
      }
      text = cleanMarkdown(raw);
      problems = checkSection(text, { section, first: i === 0, focusKeyword: row.focus_keyword, allowedText, keyword: row.keyword });
      if (problems.length === 0) break;
      const hard = problems.filter((p) => !isSoftProblem(p)).length;
      if (!best || hard < best.problems.filter((p) => !isSoftProblem(p)).length || (hard === 0 && problems.length < best.problems.length)) {
        best = { text, problems };
      }
    }
    // Only soft problems left: keep the best attempt and go on.
    if (problems.length && best && best.problems.every(isSoftProblem)) {
      log.info(`AI#3 kept "${section.h2}" for "${row.keyword}" with: ${best.problems.join(' ')}`);
      text = best.text;
      problems = [];
    }
    if (problems.length) {
      failure = [`Section "${section.h2}":`, ...problems].join('\n');
      break;
    }
    parts.push(text);
  }

  const md = parts.join('\n\n');
  run(
    `UPDATE keyword_seo SET article_status = ?, article_md = ?, article_words = ?, article_problems = ? WHERE id = ?`,
    failure ? 'failed' : 'done',
    md,
    bodyWords(md),
    failure,
    row.id,
  );
}
