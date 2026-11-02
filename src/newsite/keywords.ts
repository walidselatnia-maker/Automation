import { similarity, words } from '../seo/rules.js';

/**
 * Keyword strategy for a new website: one pillar keyword and up to six
 * sub-keywords, each with a genuinely different search intent.
 *
 * The AI proposes; this file decides. Every rule that can be checked by code
 * is checked here, so a weak pick is dropped with a reason whatever the model
 * said about it.
 */

export const MAX_SUBS = 6;
export const TOO_CLOSE = 0.75;

export const INTENTS = ['diet', 'method', 'format', 'flavor', 'ingredient', 'time', 'info'] as const;
export type Intent = (typeof INTENTS)[number] | 'yours';

/**
 * Words that change how a search sounds but not what the searcher needs.
 * A sub-keyword made only of the pillar plus these is the same page.
 */
const FILLER = new Set(
  [
    'easy', 'easiest', 'best', 'quick', 'quickest', 'simple', 'healthy', 'healthier', 'moist',
    'soft', 'chewy', 'crispy', 'homemade', 'perfect', 'ultimate', 'delicious', 'good', 'great',
    'yummy', 'tasty', 'amazing', 'classic', 'traditional', 'favorite', 'favourite', 'famous',
    'recipe', 'recipes', 'how', 'make', 'making', 'made', 'can', 'do', 'does', 'what', 'why', 'when',
    'from', 'scratch', 'top', 'idea', 'ideas', 'guide', 'step', 'tip', 'tips', 'near', 'me',
  ].map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)),
);

/** The words that carry meaning: content words without filler. */
export const coreWords = (text: string): string[] => words(text).filter((w) => !FILLER.has(w));

const coreText = (text: string): string => coreWords(text).join(' ');

/** How alike two keywords or titles are, ignoring filler words. */
export const closeness = (a: string, b: string): number => similarity(coreText(a), coreText(b));

export interface Existing {
  /** What to call it when it blocks something: a post title or a saved keyword. */
  label: string;
  text: string;
}

/** A recipe page is a dish to cook (it gets a fixed recipe); an article page answers a question. */
export type PageKind = 'recipe' | 'article';

export const asPage = (value: unknown): PageKind => (String(value ?? '').trim().toLowerCase() === 'article' ? 'article' : 'recipe');

export interface Pick {
  keyword: string;
  intent: Intent;
  reason: string;
  page: PageKind;
  pageReason: string;
}

export interface Dropped {
  keyword: string;
  reason: string;
}

/** What blocks a pillar: an existing post or saved keyword that covers it. */
export function pillarProblem(pillar: string, existing: Existing[]): string | null {
  if (coreWords(pillar).length === 0) return 'Type a real topic, not only words like "easy" or "best".';
  const hit = existing.find((e) => closeness(pillar, e.text) >= TOO_CLOSE);
  return hit ? `Already covered by ${hit.label}. Improve that page, or pick another topic.` : null;
}

/** Why one keyword cannot be a sub-keyword of this pillar, or null when it can. */
export function subProblem(
  keyword: string,
  pillar: string,
  existing: Existing[],
  earlier: string[],
): string | null {
  const pillarWords = new Set(coreWords(pillar));
  const mine = coreWords(keyword);
  const shared = mine.filter((w) => pillarWords.has(w)).length;
  if (pillarWords.size && shared < Math.ceil(pillarWords.size / 2)) {
    return 'Not about the pillar.';
  }
  if (!mine.some((w) => !pillarWords.has(w))) {
    return 'Same search as the pillar with only words like "easy" or "best" added.';
  }
  if (closeness(keyword, pillar) >= TOO_CLOSE && mine.length <= pillarWords.size) {
    return 'Too close to the pillar.';
  }
  const hit = existing.find((e) => closeness(keyword, e.text) >= TOO_CLOSE);
  if (hit) return `Too close to ${hit.label}.`;
  const twin = earlier.find((k) => closeness(keyword, k) >= TOO_CLOSE);
  if (twin) return `Too close to “${twin}”, already in this list.`;
  return null;
}

const asIntent = (value: unknown): Intent => {
  const v = String(value ?? '').trim().toLowerCase();
  return (INTENTS as readonly string[]).includes(v) ? (v as Intent) : 'format';
};

/**
 * Keep the AI's good picks, at most `limit` (six), and say why every other one went.
 * `searches` is what Google really suggested; a pick must be one of them.
 * `given` are sub-keywords the owner already chose: a pick must not repeat them.
 */
export function filterPicks(
  raw: unknown[],
  pillar: string,
  searches: string[],
  existing: Existing[],
  given: string[] = [],
  limit = MAX_SUBS,
): { kept: Pick[]; dropped: Dropped[] } {
  const real = new Map(searches.map((s) => [s.trim().toLowerCase(), s.trim()]));
  const kept: Pick[] = [];
  const dropped: Dropped[] = [];

  for (const item of raw) {
    const entry = (item ?? {}) as { keyword?: unknown; intent?: unknown; reason?: unknown; page?: unknown; pageReason?: unknown };
    const typed = String(entry.keyword ?? '').replace(/\s+/g, ' ').trim();
    if (!typed) continue;
    if (kept.some((k) => k.keyword.toLowerCase() === typed.toLowerCase())) continue;

    const exact = real.get(typed.toLowerCase());
    if (!exact) {
      dropped.push({ keyword: typed, reason: 'Not a real Google search, so demand is unproven.' });
      continue;
    }
    const problem = subProblem(exact, pillar, existing, [...given, ...kept.map((k) => k.keyword)]);
    if (problem) {
      dropped.push({ keyword: exact, reason: problem });
      continue;
    }
    if (kept.length >= limit) {
      dropped.push({ keyword: exact, reason: given.length ? `The plan already has ${MAX_SUBS} sub-keywords.` : `Only the best ${MAX_SUBS} are kept.` });
      continue;
    }
    kept.push({
      keyword: exact,
      intent: asIntent(entry.intent),
      reason: String(entry.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      page: asPage(entry.page),
      pageReason: String(entry.pageReason ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return { kept, dropped };
}

/** The model's answer as a list of picks, whatever wrapper it came in. */
export function parsePicks(raw: string): unknown[] {
  const attempt = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  let value = attempt(raw);
  if (value === undefined) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) value = attempt(raw.slice(start, end + 1));
  }
  if (Array.isArray(value)) return value;
  const picks = (value as { picks?: unknown } | undefined)?.picks;
  return Array.isArray(picks) ? picks : [];
}

/* -- The whole search ---------------------------------------------------- */

export interface FindDeps {
  /** Real Google searches for the pillar, with the plan's modifiers. Empty when Google is unreachable. */
  suggest: (pillar: string, language?: string) => Promise<string[]>;
  ask: (promptName: string, variables: Record<string, unknown>, chat?: string) => Promise<string>;
}

export interface FindInput {
  pillar: string;
  niche: string;
  nicheContext: string;
  existing: Existing[];
  /** The website's language; English when not given. */
  language?: string;
  /**
   * Sub-keywords the owner already chose (from a CSV file). They stay; the AI
   * sees them as examples and only adds similar ones, up to MAX_SUBS in all.
   */
  given?: string[];
  /** Sub-keywords the owner deleted from this plan: never found again. */
  removed?: string[];
}

/** How many of the given sub-keywords also seed the Google searches. */
const GIVEN_SEEDS = 2;

/** What the AI says about the pillar itself: one dish (gets its recipe) or a broad topic. */
export function parsePillarPage(raw: string): { page: PageKind; reason: string } {
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
  const o = (value ?? {}) as { pillarPage?: unknown; pillarPageReason?: unknown };
  return {
    page: asPage(o.pillarPage),
    reason: String(o.pillarPageReason ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
  };
}

export type FindResult =
  | { ok: true; kept: Pick[]; dropped: Dropped[]; searches: number; pillarPage: PageKind; pillarPageReason: string }
  | { ok: false; error: string };

export async function findSubKeywords(input: FindInput, deps: FindDeps): Promise<FindResult> {
  const pillar = input.pillar.replace(/\s+/g, ' ').trim();
  const blocked = pillarProblem(pillar, input.existing);
  if (blocked) return { ok: false, error: blocked };

  const given = input.given ?? [];
  const lists = [await deps.suggest(pillar, input.language)];
  // The owner's own picks widen the Google list, so similar searches show up.
  for (const g of given.slice(0, GIVEN_SEEDS)) lists.push(await deps.suggest(g, input.language));
  const removed = input.removed ?? [];
  const isTaken = (s: string): boolean =>
    [pillar, ...given].some((t) => t.toLowerCase() === s.trim().toLowerCase()) || removed.some((r) => closeness(s, r) >= TOO_CLOSE);
  const searches = [...new Map(lists.flat().filter((s) => !isTaken(s)).map((s) => [s.trim().toLowerCase(), s])).values()];
  if (searches.length === 0) {
    return {
      ok: false,
      error: 'Google autocomplete could not be reached, so nothing could be checked. Try again in a minute.',
    };
  }

  let raw: string;
  try {
    raw = await deps.ask('keyword-cluster', {
      language: input.language || 'English',
      pillar,
      niche: input.niche,
      nicheContext: input.nicheContext || '(none)',
      searchesJson: JSON.stringify(searches),
      givenJson: JSON.stringify(given),
    });
  } catch {
    return { ok: false, error: 'The AI could not be reached. Check the AI keys in Settings, then try again.' };
  }

  const { kept, dropped } = filterPicks(parsePicks(raw), pillar, searches, input.existing, given, Math.max(0, MAX_SUBS - given.length));
  if (kept.length === 0 && dropped.length === 0) {
    return { ok: false, error: 'The AI answer could not be read. Try again.' };
  }
  const pillar_ = parsePillarPage(raw);
  return { ok: true, kept, dropped, searches: searches.length, pillarPage: pillar_.page, pillarPageReason: pillar_.reason };
}
