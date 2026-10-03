import type { ContentType } from '../db/repos.js';

/**
 * The content guide, as data.
 *
 * Six small steps in a fixed order. Each one has a single result with a single
 * shape, checked here before it is saved -- whatever proposed it, a model or a
 * person typing -- so later steps can read it without second-guessing.
 */

export type StepKey =
  | 'identity'
  | 'pillars'
  | 'search-console'
  | 'keywords'
  | 'shortlist'
  | 'import';

export interface StepDef {
  key: StepKey;
  title: string;
  /** One sentence, shown on the card. */
  why: string;
  /** Two to four bullets, collapsed on the card. */
  how: string[];
  /** What the step is for, told to the model. */
  goal: string;
  /** The prompt the assistant uses; null when the step has no assistant. */
  prompt: string | null;
  /** Steps 4–6 run once per pillar; 1–3 once per site. */
  perRound: boolean;
}

export const STEPS: StepDef[] = [
  {
    key: 'identity',
    title: 'Say who the site is for, in one line',
    why: 'Every later choice is checked against this line, so the site stays focused.',
    how: [
      "Answer the assistant's quick questions by tapping.",
      'Pick the version that sounds most like you.',
      'You can change it later.',
    ],
    goal: 'Help the person write ONE line saying who the site is for and what it is known for, e.g. "Quick weeknight dinners for busy parents".',
    prompt: 'guide-identity',
    perRound: false,
  },
  {
    key: 'pillars',
    title: 'Pick 3 pillar topics',
    why: 'Pillars keep the site about a few things, which is what makes Google trust it.',
    how: [
      'The assistant suggests topics that fit your one line.',
      'Tap the 3 you like most.',
    ],
    goal: 'Help the person choose exactly 3 broad pillar topics that fit the site identity.',
    prompt: 'guide-pillars',
    perRound: false,
  },
  {
    key: 'search-console',
    title: 'Connect Google Search Console',
    why: 'It is free, and it is how you will later see which pages Google shows.',
    how: [
      'Go one small action at a time with the assistant.',
      'Tick "I\'ve done this" at the end.',
    ],
    goal: 'Walk the person through adding the site to Google Search Console and submitting the sitemap, one action per message.',
    prompt: 'guide-search-console',
    perRound: false,
  },
  {
    key: 'keywords',
    title: 'Collect long-tail keywords for one pillar',
    why: 'Long, specific searches are the ones a new site can actually win.',
    how: [
      'Choose the pillar to work on.',
      'The assistant checks its ideas against what people really type into Google.',
      'Keep the list it gives you, or ask for changes.',
    ],
    goal: 'Collect 30 to 50 long-tail keywords (3+ words, specific) for ONE pillar, grounded in real Google autocomplete suggestions.',
    prompt: 'guide-keywords',
    perRound: true,
  },
  {
    key: 'shortlist',
    title: 'Pick 1 pillar article and 10 recipes',
    why: 'Publishing a small, tight group together helps each page lift the others.',
    how: [
      'The assistant removes duplicates and ones you already have.',
      'It proposes 1 big guide article and 10 recipes.',
      "Swap anything you don't like.",
    ],
    goal: 'From the collected keywords, propose exactly 1 pillar article (a broad guide to the pillar) and 10 recipes, with no near-duplicates.',
    prompt: 'guide-shortlist',
    perRound: true,
  },
  {
    key: 'import',
    title: 'Send them to Keywords',
    why: 'Once they are in Keywords, the platform writes and publishes them on its normal schedule.',
    how: ['Untick anything you changed your mind about.', 'Press Add to Keywords.'],
    goal: 'Import the shortlist.',
    prompt: null,
    perRound: true,
  },
];

export const STEP_KEYS: StepKey[] = STEPS.map((s) => s.key);

export const isStepKey = (value: unknown): value is StepKey =>
  typeof value === 'string' && (STEP_KEYS as string[]).includes(value);

export const stepDef = (key: StepKey): StepDef => STEPS.find((s) => s.key === key)!;

export const stepIndex = (key: StepKey): number => STEP_KEYS.indexOf(key);

export const nextStep = (key: StepKey): StepKey | null => {
  const next = STEP_KEYS[stepIndex(key) + 1];
  return (next as StepKey | undefined) || null;
};

export const prevStep = (key: StepKey): StepKey | null => {
  const index = stepIndex(key);
  if (index > 0) {
    return STEP_KEYS[index - 1] as StepKey | undefined || null;
  }
  return null;
};

/* -- Results -------------------------------------------------------------- */

export interface IdentityResult { identity: string }
export interface PillarsResult { pillars: string[] }
export interface SearchConsoleResult { confirmed: true }
export interface KeywordsResult { pillar: string; keywords: string[]; verified: boolean }
export interface ShortlistItem { keyword: string; type: ContentType }
export interface ShortlistResult { pillar: string; items: ShortlistItem[] }
export interface ImportResult { imported_ids: number[] }

export type Validation = { ok: true; value: unknown } | { ok: false; problem: string };

const ok = (value: unknown): Validation => ({ ok: true, value });
const fail = (problem: string): Validation => ({ ok: false, problem });

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/** Non-empty, trimmed, and unique ignoring case; first spelling wins. */
function uniqueStrings(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const text = clean(item);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** Check a proposed result and return it cleaned, or say what is wrong in plain words. */
export function validateResult(key: StepKey, value: unknown): Validation {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

  switch (key) {
    case 'identity': {
      const identity = clean(v.identity);
      if (identity.length < 10) return fail('The line is too short -- say who the site is for.');
      if (identity.length > 200) return fail('Keep it to one line, under 200 characters.');
      return ok({ identity });
    }
    case 'pillars': {
      const pillars = uniqueStrings(v.pillars);
      if (pillars.length !== 3) return fail(`Pick exactly 3 different pillar topics (got ${pillars.length}).`);
      return ok({ pillars });
    }
    case 'search-console':
      return v.confirmed === true
        ? ok({ confirmed: true })
        : fail('Tick "I\'ve done this" once Search Console is connected.');
    case 'keywords': {
      const pillar = clean(v.pillar);
      const keywords = uniqueStrings(v.keywords);
      if (!pillar) return fail('Say which pillar these keywords are for.');
      // 30–50 is what the prompt asks for; the bounds here are looser so a
      // thin niche with only a dozen real searches never blocks the operator.
      if (keywords.length < 10) return fail(`Need at least 10 keywords (got ${keywords.length}).`);
      if (keywords.length > 60) return fail(`At most 60 keywords (got ${keywords.length}).`);
      return ok({ pillar, keywords, verified: v.verified !== false });
    }
    case 'shortlist': {
      const pillar = clean(v.pillar);
      const seen = new Set<string>();
      const items: ShortlistItem[] = [];
      for (const raw of Array.isArray(v.items) ? v.items : []) {
        const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const keyword = clean(r.keyword);
        const type: ContentType | null =
          r.type === 'article' ? 'article' : r.type === 'recipe' ? 'recipe' : null;
        if (!keyword || !type || seen.has(keyword.toLowerCase())) continue;
        seen.add(keyword.toLowerCase());
        items.push({ keyword, type });
      }
      const articles = items.filter((i) => i.type === 'article').length;
      const recipes = items.length - articles;
      if (!pillar) return fail('Say which pillar this shortlist is for.');
      if (articles !== 1) return fail(`Choose exactly 1 pillar article (got ${articles}).`);
      if (recipes < 5 || recipes > 15) return fail(`Choose 5 to 15 recipes (got ${recipes}).`);
      // The pillar article first: it is the page the others link up to.
      items.sort((a, b) => (a.type === b.type ? 0 : a.type === 'article' ? -1 : 1));
      return ok({ pillar, items });
    }
    case 'import': {
      const ids = Array.isArray(v.imported_ids)
        ? v.imported_ids.filter((n): n is number => Number.isInteger(n) && (n as number) > 0)
        : [];
      return ids.length ? ok({ imported_ids: ids }) : fail('Nothing has been added to Keywords yet.');
    }
  }
}

/**
 * A result typed by hand, for when the assistant is unavailable or simply not
 * wanted. One rule per step, written on the card next to the box.
 */
export function manualResult(key: StepKey, text: string, pillar: string): unknown {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  switch (key) {
    case 'identity':
      return { identity: text.trim() };
    case 'pillars':
      return { pillars: lines };
    case 'search-console':
      return { confirmed: true };
    case 'keywords':
      return { pillar: lines[0] ?? '', keywords: lines.slice(1), verified: false };
    case 'shortlist':
      return {
        pillar,
        items: lines.map((keyword, i) => ({ keyword, type: i === 0 ? 'article' : 'recipe' })),
      };
    case 'import':
      return null;
  }
}
