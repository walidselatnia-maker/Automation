import { get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { words } from '../seo/rules.js';
import type { SeoRow } from './seo.js';

/**
 * AI#2: the article skeleton for one keyword, made after its AI#1 metadata.
 *
 * The AI designs the structure; there is no template. Code only checks the
 * plan's general rules (H1 is the SEO title, an opening and a closing section,
 * the focus keyword in a heading without stuffing, realistic word counts).
 */

const log = createLogger('newsite-skeleton');
const ROUNDS = 3;

export const H2_COUNT = [4, 10] as const;
export const TOTAL_WORDS = [700, 3000] as const;
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
  /recipe|food|cook|bak|kitchen|meal|dessert|dinner|drink|cuisine/i.test(niche) ? 'recipe' : 'guide';

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

const OPENING = /why|what|intro|overview|about|matters|before you|quick look|at a glance/i;
const CLOSING = /faq|frequently asked|questions|final|conclusion|wrap|next step|get started|try it|takeaway/i;

const hasAllWords = (heading: string, phrase: string): boolean => {
  const have = new Set(words(heading));
  const need = words(phrase);
  return need.length > 0 && need.every((w) => have.has(w));
};

/** What is wrong, in words the AI can act on. Empty when it passes. */
export function checkSkeleton(k: Skeleton, ctx: { title: string; focusKeyword: string }): string[] {
  const problems: string[] = [];
  if (k.h1 !== ctx.title) problems.push(`The H1 must be exactly the SEO title: "${ctx.title}".`);

  const n = k.sections.length;
  if (n < H2_COUNT[0] || n > H2_COUNT[1]) problems.push(`There are ${n} H2 sections; use ${H2_COUNT[0]} to ${H2_COUNT[1]}.`);
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

  for (const s of k.sections) {
    if (s.keyPoints.length < 2) problems.push(`The section "${s.h2}" needs at least 2 key points.`);
    const w = sectionWords(s);
    if (w < SECTION_WORDS[0] || w > SECTION_WORDS[1]) {
      problems.push(`The section "${s.h2}" targets ${w} words; use ${SECTION_WORDS[0]} to ${SECTION_WORDS[1]}.`);
    }
  }
  const total = totalWords(k);
  if (total < TOTAL_WORDS[0] || total > TOTAL_WORDS[1]) {
    problems.push(`The article totals ${total} words; aim for ${TOTAL_WORDS[0]} to ${TOTAL_WORDS[1]}.`);
  }
  return problems;
}

/* -- The writer step ----------------------------------------------------- */

export interface SkeletonDeps {
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
}

interface Context {
  pillar: string;
  niche: string;
  niche_context: string;
  persona: string;
}

/** Make one keyword's skeleton: up to three rounds, then done or failed. */
export async function makeSkeleton(row: SeoRow, deps: SkeletonDeps): Promise<void> {
  const ctx = get<Context>(
    `SELECT p.pillar, w.niche, w.niche_context, w.persona
       FROM keyword_plans p JOIN new_websites w ON w.id = p.website_id WHERE p.id = ?`,
    row.plan_id,
  );
  if (!ctx) return;
  const type = articleTypeFor(ctx.niche);
  run(`UPDATE keyword_seo SET skeleton_status = 'writing', article_type = ? WHERE id = ?`, type, row.id);

  let problems: string[] = [];
  let last: Skeleton | null = null;
  for (let round = 0; round < ROUNDS; round++) {
    let raw: string;
    try {
      raw = await deps.ask('article-skeleton', {
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
        problemsJson: JSON.stringify(problems),
      });
    } catch (err) {
      log.warn(`AI#2 could not reach the AI for "${row.keyword}": ${errorMessage(err)}`);
      problems = ['The AI could not be reached. Check the AI keys on the Platform page.'];
      break;
    }
    last = parseSkeleton(raw);
    if (last) last.h1 = last.h1 || row.title;
    problems = last ? checkSkeleton(last, { title: row.title, focusKeyword: row.focus_keyword }) : ['The AI answer could not be read.'];
    if (problems.length === 0) break;
  }

  run(
    `UPDATE keyword_seo SET skeleton_status = ?, skeleton_json = ?, skeleton_problems = ? WHERE id = ?`,
    problems.length ? 'failed' : 'done',
    last ? JSON.stringify(last) : '',
    problems.join('\n'),
    row.id,
  );
}
