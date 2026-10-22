import { createLogger, errorMessage } from '../lib/logger.js';
import type { SitePost } from './client.js';
import { findSubKeywords, MAX_SUBS, pillarProblem, type Existing, type FindDeps } from './keywords.js';
import {
  addPlanItems,
  getKeywordPlan,
  getNewWebsite,
  listKeywordPlans,
  saveKeywordPlan,
  setPlanImport,
  websiteApiKey,
  type KeywordPlan,
  type NewWebsiteRow,
  type PlanItem,
} from './repo.js';
import { get, all, run } from '../db/index.js';
import { listPlanSeo, queueMissingSeo, queuePlanSeo } from './seo.js';
import { articleTypeFor } from './skeleton.js';

/**
 * Keywords from a CSV file: many main keywords at once, each for its own
 * website.
 *
 * Only two columns are needed: the main keyword and the target website (its
 * domain). A niche and sub-keywords may be given too. Each row becomes a
 * keyword plan of its website, exactly like one made by hand, so the whole
 * pipeline (SEO, recipe, skeleton, article, images, publish, share) runs on
 * it and publishes to that website. A row with fewer than six sub-keywords
 * keeps them and has the rest found by the platform's own finder (Google + the
 * AI, shown the given ones as examples), one plan at a time, and then goes on
 * like any other.
 */

const log = createLogger('newsite-import');

/* -- Reading the file ---------------------------------------------------- */

/** CSV text as rows of cells: quotes, doubled quotes, commas, semicolons or tabs, any line ending. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  // The separator the header uses most: Excel in some countries writes semicolons.
  const sep = [',', ';', '\t'].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

type Column = 'keyword' | 'website' | 'niche' | 'subs';

/** Header names people write, for each column. */
const HEADERS: Record<Column, string[]> = {
  keyword: ['main keyword', 'mainkeyword', 'main_keyword', 'keyword', 'pillar', 'pillar keyword', 'main'],
  website: ['target website', 'targetwebsite', 'target_website', 'website', 'domain', 'site', 'target', 'target domain'],
  niche: ['niche', 'topic', 'category'],
  subs: ['subkeywords', 'sub keywords', 'sub-keywords', 'sub_keywords', 'subkeyword', 'sub keyword', 'related keywords', 'secondary keywords', 'other keywords', 'other keyword', 'otherkeywords', 'other_keywords', 'other-keywords'],
};

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Which column is which, from the header row; null when the header has no keyword or website column. */
export function mapHeader(header: string[]): Partial<Record<Column, number>> {
  const map: Partial<Record<Column, number>> = {};
  header.forEach((h, i) => {
    const name = norm(h);
    for (const col of Object.keys(HEADERS) as Column[]) {
      if (map[col] === undefined && HEADERS[col].includes(name)) map[col] = i;
    }
  });
  return map;
}

/** A website address as the platform stores it: no scheme, no www, no path. */
export const cleanDomain = (raw: string): string =>
  raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/\.$/, '');

/** Sub-keywords in one cell: split on ; or | (or commas, when the cell has nothing else). */
export function splitSubs(cell: string): string[] {
  const text = cell.trim();
  if (!text) return [];
  const parts = /[;|\n]/.test(text) ? text.split(/[;|\n]/) : text.split(',');
  return parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/* -- Checking it --------------------------------------------------------- */

export interface ImportRow {
  /** The line in the file (the header is line 1). */
  line: number;
  keyword: string;
  domain: string;
  websiteId: number | null;
  websiteName: string;
  niche: string;
  subs: string[];
  /** Why this row cannot be imported. */
  errors: string[];
  /** Imported, but worth knowing. */
  notes: string[];
}

export interface ImportCheck {
  /** A problem with the whole file (no header, no rows); nothing can be imported. */
  fileError: string;
  rows: ImportRow[];
}

const keywordProblem = (k: string): string | null => {
  if (!k) return 'The main keyword is empty.';
  if (k.length < 3 || k.length > 80) return 'The main keyword must be 3 to 80 characters.';
  if (!/\p{L}/u.test(k)) return 'The main keyword must contain words.';
  return null;
};

export interface CheckDeps {
  websites: NewWebsiteRow[];
  /** The posts already on a website, to catch a keyword it already covers. */
  listPosts: (site: NewWebsiteRow) => Promise<SitePost[]>;
}

/**
 * Every row checked before anything is saved: the two required columns, the
 * website is one of the platform's, no repeats in the file, nothing the
 * website already has (as a plan or a post). Niche and sub-keywords are never
 * required.
 */
export async function checkImport(csv: string, deps: CheckDeps): Promise<ImportCheck> {
  const table = parseCsv(csv);
  if (!table.length) return { fileError: 'The file is empty.', rows: [] };
  const map = mapHeader(table[0]!);
  if (map.keyword === undefined || map.website === undefined) {
    return {
      fileError: 'The first line must name the columns, with at least "Main Keyword" and "Target Website" (Niche and Subkeywords are optional).',
      rows: [],
    };
  }
  if (table.length < 2) return { fileError: 'The file has its column names but no keywords under them.', rows: [] };

  const byDomain = new Map(deps.websites.map((w) => [cleanDomain(w.domain), w]));
  const seen = new Map<string, number>();
  const rows: ImportRow[] = table.slice(1).map((cells, i) => {
    const cellOf = (col: Column) => (map[col] === undefined ? '' : (cells[map[col]!] ?? '').replace(/\s+/g, ' ').trim());
    const keyword = cellOf('keyword');
    const domain = cleanDomain(cellOf('website'));
    const site = byDomain.get(domain);
    const row: ImportRow = {
      line: i + 2,
      keyword,
      domain,
      websiteId: site?.id ?? null,
      websiteName: site?.name ?? '',
      niche: cellOf('niche').slice(0, 60),
      subs: [],
      errors: [],
      notes: [],
    };
    const bad = keywordProblem(keyword);
    if (bad) row.errors.push(bad);
    if (!domain) row.errors.push('The target website is empty.');
    else if (!site) row.errors.push(`“${domain}” is not one of your websites. Add it on the Websites page, or fix the address.`);

    // Sub-keywords as given: repeats and the main keyword itself are left out.
    const subs: string[] = [];
    let dropped = 0;
    for (const s of map.subs === undefined ? [] : splitSubs(cells[map.subs] ?? '')) {
      const k = s.slice(0, 100);
      if (norm(k) === norm(keyword) || subs.some((x) => norm(x) === norm(k))) dropped++;
      else subs.push(k);
    }
    row.subs = subs;
    if (dropped) row.notes.push(`${dropped} repeated sub-keyword${dropped === 1 ? '' : 's'} left out.`);
    if (!subs.length && !row.errors.length) row.notes.push('No sub-keywords: the platform finds them.');
    else if (subs.length < MAX_SUBS && !row.errors.length) {
      row.notes.push(`${subs.length} sub-keyword${subs.length === 1 ? '' : 's'} kept: the platform adds up to ${MAX_SUBS - subs.length} more like them.`);
    }

    if (site && keyword) {
      const key = `${site.id}|${norm(keyword)}`;
      const first = seen.get(key);
      if (first) row.errors.push(`The same keyword for the same website is already on line ${first}.`);
      else seen.set(key, row.line);
    }
    return row;
  });

  // What each website already has: its saved plans, and its posts.
  for (const site of deps.websites) {
    const mine = rows.filter((r) => r.websiteId === site.id && !r.errors.length);
    if (!mine.length) continue;
    const planned = new Set(listKeywordPlans(site.id).map((p) => norm(p.pillar)));
    let posts: Existing[] = [];
    try {
      posts = (await deps.listPosts(site)).filter((p) => p.title).map((p) => ({ label: `the post “${p.title}”`, text: p.title }));
    } catch (err) {
      for (const r of mine) r.notes.push(`${site.domain}’s posts could not be read (${errorMessage(err)}), so they were not checked for repeats.`);
    }
    for (const r of mine) {
      if (planned.has(norm(r.keyword))) {
        r.errors.push(`${site.name} already has a keyword plan for “${r.keyword}”.`);
        continue;
      }
      const covered = posts.length ? pillarProblem(r.keyword, posts) : null;
      if (covered) r.errors.push(covered);
    }
  }
  return { fileError: '', rows };
}

/* -- Saving it ------------------------------------------------------------- */

/**
 * Save every row without errors as a keyword plan of its website. Rows with
 * six or more sub-keywords go straight to the SEO step; the others keep theirs
 * and wait for the finder to add more.
 */
export function importRows(rows: ImportRow[]): { plans: number; finding: number } {
  let plans = 0;
  let finding = 0;
  for (const r of rows) {
    if (r.errors.length || !r.websiteId) continue;
    const site = getNewWebsite(r.websiteId);
    if (!site) continue;
    const recipeSite = articleTypeFor(site.niche) === 'recipe';
    const page: 'recipe' | 'article' = recipeSite ? 'recipe' : 'article';
    const items: PlanItem[] = r.subs.map((k) => ({ keyword: k, intent: 'yours', reason: 'From your CSV file', page }));
    const planId = saveKeywordPlan(site.id, r.keyword, items, page);
    const full = items.length >= MAX_SUBS;
    setPlanImport(planId, { niche: r.niche, source: 'csv', subsStatus: full ? '' : 'finding' });
    if (full) queuePlanSeo(planId, r.keyword, items, page);
    else finding++;
    plans++;
  }
  return { plans, finding };
}

/* -- Finding the missing sub-keywords ---------------------------------------- */

export interface FinderDeps extends FindDeps {
  encryptionKey: Buffer;
  listPosts: (domain: string, apiKey: string) => Promise<SitePost[]>;
  /** Wakes the SEO writer once a plan is ready for it. */
  startSeo: () => void;
}

/** What a new keyword must not repeat: the website's posts and its saved plans. */
export async function existingKeywords(site: NewWebsiteRow, deps: Pick<FinderDeps, 'listPosts' | 'encryptionKey'>, exceptPlan = 0): Promise<Existing[]> {
  const posts = await deps.listPosts(site.domain, websiteApiKey(site, deps.encryptionKey));
  const saved = listKeywordPlans(site.id)
    .filter((plan) => plan.id !== exceptPlan)
    .flatMap((plan) => [
      { label: `the saved plan “${plan.pillar}”`, text: plan.pillar },
      ...plan.items.map((i) => ({ label: `“${i.keyword}” in the plan for “${plan.pillar}”`, text: i.keyword })),
    ]);
  return [...posts.filter((p) => p.title).map((p) => ({ label: `the post “${p.title}”`, text: p.title })), ...saved];
}

/**
 * One plan's sub-keywords, found with the same finder as a plan made by hand,
 * using the plan's own niche when it has one. Sub-keywords already in the plan
 * (from the CSV file) stay, and the finder only adds more like them. Whatever
 * happens, the main keyword goes on to the SEO step: missing sub-keywords
 * never stop it.
 */
export async function findSubsForPlan(plan: KeywordPlan, deps: FinderDeps): Promise<void> {
  const site = getNewWebsite(plan.website_id);
  if (!site) return;
  const given = plan.items;
  // A plan imported before sub-keywords were topped up may be written already: its pillar page stays as it is.
  const started = listPlanSeo(plan.id).some((r) => r.role === 'pillar');
  let items: PlanItem[] = [];
  let pillarPage = plan.pillar_page;
  let error = '';
  try {
    const found = await findSubKeywords(
      { pillar: plan.pillar, niche: plan.niche || site.niche, nicheContext: site.niche_context, existing: await existingKeywords(site, deps, plan.id), language: site.language, given: given.map((i) => i.keyword) },
      { suggest: deps.suggest, ask: deps.ask },
    );
    if (found.ok) {
      const recipeSite = articleTypeFor(site.niche) === 'recipe';
      pillarPage = recipeSite ? found.pillarPage : 'article';
      items = found.kept.map((k) => ({ keyword: k.keyword, intent: k.intent, reason: k.reason, page: recipeSite ? k.page : 'article' }));
      if (!items.length && !given.length) error = 'The finder kept no sub-keyword for it.';
    } else error = found.error;
  } catch (err) {
    error = errorMessage(err);
  }
  if (started) pillarPage = plan.pillar_page;
  if (items.length) addPlanItems(plan.id, items, pillarPage);
  // With the owner's own sub-keywords the plan is never empty, so it is not a failure.
  const ok = items.length > 0 || given.length > 0;
  setPlanImport(plan.id, { subsStatus: ok ? '' : 'failed', subsError: ok ? '' : error.slice(0, 400) });
  if (error && given.length) log.warn(`No extra sub-keywords for plan ${plan.id}, kept its ${given.length}: ${error}`);
  queueMissingSeo(plan.id, plan.pillar, [...given, ...items], pillarPage);
  deps.startSeo();
}

/**
 * Recheck, pressed on a website's card of the Keywords page (never by
 * itself): every main keyword of the website with fewer than six
 * sub-keywords goes back to the finder, which keeps the ones it has and adds
 * similar ones up to six. What is already written stays as it is; the new
 * sub-keywords join the line after the plan's others. Returns how many main
 * keywords were sent back.
 */
export function recheckSubs(websiteId: number): number {
  return Number(
    run(
      `UPDATE keyword_plans SET subs_status = 'finding', subs_error = ''
        WHERE website_id = ? AND subs_status IN ('', 'failed')
          AND (SELECT COUNT(*) FROM keyword_plan_items i WHERE i.plan_id = keyword_plans.id) < ?`,
      websiteId,
      MAX_SUBS,
    ).changes,
  );
}

let finding: Promise<void> | null = null;

/** Find sub-keywords for every imported plan waiting for them, one at a time. */
export function kickSubFinder(deps: FinderDeps): Promise<void> {
  if (finding) return finding;
  finding = (async () => {
    const tried = new Set<number>();
    for (;;) {
      const next = get<{ id: number }>(`SELECT id FROM keyword_plans WHERE subs_status = 'finding' ORDER BY id LIMIT 1`);
      if (!next || tried.has(next.id)) break;
      tried.add(next.id);
      const plan = getKeywordPlan(next.id);
      if (!plan) continue;
      try {
        await findSubsForPlan(plan, deps);
      } catch (err) {
        log.error(`Finding sub-keywords for plan ${plan.id} failed: ${errorMessage(err)}`);
        setPlanImport(plan.id, { subsStatus: 'failed', subsError: errorMessage(err).slice(0, 400) });
      }
    }
  })().finally(() => {
    finding = null;
  });
  return finding;
}

/* -- The Keywords page's numbers ------------------------------------------- */

export interface PlanStats {
  planId: number;
  seoDone: number;
  articles: number;
  published: number;
  total: number;
}

/** Per plan, how far its keywords have got: one query for the whole platform. */
export function planStats(): Map<number, PlanStats> {
  const rows = all<PlanStats>(
    `SELECT plan_id AS planId,
            SUM(status = 'done') AS seoDone,
            SUM(article_status = 'done') AS articles,
            SUM(post_status = 'published') AS published,
            COUNT(*) AS total
       FROM keyword_seo GROUP BY plan_id`,
  );
  return new Map(rows.map((r) => [r.planId, r]));
}
