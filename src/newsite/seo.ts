import { all, get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { similarity, words } from '../seo/rules.js';
import { articleTypeFor, makeSkeleton } from './skeleton.js';
import { makeRecipe } from './recipe.js';
import { writeArticle } from './article.js';

/**
 * AI#1: SEO metadata for every keyword in a saved keyword plan.
 *
 * Runs in the background after a plan is saved, one keyword at a time. The
 * AI writes; the checks below decide. A failed check is sent back to the AI
 * with the exact problems, up to three rounds.
 */

const log = createLogger('newsite-seo');

export const TITLE = [50, 60] as const;
export const DESCRIPTION = [150, 160] as const;
export const ALT_WORDS = [8, 12] as const;
export const EEAT = ['Expertise', 'Experience', 'Authority', 'Trustworthiness'] as const;
const ROUNDS = 3;

const BANNED = [
  /article about/i,
  /everything you need to know/i,
  /this article will/i,
  /in this (guide|article|post)/i,
  /let'?s dive in/i,
  /have you ever wondered/i,
];

export interface SeoAnswer {
  title: string;
  description: string;
  focusKeyword: string;
  altText: string;
  eeat: string;
  confidence: string;
  reasoning: string;
}

export interface SeoContext {
  keyword: string;
  /** Real autocomplete searches for the keyword. */
  searches: string[];
  /** Titles already written for other keywords in the plan. */
  otherTitles: string[];
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** The model's JSON as an answer, whatever wrapper it came in. */
export function parseSeoAnswer(raw: string): SeoAnswer | null {
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
  // "experience (tested)" -> Experience; matched on the whole first word, as
  // Expertise and Experience share their first five letters.
  const first = clean(o.eeat).toLowerCase().match(/[a-z]+/)?.[0] ?? '';
  return {
    title: clean(o.title),
    description: clean(o.description),
    focusKeyword: clean(o.focusKeyword ?? o.focus_keyword),
    altText: clean(o.altText ?? o.alt_text),
    eeat: EEAT.find((e) => first.length >= 5 && e.toLowerCase().startsWith(first)) ?? clean(o.eeat),
    confidence: clean(o.confidence).toLowerCase(),
    reasoning: clean(o.reasoning),
  };
}

/** Every content word of `phrase` appears in `text` (plurals count as the same word). */
const hasAllWords = (text: string, phrase: string): boolean => {
  const have = new Set(words(text));
  return words(phrase).every((w) => have.has(w));
};

const count = (text: string, phrase: string): number =>
  phrase ? text.toLowerCase().split(phrase.toLowerCase()).length - 1 : 0;

/** What is wrong with an answer, in words the AI can act on. Empty when it passes. */
export function checkSeo(a: SeoAnswer, ctx: SeoContext): string[] {
  const problems: string[] = [];
  const focus = a.focusKeyword.toLowerCase();
  const allowed = [ctx.keyword, ...ctx.searches].map((s) => s.trim().toLowerCase());

  if (!a.focusKeyword) problems.push('The focus keyword is missing.');
  else if (!allowed.includes(focus)) {
    problems.push(`The focus keyword must be "${ctx.keyword}" or one of the autocomplete searches, copied exactly.`);
  }

  if (a.title.length < TITLE[0] || a.title.length > TITLE[1]) {
    problems.push(`The title is ${a.title.length} characters; it must be ${TITLE[0]} to ${TITLE[1]}.`);
  }
  if (a.focusKeyword && !hasAllWords(a.title, a.focusKeyword)) problems.push('The title must contain the focus keyword.');
  if (/\b[A-Z]{4,}\b/.test(a.title)) problems.push('The title has a word in all caps.');
  if (a.title.includes('!')) problems.push('The title must not use exclamation marks.');
  const twin = ctx.otherTitles.find((t) => t.toLowerCase() === a.title.toLowerCase() || similarity(t, a.title) >= 0.8);
  if (twin) problems.push(`The title is too close to "${twin}", already used in this plan.`);

  if (a.description.length < DESCRIPTION[0] || a.description.length > DESCRIPTION[1]) {
    problems.push(`The description is ${a.description.length} characters; it must be ${DESCRIPTION[0]} to ${DESCRIPTION[1]}.`);
  }
  if (a.focusKeyword && !hasAllWords(a.description, a.focusKeyword)) {
    problems.push('The description must contain the focus keyword.');
  } else if (count(a.description, a.focusKeyword) > 1) {
    problems.push('The description repeats the focus keyword; use it once.');
  }

  for (const pattern of BANNED) {
    const hit = `${a.title} ${a.description}`.match(pattern);
    if (hit) problems.push(`Remove the filler phrase "${hit[0]}".`);
  }

  const altWords = a.altText.split(/\s+/).filter(Boolean).length;
  if (altWords < ALT_WORDS[0] || altWords > ALT_WORDS[1]) {
    problems.push(`The alt text is ${altWords} words; it must be ${ALT_WORDS[0]} to ${ALT_WORDS[1]}.`);
  }
  if (/^(an? )?(image|picture|photo) of\b/i.test(a.altText)) problems.push('The alt text must not start with "image of".');

  if (!(EEAT as readonly string[]).includes(a.eeat)) {
    problems.push('The E-E-A-T signal must be Expertise, Experience, Authority or Trustworthiness.');
  }
  return problems;
}

/* -- Storage ------------------------------------------------------------- */

export interface SeoRow {
  id: number;
  plan_id: number;
  keyword: string;
  role: 'pillar' | 'sub';
  position: number;
  status: 'pending' | 'writing' | 'done' | 'failed';
  title: string;
  description: string;
  focus_keyword: string;
  alt_text: string;
  eeat: string;
  confidence: string;
  reasoning: string;
  problems: string;
  skeleton_status: '' | 'pending' | 'writing' | 'done' | 'failed';
  article_type: string;
  skeleton_json: string;
  skeleton_problems: string;
  recipe_status: '' | 'pending' | 'writing' | 'done' | 'failed';
  recipe_json: string;
  recipe_problems: string;
  page: 'recipe' | 'article';
  article_status: '' | 'pending' | 'writing' | 'done' | 'failed';
  article_md: string;
  article_words: number;
  article_problems: string;
}

/** One waiting row per keyword: the pillar first, then the sub-keywords in order. */
export function queuePlanSeo(
  planId: number,
  pillar: string,
  subs: (string | { keyword: string; page?: 'recipe' | 'article' })[],
  pillarPage: 'recipe' | 'article' = 'recipe',
): void {
  run(`INSERT INTO keyword_seo (plan_id, keyword, role, position, page) VALUES (?, ?, 'pillar', 0, ?)`, planId, pillar, pillarPage);
  subs.forEach((sub, i) => {
    const { keyword, page } = typeof sub === 'string' ? { keyword: sub, page: 'recipe' as const } : sub;
    run(`INSERT INTO keyword_seo (plan_id, keyword, role, position, page) VALUES (?, ?, 'sub', ?, ?)`, planId, keyword, i + 1, page ?? 'recipe');
  });
}

export const listPlanSeo = (planId: number): SeoRow[] =>
  all<SeoRow>('SELECT * FROM keyword_seo WHERE plan_id = ? ORDER BY position', planId);

export const getSeoRow = (id: number): SeoRow | undefined =>
  get<SeoRow>('SELECT * FROM keyword_seo WHERE id = ?', id);

/** Write one again: back in the queue, its old result cleared. */
export function requeueSeo(id: number): void {
  run(
    `UPDATE keyword_seo SET status = 'pending', problems = '', updated_at = datetime('now') WHERE id = ? AND status != 'writing'`,
    id,
  );
}

/** A restart mid-write leaves rows marked writing: they go back in the queue. */
export function resetInterruptedSeo(): void {
  run(`UPDATE keyword_seo SET status = 'pending' WHERE status = 'writing'`);
  run(`UPDATE keyword_seo SET skeleton_status = 'pending' WHERE skeleton_status = 'writing'`);
  run(`UPDATE keyword_seo SET recipe_status = 'pending' WHERE recipe_status = 'writing'`);
  run(`UPDATE keyword_seo SET article_status = 'pending' WHERE article_status = 'writing'`);
}

/** Write one article again, from the skeleton it has. */
export function requeueArticle(id: number): void {
  run(
    `UPDATE keyword_seo SET article_status = 'pending', article_problems = '' WHERE id = ? AND skeleton_status = 'done' AND article_status != 'writing'`,
    id,
  );
}

/** Make one recipe again. Its skeleton is remade after it, from the new recipe. */
export function requeueRecipe(id: number): void {
  run(
    `UPDATE keyword_seo SET recipe_status = 'pending', recipe_problems = '', skeleton_status = '', skeleton_json = '', skeleton_problems = '',
       article_status = '', article_md = '', article_words = 0, article_problems = ''
     WHERE id = ? AND status = 'done' AND recipe_status != 'writing' AND page != 'article'`,
    id,
  );
}

/** Make one skeleton again, from the metadata it has. */
export function requeueSkeleton(id: number): void {
  run(
    `UPDATE keyword_seo SET skeleton_status = 'pending', skeleton_problems = '', article_status = '', article_md = '', article_words = 0, article_problems = ''
     WHERE id = ? AND status = 'done' AND skeleton_status != 'writing'`,
    id,
  );
}

/* -- The writer ---------------------------------------------------------- */

export interface WriterDeps {
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
  /** Real autocomplete searches for one keyword. */
  suggest: (keyword: string) => Promise<string[]>;
}

interface PlanContext {
  pillar: string;
  niche: string;
  niche_context: string;
  persona: string;
}

const planContext = (planId: number): PlanContext | undefined =>
  get<PlanContext>(
    `SELECT p.pillar, w.niche, w.niche_context, w.persona
       FROM keyword_plans p JOIN new_websites w ON w.id = p.website_id
      WHERE p.id = ?`,
    planId,
  );

/** Write the metadata for one row: up to three rounds, then done or failed. */
export async function writeOne(row: SeoRow, deps: WriterDeps): Promise<void> {
  const plan = planContext(row.plan_id);
  if (!plan) return;
  run(`UPDATE keyword_seo SET status = 'writing', updated_at = datetime('now') WHERE id = ?`, row.id);

  const searches = (await deps.suggest(row.keyword).catch(() => [])).slice(0, 40);
  const otherTitles = listPlanSeo(row.plan_id)
    .filter((r) => r.id !== row.id && r.title)
    .map((r) => r.title);
  const ctx: SeoContext = { keyword: row.keyword, searches, otherTitles };

  let problems: string[] = [];
  let last: SeoAnswer | null = null;
  for (let round = 0; round < ROUNDS; round++) {
    let raw: string;
    try {
      raw = await deps.ask('seo-metadata', {
        keyword: row.keyword,
        role: row.role === 'pillar' ? 'the pillar page' : 'a sub-page of the pillar',
        pillar: plan.pillar,
        niche: plan.niche,
        nicheContext: plan.niche_context || '(none)',
        persona: plan.persona,
        searchesJson: JSON.stringify(searches),
        takenTitlesJson: JSON.stringify(otherTitles),
        problemsJson: JSON.stringify(problems),
      });
    } catch (err) {
      log.warn(`AI#1 could not reach the AI for "${row.keyword}": ${errorMessage(err)}`);
      problems = ['The AI could not be reached. Check the AI keys on the Platform page.'];
      break;
    }
    last = parseSeoAnswer(raw);
    problems = last ? checkSeo(last, ctx) : ['The AI answer could not be read.'];
    if (problems.length === 0) break;
  }

  // Only a recipe page on a recipe website gets a fixed recipe.
  const isRecipe = articleTypeFor(plan.niche) === 'recipe' && row.page !== 'article';
  const a = last ?? { title: '', description: '', focusKeyword: '', altText: '', eeat: '', confidence: '', reasoning: '' };
  run(
    `UPDATE keyword_seo SET status = ?, title = ?, description = ?, focus_keyword = ?, alt_text = ?, eeat = ?,
       confidence = ?, reasoning = ?, problems = ?, updated_at = datetime('now'),
       skeleton_status = ?, skeleton_json = '', skeleton_problems = '',
       recipe_status = ?, recipe_json = '', recipe_problems = '',
       article_status = '', article_md = '', article_words = 0, article_problems = ''
     WHERE id = ?`,
    problems.length ? 'failed' : 'done',
    a.title,
    a.description,
    a.focusKeyword,
    a.altText,
    a.eeat,
    a.confidence,
    a.reasoning,
    problems.join('\n'),
    // New metadata means new work after it: on a recipe website the recipe
    // comes next and the skeleton waits for it; elsewhere the skeleton is next.
    problems.length || isRecipe ? '' : 'pending',
    problems.length || !isRecipe ? '' : 'pending',
    row.id,
  );
}

let running: Promise<void> | null = null;

/**
 * Work through every waiting row, one at a time. Calling it while it runs
 * does nothing extra: the running pass picks up rows added meanwhile.
 */
export function kickSeoWriter(deps: WriterDeps): Promise<void> {
  if (running) return running;
  // Started on the next tick, so `running` is set before the loop can finish
  // and clear it. (Done the other way round, an empty queue cleared it first
  // and the writer then looked busy forever.)
  running = Promise.resolve()
    .then(async () => {
      for (;;) {
        // AI#1 first, so every keyword of a plan has its title before any
        // skeleton is made; then AI#2 on the keywords whose metadata is done.
        const next = get<SeoRow>(`SELECT * FROM keyword_seo WHERE status = 'pending' ORDER BY plan_id, position LIMIT 1`);
        if (next) {
          try {
            await writeOne(next, deps);
          } catch (err) {
            log.error(`AI#1 failed on "${next.keyword}": ${errorMessage(err)}`);
            run(`UPDATE keyword_seo SET status = 'failed', problems = ? WHERE id = ?`, 'Something went wrong while writing. Try again.', next.id);
          }
          continue;
        }
        const dish = get<SeoRow>(
          `SELECT * FROM keyword_seo WHERE status = 'done' AND recipe_status = 'pending' ORDER BY plan_id, position LIMIT 1`,
        );
        if (dish) {
          try {
            await makeRecipe(dish, deps);
          } catch (err) {
            log.error(`Recipe failed on "${dish.keyword}": ${errorMessage(err)}`);
            run(`UPDATE keyword_seo SET recipe_status = 'failed', recipe_problems = ? WHERE id = ?`, 'Something went wrong while making the recipe. Try again.', dish.id);
          }
          continue;
        }
        const outline = get<SeoRow>(
          `SELECT * FROM keyword_seo WHERE status = 'done' AND skeleton_status = 'pending' ORDER BY plan_id, position LIMIT 1`,
        );
        if (outline) {
          try {
            await makeSkeleton(outline, deps);
          } catch (err) {
            log.error(`AI#2 failed on "${outline.keyword}": ${errorMessage(err)}`);
            run(`UPDATE keyword_seo SET skeleton_status = 'failed', skeleton_problems = ? WHERE id = ?`, 'Something went wrong while making the skeleton. Try again.', outline.id);
          }
          continue;
        }
        const piece = get<SeoRow>(
          `SELECT * FROM keyword_seo WHERE skeleton_status = 'done' AND article_status = 'pending' ORDER BY plan_id, position LIMIT 1`,
        );
        if (!piece) break;
        try {
          await writeArticle(piece, deps);
        } catch (err) {
          log.error(`AI#3 failed on "${piece.keyword}": ${errorMessage(err)}`);
          run(`UPDATE keyword_seo SET article_status = 'failed', article_problems = ? WHERE id = ?`, 'Something went wrong while writing the article. Try again.', piece.id);
        }
      }
    })
    .finally(() => {
      running = null;
    });
  return running;
}
