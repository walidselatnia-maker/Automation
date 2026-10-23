import { all, get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { listCategories, saveCategoryIntro, type Fetch } from './client.js';
import { getNewWebsite, listNewWebsites, websiteApiKey } from './repo.js';

/**
 * The intro of a website category page, the hub of its topic: the category
 * ranks for the broad search, its articles for their own narrower ones.
 *
 * Written by the AI once a category holds 3 published articles. Rewritten only
 * when a new pillar has been published in it since, and only when the last
 * text is at least 30 days old; several new pillars in a month make one
 * rewrite. Nothing else ever changes it. The text goes to the website, where
 * it can also be edited by hand in the category's Intro box.
 */

const log = createLogger('newsite-category-intros');

export const INTRO_MIN_ARTICLES = 3;
export const INTRO_REWRITE_DAYS = 30;
const MIN_WORDS = 100;
const MAX_WORDS = 240;
const TRIES = 3;

interface Article {
  id: number;
  role: 'pillar' | 'sub';
  title: string;
  keyword: string;
}

interface IntroRow {
  written_at: string;
  pillar_ids: string;
}

export interface IntroDeps {
  encryptionKey: Buffer;
  ask?: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
  fetchImpl?: Fetch;
  now?: () => number;
}

/** The articles this platform published in one category of a website, oldest first. */
function categoryArticles(websiteId: number, category: string): Article[] {
  return all<Article>(
    `SELECT s.id, s.role, s.title, s.focus_keyword AS keyword FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id
      WHERE p.website_id = ? AND s.post_status = 'published' AND lower(s.post_category) = lower(?)
      ORDER BY s.posted_at, s.id`,
    websiteId,
    category,
  );
}

const introRow = (websiteId: number, category: string): IntroRow | undefined =>
  get<IntroRow>('SELECT written_at, pillar_ids FROM newsite_category_intros WHERE website_id = ? AND category = ?', websiteId, category.toLowerCase());

/** SQLite's datetime('now') is UTC without a zone. */
const parseUtc = (s: string): number => Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);

/** Whether the category's intro is due: its first one, a rewrite for a new pillar, or none. */
export function introDue(websiteId: number, category: string, now = Date.now()): 'first' | 'rewrite' | null {
  if (!category) return null;
  const articles = categoryArticles(websiteId, category);
  if (articles.length < INTRO_MIN_ARTICLES) return null;
  const row = introRow(websiteId, category);
  if (!row) return 'first';
  const covered = new Set((JSON.parse(row.pillar_ids || '[]') as number[]).map(Number));
  if (!articles.some((a) => a.role === 'pillar' && !covered.has(a.id))) return null;
  return now - parseUtc(row.written_at) >= INTRO_REWRITE_DAYS * 86_400_000 ? 'rewrite' : null;
}

/** What is wrong with an intro, in words the AI is given back. Empty when it is right. */
export function introProblems(text: string): string[] {
  const problems: string[] = [];
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS || words > MAX_WORDS) problems.push(`Write 120 to 200 words; this has ${words}.`);
  if (/^\s*(#|[-*] |\d+\. )/m.test(text)) problems.push('Plain paragraphs only: no headings and no lists.');
  if (/https?:\/\/|\[[^\]]*\]\(/.test(text)) problems.push('No links.');
  return problems;
}

/** The AI's answer as plain paragraphs: no Markdown emphasis, at most one blank line between them. */
const cleanIntro = (raw: string): string =>
  raw
    .replace(/\*\*|__/g, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');

/** Two keys of the same category never write at the same time. */
const writing = new Set<string>();

/** Writes (or rewrites) one category's intro when it is due. Never throws. Answers whether it wrote one. */
export async function refreshCategoryIntro(websiteId: number, category: string, deps: IntroDeps): Promise<boolean> {
  const key = `${websiteId}:${category.toLowerCase()}`;
  if (!deps.ask || writing.has(key)) return false;
  const now = (deps.now ?? Date.now)();
  if (!introDue(websiteId, category, now)) return false;
  const site = getNewWebsite(websiteId);
  if (!site) return false;
  writing.add(key);
  try {
    const apiKey = websiteApiKey(site, deps.encryptionKey);
    const onSite = (await listCategories(site.domain, apiKey, deps.fetchImpl)).find((c) => c.name.toLowerCase() === category.toLowerCase());
    if (!onSite?.slug) return false;
    const articles = categoryArticles(websiteId, category);
    const pillars = articles.filter((a) => a.role === 'pillar');
    const brief = (a: Article) => ({ title: a.title, keyword: a.keyword });
    let problems: string[] = [];
    let text = '';
    for (let i = 0; i < TRIES; i++) {
      text = cleanIntro(
        await deps.ask('category-intro', {
          language: site.language || 'English',
          niche: site.niche,
          nicheContext: site.niche_context || '(none)',
          persona: site.persona,
          category: onSite.name,
          pillarsJson: JSON.stringify(pillars.map(brief)),
          articlesJson: JSON.stringify(articles.filter((a) => a.role !== 'pillar').map(brief)),
          problemsJson: JSON.stringify(problems),
        }),
      );
      problems = introProblems(text);
      if (!problems.length) break;
    }
    if (problems.length) {
      log.warn(`The intro of "${onSite.name}" on ${site.domain} is not right after ${TRIES} tries: ${problems.join(' ')}`);
      return false;
    }
    await saveCategoryIntro(site.domain, apiKey, { name: onSite.name, slug: onSite.slug, intro: text }, deps.fetchImpl);
    run(
      `INSERT INTO newsite_category_intros (website_id, category, written_at, pillar_ids) VALUES (?, ?, datetime(? / 1000, 'unixepoch'), ?)
        ON CONFLICT (website_id, category) DO UPDATE SET written_at = excluded.written_at, pillar_ids = excluded.pillar_ids`,
      websiteId,
      category.toLowerCase(),
      now,
      JSON.stringify(pillars.map((p) => p.id)),
    );
    log.info(`Wrote the intro of "${onSite.name}" on ${site.domain}.`);
    return true;
  } catch (err) {
    log.warn(`Could not write the intro of "${category}" on ${site.domain}: ${errorMessage(err)}`);
    return false;
  } finally {
    writing.delete(key);
  }
}

/** An article was published: its category's intro, if that is now due. */
export function afterArticlePublished(seoId: number, deps: IntroDeps): Promise<boolean> {
  const row = get<{ website_id: number; post_category: string }>(
    'SELECT p.website_id, s.post_category FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id WHERE s.id = ?',
    seoId,
  );
  return row?.post_category ? refreshCategoryIntro(row.website_id, row.post_category, deps) : Promise.resolve(false);
}

/** Every category of every website, one at a time: catches up categories that were already full before intros existed. */
export async function syncCategoryIntros(deps: IntroDeps): Promise<number> {
  let written = 0;
  for (const site of listNewWebsites()) {
    const categories = all<{ category: string }>(
      `SELECT DISTINCT s.post_category AS category FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id
        WHERE p.website_id = ? AND s.post_status = 'published' AND s.post_category <> ''`,
      site.id,
    );
    for (const { category } of categories) if (await refreshCategoryIntro(site.id, category, deps)) written += 1;
  }
  return written;
}
