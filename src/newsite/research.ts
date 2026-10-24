import { all, get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { SitePost } from './client.js';
import { duplicateOf, normalizeTitle, type Taken } from './duplicates.js';
import { importRows, type ImportRow } from './keyword-import.js';
import { asPage, type PageKind } from './keywords.js';
import { getNewWebsite, listKeywordPlans, websiteApiKey, type NewWebsiteRow } from './repo.js';
import { askSearch, type Locale, type SearchDeps, type SearchPage } from './search-keys.js';
import { LANGUAGE_CODES } from './validate.js';

/**
 * Content research: from a niche or topic to an approved plan of pillar and
 * sub-article keywords for one website, built on real Google data. The owner
 * gives only the website and the niche; Discover topics runs every step below
 * by itself, the page showing which one it is on (PHASES).
 *
 * 1. Fetch: Google's autocomplete for the topic, and its results page (the
 *    top results, People Also Ask, related searches), through the search
 *    keys (search-keys.ts).
 * 2. Expand: autocomplete again for up to EXPAND discovered searches, so the
 *    number of calls stays known (each project shows its counts).
 * 3. Clean: each search once; the ones that repeat the website's keywords,
 *    saved plans or published posts are dropped (the duplicate check of
 *    duplicates.ts), with why.
 * 4. Group: the AI groups the real searches into pillars with their
 *    sub-articles (the keyword-research prompt, on the Prompts page). It may
 *    add a keyword of its own; every keyword is marked as real search data or
 *    AI-made. Nothing appears twice in the plan.
 * 5. The owner edits the tree (rename, remove, move a sub to another pillar,
 *    add one) and approves it: each pillar with its subs goes into the
 *    website's Keywords list exactly like a row of the CSV import
 *    (keyword-import.ts), and Automation takes it from there.
 *
 * A project is saved after every answer, with every answer kept: stopping,
 * failing or changing search keys mid-way never repeats a call or loses what
 * was found. Resume carries on from the first call not made.
 */

const log = createLogger('newsite-research');

/** How many discovered searches get their own autocomplete call. */
export const EXPAND = 8;
/** At most this many pillars, and subs under one pillar. */
const MAX_PILLARS = 12;
const MAX_SUBS_EACH = 12;

export type Source = 'autocomplete' | 'question' | 'related';
/** Where a keyword in the plan came from: real search data, the AI, or typed by the owner. */
export type Origin = 'real' | 'ai' | 'yours';

export interface Found {
  keyword: string;
  sources: Source[];
}

export interface PlanSub {
  keyword: string;
  origin: Origin;
}

export interface PlanPillar {
  pillar: string;
  origin: Origin;
  page: PageKind;
  subs: PlanSub[];
}

export interface ResearchState {
  /** Every search answer, by "autocomplete:query" or "search:query": never asked twice. */
  calls: Record<string, string[] | SearchPage>;
  /** Calls made through the search keys, by provider (answers kept count once). */
  made: Record<string, number>;
  found: Found[];
  dropped: { keyword: string; reason: string }[];
  /** Keywords the AI or an edit put in the plan that were left out, with why. */
  left: { keyword: string; reason: string }[];
  plan: PlanPillar[];
  /** What went wrong last, when the project stopped. */
  error: string;
  /** After approval: what went into the Keywords list. */
  approved?: { plans: number; skipped: string[] };
  /** Keywords the owner deleted from the plan: the sub-keyword finder never adds them back. */
  removed?: string[];
  /** While it runs: which of the PHASES it is on (1 to 4), and what it is doing, in words. */
  progress?: { phase: number; text: string };
}

/** The steps of a research, as the page lists them while it runs. */
export const PHASES = ['Google searches for the niche', 'Deeper searches on what was found', 'Check against the website', 'AI groups pillars and sub-articles'];

export type ResearchStatus = 'new' | 'fetching' | 'grouping' | 'ready' | 'failed' | 'approved';

export interface ResearchRow {
  id: number;
  website_id: number;
  topic: string;
  status: ResearchStatus;
  state_json: string;
  created_at: string;
  updated_at: string;
}

/** A project's state; a new one each time, never shared. */
const empty = (): ResearchState => ({ calls: {}, made: {}, found: [], dropped: [], left: [], plan: [], error: '' });

export function stateOf(row: Pick<ResearchRow, 'state_json'>): ResearchState {
  try {
    return { ...empty(), ...(JSON.parse(row.state_json || '{}') as Partial<ResearchState>) };
  } catch {
    return empty();
  }
}

export const getResearch = (id: number): ResearchRow | undefined => get<ResearchRow>('SELECT * FROM newsite_research WHERE id = ?', id);
export const listResearch = (): ResearchRow[] => all<ResearchRow>('SELECT * FROM newsite_research ORDER BY id DESC');

function save(id: number, status: ResearchStatus, state: ResearchState): void {
  run(`UPDATE newsite_research SET status = ?, state_json = ?, updated_at = datetime('now') WHERE id = ?`, status, JSON.stringify(state), id);
}

/** A new project for a website. Returns its id. */
export function createResearch(websiteId: number, topic: string): number {
  return Number(run('INSERT INTO newsite_research (website_id, topic) VALUES (?, ?)', websiteId, topic.replace(/\s+/g, ' ').trim().slice(0, 120)).lastInsertRowid);
}

export const deleteResearch = (id: number): void => {
  run('DELETE FROM newsite_research WHERE id = ?', id);
};

/* -- What the website has already ---------------------------------------------- */

/** The website's keywords, saved plans and published posts: what the plan must not repeat. */
function takenOf(site: NewWebsiteRow, posts: SitePost[]): Taken[] {
  const rows = all<{ keyword: string; title: string; post_url: string }>(
    `SELECT s.keyword, s.title, s.post_url FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id WHERE p.website_id = ? AND s.skip_reason = ''`,
    site.id,
  );
  const plans = listKeywordPlans(site.id).flatMap((plan) => [plan.pillar, ...plan.items.map((i) => i.keyword)]);
  return [
    ...rows.map((r) => ({ label: r.post_url ? `“${r.title || r.keyword}” (${r.post_url})` : `“${r.keyword}” in the Keywords list`, texts: [r.keyword, r.title].filter(Boolean) })),
    ...plans.map((k) => ({ label: `“${k}” in the Keywords list`, texts: [k] })),
    ...posts.filter((p) => p.title && (!p.status || p.status === 'published')).map((p) => ({ label: `the post “${p.title}”`, texts: [p.title] })),
  ];
}

/* -- Running it --------------------------------------------------------------------- */

export interface ResearchDeps extends SearchDeps {
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
  /** The website's posts, for the duplicate check; a website that cannot be read is no reason to stop. */
  listPosts: (domain: string, apiKey: string) => Promise<SitePost[]>;
}

const callKey = (kind: 'autocomplete' | 'search', query: string): string => `${kind}:${query.toLowerCase()}`;

/** Projects being run right now. */
const running = new Set<number>();
export const isRunning = (id: number): boolean => running.has(id);

/**
 * Run a project from where it is: the calls not made yet, then the grouping.
 * Safe to call again (Resume): what is saved is never asked again.
 */
export async function runResearch(id: number, deps: ResearchDeps): Promise<void> {
  const row = getResearch(id);
  if (!row || row.status === 'approved' || running.has(id)) return;
  const site = getNewWebsite(row.website_id);
  const state = stateOf(row);
  if (!site) {
    state.error = 'Its website is gone.';
    return save(id, 'failed', state);
  }
  running.add(id);
  try {
    state.error = '';
    save(id, 'fetching', state);
    const locale: Locale = { hl: LANGUAGE_CODES[site.language || 'English'] ?? 'en' };
    const step = (phase: number, text: string, status: ResearchStatus = 'fetching') => {
      state.progress = { phase, text };
      save(id, status, state);
    };
    const ask = async (kind: 'autocomplete' | 'search', query: string, phase: number, text: string): Promise<void> => {
      const k = callKey(kind, query);
      if (state.calls[k]) return;
      step(phase, text);
      const { answer, provider } = await askSearch(kind, query, locale, deps);
      state.calls[k] = answer;
      state.made[provider] = (state.made[provider] ?? 0) + 1;
      save(id, 'fetching', state);
    };

    try {
      await ask('autocomplete', row.topic, 1, `Google’s suggestions for “${row.topic}”`);
      await ask('search', row.topic, 1, 'Top results, People Also Ask and related searches');
      const terms = expansionTerms(row.topic, state);
      for (const [i, term] of terms.entries()) await ask('autocomplete', term, 2, `${i + 1} of ${terms.length}: “${term}”`);
    } catch (err) {
      state.error = errorMessage(err);
      return save(id, 'failed', state);
    }

    step(3, `The keywords and articles of ${site.name}`);
    let posts: SitePost[] = [];
    try {
      posts = await deps.listPosts(site.domain, websiteApiKey(site, deps.encryptionKey));
    } catch (err) {
      log.warn(`Research ${id}: the posts of ${site.domain} could not be read, so only its keyword list was checked: ${errorMessage(err)}`);
    }
    const taken = takenOf(site, posts);
    const { found, dropped } = cleanFound(row.topic, state, taken);
    state.found = found;
    state.dropped = dropped;
    if (!found.length) {
      state.error = 'Google gave no searches for this topic that the website does not have yet. Try a broader topic.';
      return save(id, 'failed', state);
    }

    step(4, `${found.length} searches into pillar articles and their sub-articles`, 'grouping');
    let raw: string;
    try {
      raw = await deps.ask('keyword-research', {
        language: site.language || 'English',
        topic: row.topic,
        niche: site.niche,
        nicheContext: site.niche_context || '(none)',
        searchesJson: JSON.stringify(found.map((f) => ({ keyword: f.keyword, from: f.sources }))),
        resultsJson: JSON.stringify(topResults(row.topic, state)),
        existingJson: JSON.stringify(taken.flatMap((t) => t.texts).slice(0, 300)),
      });
    } catch (err) {
      state.error = `The AI could not be reached: ${errorMessage(err)}`;
      return save(id, 'failed', state);
    }
    const { plan, left } = cleanPlan(parsePlan(raw), found, taken);
    state.left = left;
    if (!plan.length) {
      state.error = 'The AI gave no plan that could be read. Press Resume to ask again.';
      return save(id, 'failed', state);
    }
    state.plan = plan;
    delete state.progress;
    save(id, 'ready', state);
  } finally {
    running.delete(id);
  }
}

/** The searches worth their own autocomplete call: the topic's suggestions and related searches, best first, at most EXPAND. */
export function expansionTerms(topic: string, state: ResearchState): string[] {
  const ac = (state.calls[callKey('autocomplete', topic)] as string[] | undefined) ?? [];
  const page = state.calls[callKey('search', topic)] as SearchPage | undefined;
  const seen = new Set([normalizeTitle(topic)]);
  const out: string[] = [];
  for (const t of [...ac, ...(page?.related ?? [])]) {
    const n = normalizeTitle(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
    if (out.length >= EXPAND) break;
  }
  return out;
}

const topResults = (topic: string, state: ResearchState): string[] =>
  ((state.calls[callKey('search', topic)] as SearchPage | undefined)?.results ?? []).slice(0, 10).map((r) => r.title);

/** Every real search found, each once, minus the ones the website already has. */
export function cleanFound(topic: string, state: ResearchState, taken: Taken[]): { found: Found[]; dropped: { keyword: string; reason: string }[] } {
  const byKey = new Map<string, Found>();
  const add = (keyword: string, source: Source) => {
    const k = keyword.replace(/\s+/g, ' ').trim();
    const n = normalizeTitle(k);
    if (!n || k.length > 100) return;
    const had = byKey.get(n);
    if (had) {
      if (!had.sources.includes(source)) had.sources.push(source);
    } else byKey.set(n, { keyword: k, sources: [source] });
  };
  for (const [key, answer] of Object.entries(state.calls)) {
    if (key.startsWith('autocomplete:')) for (const s of answer as string[]) add(s, 'autocomplete');
    else {
      const page = answer as SearchPage;
      for (const q of page.questions ?? []) add(q, 'question');
      for (const r of page.related ?? []) add(r, 'related');
    }
  }
  if (!byKey.has(normalizeTitle(topic))) add(topic, 'autocomplete');
  const found: Found[] = [];
  const dropped: { keyword: string; reason: string }[] = [];
  for (const f of byKey.values()) {
    const dup = duplicateOf({ keyword: f.keyword }, taken);
    if (dup) dropped.push({ keyword: f.keyword, reason: dup });
    else found.push(f);
  }
  return { found, dropped };
}

/** The AI's answer as pillars and subs, whatever wrapper it came in. */
export function parsePlan(raw: string): { pillar: string; page: PageKind; subs: string[] }[] {
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
  const pillars = (value as { pillars?: unknown } | null)?.pillars;
  if (!Array.isArray(pillars)) return [];
  const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 100) : '');
  return pillars.map((p: Record<string, unknown>) => ({
    pillar: text(p?.pillar),
    page: asPage(p?.page),
    subs: (Array.isArray(p?.subs) ? p.subs : []).map((s: unknown) => text(typeof s === 'string' ? s : (s as Record<string, unknown>)?.keyword)),
  }));
}

/**
 * The plan as kept: every keyword once in the whole plan, none that the
 * website has, each marked real (one of Google's searches, written as Google
 * wrote it) or AI-made.
 */
export function cleanPlan(
  given: { pillar: string; page: PageKind; subs: string[]; origins?: Origin[]; origin?: Origin }[],
  found: Found[],
  taken: Taken[],
): { plan: PlanPillar[]; left: { keyword: string; reason: string }[] } {
  const real = new Map(found.map((f) => [normalizeTitle(f.keyword), f.keyword]));
  const used = new Set<string>();
  const usedTexts: Taken[] = [];
  const left: { keyword: string; reason: string }[] = [];
  const keep = (keyword: string, fallback: Origin): PlanSub | null => {
    const n = normalizeTitle(keyword);
    if (!n) return null;
    if (used.has(n)) {
      left.push({ keyword, reason: 'already in the plan' });
      return null;
    }
    // Close to one already in the plan, or to what the website has: left out.
    const dup = duplicateOf({ keyword }, [...taken, ...usedTexts]);
    if (dup) {
      left.push({ keyword, reason: dup });
      return null;
    }
    used.add(n);
    usedTexts.push({ label: keyword, texts: [keyword] });
    const exact = real.get(n);
    return { keyword: exact ?? keyword, origin: exact ? 'real' : fallback === 'real' ? 'ai' : fallback };
  };
  const out: PlanPillar[] = [];
  for (const p of given.slice(0, MAX_PILLARS)) {
    const pillar = keep(p.pillar, p.origin ?? 'ai');
    if (!pillar) {
      for (const sub of p.subs) left.push({ keyword: sub, reason: `its pillar “${p.pillar}” was left out` });
      continue;
    }
    const subs = p.subs
      .map((s, i) => keep(s, p.origins?.[i] ?? 'ai'))
      .filter((s): s is PlanSub => s !== null)
      .slice(0, MAX_SUBS_EACH);
    out.push({ pillar: pillar.keyword, origin: pillar.origin, page: p.page, subs });
  }
  return { plan: out, left };
}

/* -- Editing and approving ----------------------------------------------------------- */

/**
 * The tree as edited on the page: each pillar renamed or removed, each sub
 * renamed, removed or moved to another pillar, and new subs typed in. Run
 * through the same clean-up as the AI's plan, so nothing repeats.
 */
export interface TreeEdit {
  pillars: { pillar: string; remove: boolean; page: PageKind }[];
  subs: { keyword: string; from: number; to: number; remove: boolean }[];
  added: { keyword: string; to: number }[];
}

export async function editPlan(id: number, edit: TreeEdit, deps: Pick<ResearchDeps, 'listPosts' | 'encryptionKey'>): Promise<void> {
  const row = getResearch(id);
  const site = row ? getNewWebsite(row.website_id) : undefined;
  if (!row || !site || row.status !== 'ready') return;
  const state = stateOf(row);
  const before = state.plan;
  const originOf = (keyword: string, from: number): Origin => {
    const old = before[from]?.subs.find((s) => normalizeTitle(s.keyword) === normalizeTitle(keyword));
    return old?.origin ?? (before[from] && normalizeTitle(before[from]!.pillar) === normalizeTitle(keyword) ? before[from]!.origin : 'yours');
  };
  const pillars = edit.pillars.map((p, i) => ({
    pillar: p.pillar,
    page: p.page,
    origin: normalizeTitle(p.pillar) === normalizeTitle(before[i]?.pillar ?? '') ? before[i]!.origin : ('yours' as Origin),
    subs: [] as string[],
    origins: [] as Origin[],
    remove: p.remove,
  }));
  const removed = [...(state.removed ?? [])];
  for (const p of edit.pillars) if (p.remove) removed.push(p.pillar);
  for (const s of edit.subs) {
    if (s.remove || !pillars[s.to] || pillars[s.to]!.remove) removed.push(s.keyword);
    if (s.remove || !pillars[s.to]) continue;
    pillars[s.to]!.subs.push(s.keyword);
    pillars[s.to]!.origins.push(originOf(s.keyword, s.from));
  }
  for (const a of edit.added) {
    if (!a.keyword.trim() || !pillars[a.to]) continue;
    pillars[a.to]!.subs.push(a.keyword);
    pillars[a.to]!.origins.push('yours');
  }
  let posts: SitePost[] = [];
  try {
    posts = await deps.listPosts(site.domain, websiteApiKey(site, deps.encryptionKey));
  } catch {
    /* only the keyword list is checked */
  }
  const { plan, left } = cleanPlan(pillars.filter((p) => !p.remove), state.found, takenOf(site, posts));
  state.plan = plan;
  state.left = left;
  // One typed back in is no longer deleted.
  const inPlan = new Set(plan.flatMap((p) => [p.pillar, ...p.subs.map((x) => x.keyword)]).map(normalizeTitle));
  state.removed = [...new Map(removed.map((k) => k.trim()).filter((k) => k && !inPlan.has(normalizeTitle(k))).map((k) => [normalizeTitle(k), k])).values()];
  save(id, 'ready', state);
}

/**
 * Approve: each pillar with its subs goes into the website's Keywords list,
 * exactly like a row of the CSV import. A pillar the website has a plan for
 * already is left out, with why.
 */
export function approveResearch(id: number): { plans: number; skipped: string[] } | null {
  const row = getResearch(id);
  const site = row ? getNewWebsite(row.website_id) : undefined;
  if (!row || !site || row.status !== 'ready') return null;
  const state = stateOf(row);
  const planned = new Set(listKeywordPlans(site.id).map((p) => normalizeTitle(p.pillar)));
  const skipped: string[] = [];
  const rows: ImportRow[] = [];
  state.plan.forEach((p, i) => {
    if (planned.has(normalizeTitle(p.pillar))) {
      skipped.push(`“${p.pillar}”: ${site.name} already has it in its Keywords list.`);
      return;
    }
    rows.push({
      line: i + 1, keyword: p.pillar, domain: site.domain, websiteId: site.id, websiteName: site.name, niche: '',
      subs: p.subs.map((s) => s.keyword), removed: state.removed ?? [], errors: [], notes: [],
    });
  });
  const { plans } = importRows(rows, { source: 'research', reason: 'From Content research' });
  state.approved = { plans, skipped };
  save(id, 'approved', state);
  log.info(`Research ${id} approved: ${plans} keyword plans added to ${site.domain}.`);
  return state.approved;
}
