import { all, get, run } from '../db/index.js';
import { articleChat } from '../llm/gemini.js';
import { loadTemplate } from '../pipeline/prompts.js';
import { planLanguage } from './repo.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { words } from '../seo/rules.js';
import type { SeoRow } from './seo.js';
import { correctUntilRight, keptNote } from './rounds.js';
import { parseRecipe, type Recipe } from './recipe.js';

/**
 * AI#2: the article skeleton for one keyword, made after its AI#1 metadata.
 *
 * The AI designs the structure; there is no template. Code only checks the
 * plan's general rules (H1 is the SEO title, an opening and a closing section,
 * the focus keyword in a heading without stuffing, realistic word counts).
 *
 * The prompt has three parts (opening, main sections, closing), each with a
 * few versions written in different styles. Each article gets one version
 * of each part, never the one its website used last for that part, so the
 * articles of a website do not all read the same.
 */

const log = createLogger('newsite-skeleton');

/**
 * The pillar is the hub: the longest, deepest page, covering the whole topic
 * and touching every sub-topic so it can link to each one. A sub-page goes
 * deep on one narrow angle and is shorter.
 */
export const LIMITS = {
  pillar: { h2: [7, 14], words: [2000, 4500] },
  sub: { h2: [4, 8], words: [800, 1800] },
} as const;
export const SECTION_WORDS = [30, 900] as const;
const HEADING_MAX = 70;

export interface SkeletonSub {
  h3: string;
  keyPoints: string[];
  words: number;
}

export interface SkeletonSection {
  h2: string;
  covers: string;
  keyPoints: string[];
  words: number;
  h3: SkeletonSub[];
}

export interface Skeleton {
  h1: string;
  sections: SkeletonSection[];
}

export type ArticleType = 'recipe' | 'guide';

/** A food website writes recipes; everything else writes guides. */
export const articleTypeFor = (niche: string): ArticleType =>
  /recipe|food|cook|bak|kitchen|meal|dessert|dinner|drink|cuisine|recett|recet|ricett|rezept|receit|cocin|cucin|küche|koch|pâtiss|patiss|gâteau|gateau|postre|dolci|طبخ|وصف|حلو|مطبخ/i.test(niche) ? 'recipe' : 'guide';

const text = (v: unknown, max = 300): string =>
  (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max);
const points = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((p) => text(p, 240)).filter(Boolean).slice(0, 10) : [];
const num = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The model's JSON as a skeleton, whatever wrapper it came in. */
export function parseSkeleton(raw: string): Skeleton | null {
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
  const o = value as { h1?: unknown; sections?: unknown } | null;
  if (!o || !Array.isArray(o.sections)) return null;
  return {
    h1: text(o.h1),
    sections: (o.sections as Record<string, unknown>[]).map((s) => ({
      h2: text(s?.h2),
      covers: text(s?.covers),
      keyPoints: points(s?.keyPoints),
      words: num(s?.words),
      h3: (Array.isArray(s?.h3) ? (s.h3 as Record<string, unknown>[]) : []).map((h) => ({
        h3: text(h?.h3),
        keyPoints: points(h?.keyPoints),
        words: num(h?.words),
      })),
    })),
  };
}

/** Section words: its own count, or its H3s added up when it only gives those. */
const sectionWords = (s: SkeletonSection): number =>
  Math.max(s.words, s.h3.reduce((sum, h) => sum + h.words, 0));

export const totalWords = (k: Skeleton): number => k.sections.reduce((sum, s) => sum + sectionWords(s), 0);

/** The words of a sub-keyword that are not already in the pillar: what makes it its own topic. */
const ownWords = (sub: string, pillar: string): string[] => {
  const base = new Set(words(pillar));
  return words(sub).filter((w) => !base.has(w));
};

/**
 * Things done to a dish, as word stems, and how to say each. A keyword with
 * one of these is about that action, not about making the dish.
 */
const ACTION_NAMES: Record<string, string> = {
  decorat: 'decorating', frost: 'frosting', icing: 'icing', piping: 'piping', glaz: 'glazing', stor: 'storing',
  freez: 'freezing', reheat: 'reheating', thaw: 'thawing', transport: 'transporting', slic: 'slicing', cut: 'cutting',
  fix: 'fixing', substitut: 'substituting', assembl: 'assembling', stack: 'stacking', level: 'leveling', wrap: 'wrapping',
};
const actionsIn = (keyword: string): string[] =>
  Object.keys(ACTION_NAMES).filter((stem) => words(keyword).some((w) => w.startsWith(stem)));

const OPENING = /why|what|intro|overview|about|matters|before you|quick look|at a glance/i;
const CLOSING = /faq|frequently asked|questions|final|conclusion|wrap|next step|get started|try it|takeaway/i;

const hasAllWords = (heading: string, phrase: string): boolean => {
  const have = new Set(words(heading));
  const need = words(phrase);
  return need.length > 0 && need.every((w) => have.has(w));
};

/** What is wrong, in words the AI can act on. Empty when it passes. */
export interface SkeletonContext {
  title: string;
  focusKeyword: string;
  /** The planned keyword: what the article must be about. */
  keyword?: string;
  role: 'pillar' | 'sub';
  /** For the pillar: its plan's sub-keywords, each of which it must touch. */
  pillar?: string;
  subKeywords?: string[];
  /** On a recipe website: the fixed recipe the outline is built from. */
  recipe?: Recipe | null;
}

export function checkSkeleton(k: Skeleton, ctx: SkeletonContext): string[] {
  const problems: string[] = [];
  const limits = LIMITS[ctx.role];
  if (k.h1 !== ctx.title) problems.push(`The H1 must be exactly the SEO title: "${ctx.title}".`);

  const n = k.sections.length;
  if (n === 0) return ['The outline has no sections. Answer with the full outline: every H2 section with its key points and word count.'];
  const kind = ctx.role === 'pillar' ? 'The pillar' : 'A sub-page';
  if (n < limits.h2[0] || n > limits.h2[1]) {
    problems.push(`There are ${n} H2 sections; ${kind.toLowerCase()} needs ${limits.h2[0]} to ${limits.h2[1]}.`);
  }
  if (n && !OPENING.test(k.sections[0]!.h2)) problems.push('The first H2 must introduce the topic or say why it matters.');
  if (n && !CLOSING.test(k.sections[n - 1]!.h2)) problems.push('The last H2 must be an FAQ or a closing call to action.');

  const headings = k.sections.flatMap((s) => [s.h2, ...s.h3.map((h) => h.h3)]);
  if (headings.some((h) => !h)) problems.push('Every H2 and H3 needs a heading.');
  const long = headings.find((h) => h.length > HEADING_MAX);
  if (long) problems.push(`The heading "${long}" is over ${HEADING_MAX} characters.`);
  const seen = new Set<string>();
  for (const h of headings) {
    const key = h.toLowerCase();
    if (seen.has(key)) problems.push(`The heading "${h}" is used twice.`);
    seen.add(key);
  }

  const early = k.sections.flatMap((s, i) => [s.h2, ...(i < 3 ? s.h3.slice(0, 2).map((h) => h.h3) : [])]);
  if (!early.some((h) => hasAllWords(h, ctx.focusKeyword))) {
    problems.push(`Use the focus keyword "${ctx.focusKeyword}" naturally in one H2 or an early H3.`);
  }
  const stuffed = headings.filter((h) => hasAllWords(h, ctx.focusKeyword)).length;
  if (stuffed > 2) problems.push(`The focus keyword is in ${stuffed} headings; keep it to one or two.`);

  // The article answers its keyword. When the keyword is about doing
  // something to the dish (decorating, frosting, storing...), that action runs
  // through at least half the outline: an article for "how to decorate a
  // strawberry cake" whose sections are about baking one fails here.
  if (ctx.keyword && n) {
    const sectionText = k.sections.map((s) => words([s.h2, s.covers, ...s.keyPoints, ...s.h3.flatMap((h) => [h.h3, ...h.keyPoints])].join(' ')));
    const need = Math.ceil(n / 2);
    for (const stem of actionsIn(ctx.keyword)) {
      const hits = sectionText.filter((ws) => ws.some((x) => x.startsWith(stem))).length;
      if (hits < need) {
        problems.push(
          `The outline drifts from the keyword "${ctx.keyword}": it is about ${ACTION_NAMES[stem]}, but that comes up in only ${hits} of ${n} sections. Most sections (at least ${need}) must be about ${ACTION_NAMES[stem]}; drop or rework the ones about other things (like making the dish from scratch).`,
        );
      }
    }
  }

  for (const s of k.sections) {
    if (s.keyPoints.length < 2) problems.push(`The section "${s.h2}" needs at least 2 key points.`);
    const w = sectionWords(s);
    if (w < SECTION_WORDS[0] || w > SECTION_WORDS[1]) {
      problems.push(`The section "${s.h2}" targets ${w} words; use ${SECTION_WORDS[0]} to ${SECTION_WORDS[1]}.`);
    }
  }
  const total = totalWords(k);
  if (total < limits.words[0] || total > limits.words[1]) {
    problems.push(`The article totals ${total} words; ${kind.toLowerCase()} needs ${limits.words[0]} to ${limits.words[1]}.`);
  }

  // The pillar carries its own full recipe as extra content, at the end and
  // just before the closing FAQ.
  if (ctx.role === 'pillar' && ctx.recipe && n >= 2 && !/recipe/i.test(k.sections[n - 2]!.h2)) {
    problems.push('The pillar must have the full recipe as its second-to-last H2 (just before the last H2), with "recipe" in the heading.');
  }

  // The pillar is the hub: every sub-topic gets at least a mention, so the
  // pillar can link down to each sub-page.
  if (ctx.role === 'pillar' && ctx.subKeywords?.length) {
    const outline = new Set(
      words(k.sections.flatMap((sec) => [sec.h2, sec.covers, ...sec.keyPoints, ...sec.h3.flatMap((h) => [h.h3, ...h.keyPoints])]).join(' ')),
    );
    for (const subKeyword of ctx.subKeywords) {
      const own = ownWords(subKeyword, ctx.pillar ?? '');
      if (own.length && !own.every((w) => outline.has(w))) {
        problems.push(`The pillar must cover the sub-topic "${subKeyword}" in a heading or key point, so it can link to that page.`);
      }
    }
  }
  return problems;
}

/* -- Outline styles ------------------------------------------------------ */

export const SKELETON_PARTS = [
  { key: 'opening', name: 'Outline opening', about: 'How the article opens: its first section.' },
  { key: 'body', name: 'Outline main sections', about: 'How the middle of the article is built.' },
  { key: 'closing', name: 'Outline closing', about: 'How the article ends: its last sections.' },
] as const;
export type SkeletonPart = (typeof SKELETON_PARTS)[number]['key'];
export type SkeletonStyles = Record<SkeletonPart, number>;
/** How many versions each part has. */
export const SKELETON_VERSIONS = 4;

/** The prompt file of one version of one part. */
export const styleFile = (part: SkeletonPart, version: number): string => `article-skeleton.${part}-${version}.template.txt`;

const readStyles = (raw: string | null | undefined): Partial<SkeletonStyles> => {
  try {
    const o = JSON.parse(raw || '{}') as Record<string, unknown>;
    return Object.fromEntries(SKELETON_PARTS.map((p) => [p.key, Number(o[p.key]) || 0]).filter(([, v]) => v)) as Partial<SkeletonStyles>;
  } catch {
    return {};
  }
};

/**
 * One version per part for a new article of a website: any version with
 * text, except the one the website used last for that part (when there is
 * another to pick).
 */
export function pickSkeletonStyles(websiteId: number, random: () => number = Math.random): SkeletonStyles {
  const last = readStyles(get<{ skeleton_last: string }>('SELECT skeleton_last FROM new_websites WHERE id = ?', websiteId)?.skeleton_last);
  const picked = {} as SkeletonStyles;
  for (const { key } of SKELETON_PARTS) {
    const usable = Array.from({ length: SKELETON_VERSIONS }, (_, i) => i + 1).filter((v) => loadTemplate(styleFile(key, v), {}).trim());
    const fresh = usable.filter((v) => v !== last[key]);
    const from = fresh.length ? fresh : usable.length ? usable : [1];
    picked[key] = from[Math.min(from.length - 1, Math.floor(random() * from.length))]!;
  }
  return picked;
}

/** A keyword's outline styles: the ones it was given before (a remake keeps them), or a new pick for its website. */
function stylesFor(row: SeoRow, websiteId: number, random?: () => number): SkeletonStyles {
  const kept = readStyles(row.skeleton_styles);
  if (SKELETON_PARTS.every((p) => kept[p.key])) return kept as SkeletonStyles;
  const picked = pickSkeletonStyles(websiteId, random);
  const json = JSON.stringify(picked);
  run('UPDATE keyword_seo SET skeleton_styles = ? WHERE id = ?', json, row.id);
  run('UPDATE new_websites SET skeleton_last = ? WHERE id = ?', json, websiteId);
  return picked;
}

/* -- The writer step ----------------------------------------------------- */

export interface SkeletonDeps {
  ask: (promptName: string, variables: Record<string, unknown>, chat?: string) => Promise<string>;
  /** Picks the outline styles (tests); Math.random by default. */
  random?: () => number;
}

interface Context {
  website_id: number;
  pillar: string;
  niche: string;
  niche_context: string;
  persona: string;
}

/** Make one keyword's skeleton, correcting mistakes until it passes (rounds.ts). */
export async function makeSkeleton(row: SeoRow, deps: SkeletonDeps): Promise<void> {
  const ctx = get<Context>(
    `SELECT p.website_id, p.pillar, w.niche, w.niche_context, w.persona
       FROM keyword_plans p JOIN new_websites w ON w.id = p.website_id WHERE p.id = ?`,
    row.plan_id,
  );
  if (!ctx) {
    run(`UPDATE keyword_seo SET skeleton_status = 'failed', skeleton_problems = 'Its keyword plan or website is gone.' WHERE id = ?`, row.id);
    return;
  }
  const type: ArticleType = articleTypeFor(ctx.niche) === 'recipe' && row.page !== 'article' ? 'recipe' : 'guide';
  run(`UPDATE keyword_seo SET skeleton_status = 'writing', article_type = ? WHERE id = ?`, type, row.id);

  const subKeywords =
    row.role === 'pillar'
      ? all<{ keyword: string }>(`SELECT keyword FROM keyword_seo WHERE plan_id = ? AND role = 'sub' ORDER BY position`, row.plan_id).map((r) => r.keyword)
      : [];
  const limits = LIMITS[row.role];
  const recipe = row.recipe_json ? parseRecipe(row.recipe_json) : null;
  const styles = stylesFor(row, ctx.website_id, deps.random);
  const style = (part: SkeletonPart) => loadTemplate(styleFile(part, styles[part]), {}).trim();
  const depth =
    row.role === 'pillar'
      ? `This is the PILLAR: the hub of the topic and the longest, deepest page of the plan. Cover the whole topic thoroughly, ` +
        `${limits.h2[0]} to ${limits.h2[1]} H2 sections and ${limits.words[0]} to ${limits.words[1]} words in total. ` +
        `Give each sub-keyword below its own short section or key point (a summary that a link to its page will follow), ` +
        `without repeating their full content.`
      : `This is a SUB-PAGE: one narrow angle of the pillar, covered in depth. ${limits.h2[0]} to ${limits.h2[1]} H2 sections ` +
        `and ${limits.words[0]} to ${limits.words[1]} words in total. Stay on this angle; the pillar covers the broad topic.`;

  const outcome = await correctUntilRight<Skeleton>({
    ask: (corrections) =>
      deps.ask('article-skeleton', {
        language: planLanguage(row.plan_id),
        keyword: row.keyword,
        role: row.role === 'pillar' ? 'the pillar page' : 'a sub-page of the pillar',
        pillar: ctx.pillar,
        articleType: type,
        title: row.title,
        description: row.description,
        focusKeyword: row.focus_keyword,
        niche: ctx.niche,
        nicheContext: ctx.niche_context || '(none)',
        persona: ctx.persona,
        depth,
        subKeywordsJson: JSON.stringify(subKeywords),
        recipeJson: recipe ? JSON.stringify(recipe) : '(no fixed recipe: this is not a recipe website)',
        openingPart: style('opening'),
        bodyPart: style('body'),
        closingPart: style('closing'),
        problemsJson: corrections,
      }, articleChat(row.id)),
    parse: (raw) => {
      const k = parseSkeleton(raw);
      if (k) k.h1 = k.h1 || row.title;
      return k;
    },
    check: (k) => checkSkeleton(k, { title: row.title, focusKeyword: row.focus_keyword, keyword: row.keyword, role: row.role, pillar: ctx.pillar, subKeywords, recipe }),
    onError: (err) => log.warn(`AI#2 could not reach the AI for "${row.keyword}": ${errorMessage(err)}`),
  });
  const { problems, technical } = outcome;
  const last = outcome.answer;

  run(
    `UPDATE keyword_seo SET skeleton_status = ?, skeleton_json = ?, skeleton_problems = ?,
       article_status = ?, article_md = '', article_words = 0, article_problems = '',
       images_status = '', images_json = '', images_problems = '' WHERE id = ?`,
    technical ? 'failed' : 'done',
    last ? JSON.stringify(last) : '',
    technical ? problems.join('\n') : keptNote(problems),
    // The article is written from the skeleton, so it follows it.
    technical ? '' : 'pending',
    row.id,
  );
}
