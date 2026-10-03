# Content Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Content → Guide** page that walks the operator through steps 1–6 of the content strategy for one site, one card at a time, with an AI assistant (the platform's own LLM pool) on every step.

**Architecture:** Pure step definitions and validators (`src/guide/steps.ts`) sit under a small SQLite-backed state module (`src/guide/state.ts`). An assistant module (`src/guide/assistant.ts`) builds prompt variables, calls the model through an injected `ask` function (wired to the existing `askPrompt` in the server), grounds keywords in Google autocomplete (`src/integrations/google-suggest.ts`), and stores the chat. A server-rendered view (`src/web/views/guide.ts`) with a small inline script drives the chat over `fetch`. Step 6 writes into the existing `keywords` / `keyword_sites` tables (`src/guide/import.ts`).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify, `node:sqlite` via `src/db/index.ts`, Vitest, server-rendered HTML through the `html` tagged template in `src/web/views/layout.ts`.

**Spec:** `docs/superpowers/specs/2026-10-03-content-guide-design.md`

## Global Constraints

- Round 1 only: steps `identity`, `pillars`, `search-console`, `keywords`, `shortlist`, `import`. No Search Console API, no steps 7–11.
- One card per screen; the whole map is collapsed by default.
- Progress is per site. Steps 1–3 are stored with `round = 0`; steps 4–6 with the site's current round (1, 2, 3 …).
- AI reply JSON shape: `{"message": string, "choices": string[], "multi": boolean, "draft": object|null}`; step 4 may also carry `"seeds": string[]` and `"pillar": string`.
- `choices`: at most 8.
- Guide prompts default to model `gpt-oss:120b` with `format: 'json'`, registered in `PROMPT_MODELS`.
- Validators: identity 10–200 chars; pillars exactly 3; keywords 10–60 unique; shortlist exactly 1 article and 5–15 recipes; import needs ≥1 id.
- Google autocomplete: `https://suggestqueries.google.com/complete/search?client=firefox&q=…`, modifiers `'' how best easy with without for "can you"`, cap 100 requests, 200 ms apart, 5 s timeout each.
- `Done →` is refused until the step has a saved result.
- Existing code style: comments explain *why*, user-facing text is plain English, no new dependencies.
- Run `npm test` and `npm run typecheck` before every commit; both must pass.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/db/migrations.ts` | modify | Migration `016-content-guide` creates the three guide tables |
| `src/guide/steps.ts` | create | Step list, navigation helpers, result types, validators, manual-input parsing |
| `src/guide/state.ts` | create | Cursor, results, statuses, messages, site context |
| `src/integrations/google-suggest.ts` | create | Autocomplete fetch, parse, expansion |
| `prompts/guide-*.{system,user}.txt` | create | Five prompts |
| `src/pipeline/prompts.ts` | modify | Register the five prompts in `PROMPT_MODELS` |
| `src/pipeline/prompt-contexts.ts` | modify | Declare the guide prompt variables in `STEP_CONTEXTS` |
| `src/guide/assistant.ts` | create | Reply parsing, the respond loop, step 4 grounding, step 5 dedupe |
| `src/guide/import.ts` | create | Shortlist → keywords + links |
| `src/web/views/layout.ts` | modify | Add Guide to the Content section |
| `src/web/views/guide.ts` | create | List page, card page, chat script |
| `src/web/server.ts` | modify | Routes |
| `test/guide-*.test.ts`, `test/google-suggest.test.ts`, `test/navigation.test.ts` | create/modify | Tests |

---

### Task 1: Guide tables and step definitions

**Files:**
- Modify: `src/db/migrations.ts` (append to the `MIGRATIONS` array, after `015-page-publisher`)
- Create: `src/guide/steps.ts`
- Test: `test/guide-steps.test.ts`

**Interfaces:**
- Consumes: `ContentType` from `src/db/repos.ts`.
- Produces (used by every later task):
  - `type StepKey = 'identity' | 'pillars' | 'search-console' | 'keywords' | 'shortlist' | 'import'`
  - `interface StepDef { key: StepKey; title: string; why: string; how: string[]; goal: string; prompt: string | null; perRound: boolean }`
  - `STEPS: StepDef[]`, `STEP_KEYS: StepKey[]`, `isStepKey(v: unknown): v is StepKey`, `stepDef(key): StepDef`, `stepIndex(key): number`, `nextStep(key): StepKey | null`, `prevStep(key): StepKey | null`
  - Result types `IdentityResult`, `PillarsResult`, `SearchConsoleResult`, `KeywordsResult`, `ShortlistItem`, `ShortlistResult`, `ImportResult`
  - `type Validation = { ok: true; value: unknown } | { ok: false; problem: string }`
  - `validateResult(key: StepKey, value: unknown): Validation` — returns the cleaned value
  - `manualResult(key: StepKey, text: string, pillar: string): unknown`
  - Tables `guide_sites`, `guide_steps`, `guide_messages` (schema below)

- [ ] **Step 1: Write the failing test**

Create `test/guide-steps.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase } from '../src/db/index.js';
import { setLogLevel } from '../src/lib/logger.js';
import {
  isStepKey,
  manualResult,
  nextStep,
  prevStep,
  STEP_KEYS,
  stepDef,
  validateResult,
} from '../src/guide/steps.js';

/**
 * The guide is six small steps in a fixed order. Each step's result has one
 * shape, and anything a model or a person hands in is cleaned and checked
 * against it before it is saved, so later steps can trust what they read.
 */

describe('guide steps', () => {
  it('runs in the agreed order', () => {
    expect(STEP_KEYS).toEqual([
      'identity', 'pillars', 'search-console', 'keywords', 'shortlist', 'import',
    ]);
    expect(nextStep('identity')).toBe('pillars');
    expect(nextStep('import')).toBeNull();
    expect(prevStep('identity')).toBeNull();
    expect(prevStep('keywords')).toBe('search-console');
    expect(isStepKey('pillars')).toBe(true);
    expect(isStepKey('nope')).toBe(false);
  });

  it('keeps steps 1–3 site-wide and 4–6 per pillar round', () => {
    expect(STEP_KEYS.filter((k) => stepDef(k).perRound)).toEqual([
      'keywords', 'shortlist', 'import',
    ]);
  });

  it('has an assistant on every step but the import', () => {
    expect(stepDef('identity').prompt).toBe('guide-identity');
    expect(stepDef('search-console').prompt).toBe('guide-search-console');
    expect(stepDef('import').prompt).toBeNull();
  });
});

describe('validateResult', () => {
  it('cleans and accepts a one-line identity', () => {
    expect(validateResult('identity', { identity: '  Quick   dinners for busy parents ' })).toEqual({
      ok: true,
      value: { identity: 'Quick dinners for busy parents' },
    });
  });

  it('rejects an identity that is too short', () => {
    const result = validateResult('identity', { identity: 'food' });
    expect(result.ok).toBe(false);
  });

  it('wants exactly three different pillars', () => {
    expect(validateResult('pillars', { pillars: ['A', 'B', 'C'] }).ok).toBe(true);
    expect(validateResult('pillars', { pillars: ['A', 'a', 'B'] }).ok).toBe(false);
    expect(validateResult('pillars', { pillars: ['A', 'B', 'C', 'D'] }).ok).toBe(false);
  });

  it('accepts search console only when confirmed', () => {
    expect(validateResult('search-console', { confirmed: true }).ok).toBe(true);
    expect(validateResult('search-console', {}).ok).toBe(false);
  });

  it('accepts 10 to 60 unique keywords with a pillar', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `easy chicken dinner ${i}`);
    expect(validateResult('keywords', { pillar: 'Chicken', keywords: ten })).toEqual({
      ok: true,
      value: { pillar: 'Chicken', keywords: ten, verified: true },
    });
    expect(validateResult('keywords', { pillar: 'Chicken', keywords: ten.slice(0, 9) }).ok).toBe(false);
    expect(validateResult('keywords', { pillar: '', keywords: ten }).ok).toBe(false);
    expect(
      validateResult('keywords', { pillar: 'C', keywords: ten, verified: false }),
    ).toMatchObject({ ok: true, value: { verified: false } });
  });

  it('wants one article and five to fifteen recipes, article first', () => {
    const recipes = Array.from({ length: 10 }, (_, i) => ({ keyword: `recipe ${i}`, type: 'recipe' }));
    const result = validateResult('shortlist', {
      pillar: 'Chicken',
      items: [...recipes, { keyword: 'chicken dinner guide', type: 'article' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { items: { type: string }[] };
      expect(value.items[0].type).toBe('article');
      expect(value.items).toHaveLength(11);
    }
    expect(validateResult('shortlist', { pillar: 'Chicken', items: recipes }).ok).toBe(false);
  });

  it('needs at least one imported id', () => {
    expect(validateResult('import', { imported_ids: [3, 4] }).ok).toBe(true);
    expect(validateResult('import', { imported_ids: [] }).ok).toBe(false);
  });
});

describe('manualResult', () => {
  it('reads typed text in the shape each step expects', () => {
    expect(manualResult('identity', 'Dinners for busy parents', '')).toEqual({
      identity: 'Dinners for busy parents',
    });
    expect(manualResult('pillars', 'A\nB\n\nC', '')).toEqual({ pillars: ['A', 'B', 'C'] });
    expect(manualResult('keywords', 'Chicken\none\ntwo', '')).toEqual({
      pillar: 'Chicken',
      keywords: ['one', 'two'],
      verified: false,
    });
    expect(manualResult('shortlist', 'guide\nr1\nr2', 'Chicken')).toEqual({
      pillar: 'Chicken',
      items: [
        { keyword: 'guide', type: 'article' },
        { keyword: 'r1', type: 'recipe' },
        { keyword: 'r2', type: 'recipe' },
      ],
    });
  });
});

describe('guide tables', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
  });
  afterEach(() => closeDatabase());

  it('exist after migrating', () => {
    for (const table of ['guide_sites', 'guide_steps', 'guide_messages']) {
      const row = get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      );
      expect(row?.name).toBe(table);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/guide-steps.test.ts`
Expected: FAIL — `Cannot find module '../src/guide/steps.js'`.

- [ ] **Step 3: Add the migration**

In `src/db/migrations.ts`, append this entry to the `MIGRATIONS` array directly after the `015-page-publisher` entry (inside the closing `];`):

```ts
  {
    id: '016-content-guide',
    description: 'A step-by-step guide per site, with the assistant chat for each step',
    up(db) {
      // Where each site is in the guide. One row per site, made the first time
      // the guide is opened for it. `round` counts pillars: steps 4–6 run once
      // per pillar, and the pillar itself is only chosen inside step 4, so the
      // round number is what can be known in advance.
      db.exec(`
        CREATE TABLE IF NOT EXISTS guide_sites (
          site_id      INTEGER PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
          current_step TEXT    NOT NULL DEFAULT 'identity',
          round        INTEGER NOT NULL DEFAULT 1
        );
      `);

      // What the operator settled on for each step. round = 0 for the
      // site-wide steps, so a site's identity is not asked again per pillar.
      db.exec(`
        CREATE TABLE IF NOT EXISTS guide_steps (
          site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          round       INTEGER NOT NULL DEFAULT 0,
          step_key    TEXT    NOT NULL,
          status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
          result_json TEXT    NOT NULL DEFAULT 'null',
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (site_id, round, step_key)
        );
      `);

      // The chat, kept so leaving and coming back picks up where it was --
      // the whole point for someone who gets pulled away mid-step.
      db.exec(`
        CREATE TABLE IF NOT EXISTS guide_messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id    INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          round      INTEGER NOT NULL DEFAULT 0,
          step_key   TEXT    NOT NULL,
          role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
          content    TEXT    NOT NULL,
          payload    TEXT    NOT NULL DEFAULT '{}',
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_guide_messages ON guide_messages (site_id, round, step_key, id)',
      );
    },
  },
```

- [ ] **Step 4: Write `src/guide/steps.ts`**

```ts
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
      'Answer the assistant’s quick questions by tapping.',
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
      'Tick “I’ve done this” at the end.',
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
      'Swap anything you don’t like.',
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

export const nextStep = (key: StepKey): StepKey | null => STEP_KEYS[stepIndex(key) + 1] ?? null;

export const prevStep = (key: StepKey): StepKey | null =>
  stepIndex(key) > 0 ? STEP_KEYS[stepIndex(key) - 1] : null;

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
      if (identity.length < 10) return fail('The line is too short — say who the site is for.');
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
        : fail('Tick “I’ve done this” once Search Console is connected.');
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/guide-steps.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations.ts src/guide/steps.ts test/guide-steps.test.ts
git commit -m "Give the content guide its six steps and somewhere to keep them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Guide state

**Files:**
- Create: `src/guide/state.ts`
- Test: `test/guide-state.test.ts`

**Interfaces:**
- Consumes: Task 1 (`StepKey`, `STEPS`, `stepDef`, `stepIndex`, `nextStep`, `prevStep`, `isStepKey`, `validateResult`, `KeywordsResult`, `IdentityResult`, `PillarsResult`); `all`, `get`, `run` from `src/db/index.ts`.
- Produces:
  - `interface Cursor { siteId: number; step: StepKey; round: number }`
  - `getCursor(siteId: number): Cursor` (creates the row on first call)
  - `scopeOf(step: StepKey, round: number): number`
  - `getResult<T>(siteId: number, step: StepKey, round: number): T | null`
  - `getStatus(siteId: number, step: StepKey, round: number): 'open' | 'done'`
  - `saveResult(siteId: number, step: StepKey, round: number, value: unknown): Validation`
  - `markDone(siteId: number): { ok: true; next: StepKey | null } | { ok: false; problem: string }`
  - `goBack(siteId: number): void`
  - `canOpen(siteId: number, step: StepKey): boolean`, `goTo(siteId: number, step: StepKey): boolean`
  - `isRoundFinished(siteId: number): boolean`, `startNextPillar(siteId: number): boolean`
  - `interface GuideMessage { id: number; role: 'user' | 'assistant'; content: string; payload: Record<string, unknown>; created_at: string }`
  - `addMessage(siteId, step, round, role, content, payload?)`, `listMessages(siteId, step, round): GuideMessage[]`
  - `siteContext(siteId: number, round: number): { identity: string; pillars: string[]; currentPillar: string }`
  - `existingKeywordsForSite(siteId: number): string[]`
  - `interface SiteProgress { started: boolean; step: StepKey; index: number; total: number; round: number; finished: boolean }`
  - `progressFor(siteId: number): SiteProgress` (does not create a row)

- [ ] **Step 1: Write the failing test**

Create `test/guide-state.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { insertKeyword, setLink, upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import {
  addMessage,
  canOpen,
  existingKeywordsForSite,
  getCursor,
  getResult,
  goBack,
  goTo,
  isRoundFinished,
  listMessages,
  markDone,
  progressFor,
  saveResult,
  siteContext,
  startNextPillar,
} from '../src/guide/state.js';

/**
 * Where a site is in the guide, and what it decided along the way. Progress is
 * per site; steps 4–6 are per pillar round, so a second pillar starts clean
 * without losing the site's identity or pillars.
 */

const KEY = randomBytes(32);
let siteId = 0;

const site = (domain: string) =>
  upsertSite(
    {
      name: domain,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 1,
      interval_minutes: 0,
    },
    KEY,
  );

const keywords = (n: number) => Array.from({ length: n }, (_, i) => `easy chicken dinner ${i}`);

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  siteId = site('bitespoon.com');
});
afterEach(() => closeDatabase());

describe('guide state', () => {
  it('starts a new site at step 1, round 1', () => {
    expect(progressFor(siteId).started).toBe(false);
    expect(getCursor(siteId)).toEqual({ siteId, step: 'identity', round: 1 });
    expect(progressFor(siteId)).toMatchObject({ started: true, index: 1, total: 6, finished: false });
  });

  it('refuses Done until the step has a result', () => {
    expect(markDone(siteId)).toEqual({ ok: false, problem: expect.any(String) });
    expect(saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' }).ok).toBe(true);
    expect(markDone(siteId)).toEqual({ ok: true, next: 'pillars' });
    expect(getCursor(siteId).step).toBe('pillars');
  });

  it('refuses an invalid result and keeps the old one', () => {
    saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
    const bad = saveResult(siteId, 'identity', 1, { identity: 'x' });
    expect(bad.ok).toBe(false);
    expect(getResult(siteId, 'identity', 1)).toEqual({ identity: 'Quick dinners for busy parents' });
  });

  it('keeps site-wide results across rounds and per-round results apart', () => {
    saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
    expect(getResult(siteId, 'identity', 2)).toEqual({ identity: 'Quick dinners for busy parents' });

    saveResult(siteId, 'keywords', 1, { pillar: 'Chicken', keywords: keywords(10) });
    expect(getResult(siteId, 'keywords', 2)).toBeNull();
  });

  it('goes back one step, and only opens done steps or the next open one', () => {
    saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
    markDone(siteId);
    goBack(siteId);
    expect(getCursor(siteId).step).toBe('identity');
    expect(canOpen(siteId, 'pillars')).toBe(true);
    expect(canOpen(siteId, 'keywords')).toBe(false);
    expect(goTo(siteId, 'keywords')).toBe(false);
    expect(goTo(siteId, 'pillars')).toBe(true);
    expect(getCursor(siteId).step).toBe('pillars');
  });

  it('builds the context later steps need', () => {
    saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
    saveResult(siteId, 'pillars', 1, { pillars: ['Chicken', 'Pasta', 'Soup'] });
    saveResult(siteId, 'keywords', 1, { pillar: 'Chicken', keywords: keywords(10) });
    expect(siteContext(siteId, 1)).toEqual({
      identity: 'Quick dinners for busy parents',
      pillars: ['Chicken', 'Pasta', 'Soup'],
      currentPillar: 'Chicken',
    });
    expect(siteContext(siteId, 2).currentPillar).toBe('');
  });

  it('starts the next pillar only after the import is done', () => {
    expect(startNextPillar(siteId)).toBe(false);
    goToImportDone();
    expect(isRoundFinished(siteId)).toBe(true);
    expect(startNextPillar(siteId)).toBe(true);
    expect(getCursor(siteId)).toEqual({ siteId, step: 'keywords', round: 2 });
  });

  it('keeps the chat per step and round, oldest first', () => {
    addMessage(siteId, 'identity', 1, 'assistant', 'Hi', { choices: ['A'] });
    addMessage(siteId, 'identity', 1, 'user', 'A');
    addMessage(siteId, 'keywords', 1, 'user', 'other step');
    const messages = listMessages(siteId, 'identity', 1);
    expect(messages.map((m) => m.content)).toEqual(['Hi', 'A']);
    expect(messages[0].payload).toEqual({ choices: ['A'] });
  });

  it('lists the keywords already linked to the site', () => {
    const id = insertKeyword({ seed_keyword: 'honey garlic chicken' });
    setLink(id, siteId, 'go');
    insertKeyword({ seed_keyword: 'not linked' });
    expect(existingKeywordsForSite(siteId)).toEqual(['honey garlic chicken']);
  });
});

function goToImportDone() {
  saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
  markDone(siteId);
  saveResult(siteId, 'pillars', 1, { pillars: ['Chicken', 'Pasta', 'Soup'] });
  markDone(siteId);
  saveResult(siteId, 'search-console', 1, { confirmed: true });
  markDone(siteId);
  saveResult(siteId, 'keywords', 1, { pillar: 'Chicken', keywords: keywords(10) });
  markDone(siteId);
  saveResult(siteId, 'shortlist', 1, {
    pillar: 'Chicken',
    items: [
      { keyword: 'chicken guide', type: 'article' },
      ...keywords(5).map((keyword) => ({ keyword, type: 'recipe' })),
    ],
  });
  markDone(siteId);
  saveResult(siteId, 'import', 1, { imported_ids: [1] });
  markDone(siteId);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/guide-state.test.ts`
Expected: FAIL — `Cannot find module '../src/guide/state.js'`.

- [ ] **Step 3: Write `src/guide/state.ts`**

```ts
import { all, get, run } from '../db/index.js';
import {
  isStepKey,
  nextStep,
  prevStep,
  stepDef,
  stepIndex,
  STEPS,
  validateResult,
  type IdentityResult,
  type KeywordsResult,
  type PillarsResult,
  type StepKey,
  type Validation,
} from './steps.js';

/**
 * Where each site is in the guide, what it has decided, and the chat that got
 * it there. Plain reads and writes; the rules about what a valid result is
 * live in steps.ts.
 */

export interface Cursor {
  siteId: number;
  step: StepKey;
  round: number;
}

/** The site's place in the guide, made on first use. */
export function getCursor(siteId: number): Cursor {
  run('INSERT OR IGNORE INTO guide_sites (site_id) VALUES (?)', siteId);
  const row = get<{ current_step: string; round: number }>(
    'SELECT current_step, round FROM guide_sites WHERE site_id = ?',
    siteId,
  )!;
  return {
    siteId,
    step: isStepKey(row.current_step) ? row.current_step : 'identity',
    round: row.round,
  };
}

function setCursor(siteId: number, step: StepKey, round: number): void {
  run('UPDATE guide_sites SET current_step = ?, round = ? WHERE site_id = ?', step, round, siteId);
}

/** The round a step's rows are stored under: 0 for site-wide steps. */
export const scopeOf = (step: StepKey, round: number): number =>
  stepDef(step).perRound ? round : 0;

export function getResult<T>(siteId: number, step: StepKey, round: number): T | null {
  const row = get<{ result_json: string }>(
    'SELECT result_json FROM guide_steps WHERE site_id = ? AND round = ? AND step_key = ?',
    siteId,
    scopeOf(step, round),
    step,
  );
  if (!row) return null;
  try {
    return JSON.parse(row.result_json) as T | null;
  } catch {
    return null;
  }
}

export function getStatus(siteId: number, step: StepKey, round: number): 'open' | 'done' {
  const row = get<{ status: string }>(
    'SELECT status FROM guide_steps WHERE site_id = ? AND round = ? AND step_key = ?',
    siteId,
    scopeOf(step, round),
    step,
  );
  return row?.status === 'done' ? 'done' : 'open';
}

/** Save a result if it is valid. An invalid one leaves the old result alone. */
export function saveResult(siteId: number, step: StepKey, round: number, value: unknown): Validation {
  const checked = validateResult(step, value);
  if (!checked.ok) return checked;
  run(
    `INSERT INTO guide_steps (site_id, round, step_key, result_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (site_id, round, step_key)
       DO UPDATE SET result_json = excluded.result_json, updated_at = datetime('now')`,
    siteId,
    scopeOf(step, round),
    step,
    JSON.stringify(checked.value),
  );
  return checked;
}

/** Finish the current step and move to the next. Refused without a result. */
export function markDone(
  siteId: number,
): { ok: true; next: StepKey | null } | { ok: false; problem: string } {
  const c = getCursor(siteId);
  if (getResult(siteId, c.step, c.round) === null) {
    return { ok: false, problem: 'Save a result for this step first.' };
  }
  run(
    `UPDATE guide_steps SET status = 'done', updated_at = datetime('now')
     WHERE site_id = ? AND round = ? AND step_key = ?`,
    siteId,
    scopeOf(c.step, c.round),
    c.step,
  );
  const next = nextStep(c.step);
  if (next) setCursor(siteId, next, c.round);
  return { ok: true, next };
}

export function goBack(siteId: number): void {
  const c = getCursor(siteId);
  const prev = prevStep(c.step);
  if (prev) setCursor(siteId, prev, c.round);
}

function firstOpenStep(siteId: number, round: number): StepKey {
  for (const s of STEPS) if (getStatus(siteId, s.key, round) !== 'done') return s.key;
  return STEPS[STEPS.length - 1].key;
}

/** A step can be opened when it is done, current, or the first one not done. */
export function canOpen(siteId: number, step: StepKey): boolean {
  const c = getCursor(siteId);
  return (
    step === c.step ||
    getStatus(siteId, step, c.round) === 'done' ||
    firstOpenStep(siteId, c.round) === step
  );
}

export function goTo(siteId: number, step: StepKey): boolean {
  if (!canOpen(siteId, step)) return false;
  setCursor(siteId, step, getCursor(siteId).round);
  return true;
}

export const isRoundFinished = (siteId: number): boolean =>
  getStatus(siteId, 'import', getCursor(siteId).round) === 'done';

/** Steps 4–6 again, for the next pillar. Only once this round is imported. */
export function startNextPillar(siteId: number): boolean {
  if (!isRoundFinished(siteId)) return false;
  setCursor(siteId, 'keywords', getCursor(siteId).round + 1);
  return true;
}

/* -- Chat ------------------------------------------------------------------ */

export interface GuideMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export function addMessage(
  siteId: number,
  step: StepKey,
  round: number,
  role: 'user' | 'assistant',
  content: string,
  payload: Record<string, unknown> = {},
): void {
  run(
    `INSERT INTO guide_messages (site_id, round, step_key, role, content, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    siteId,
    scopeOf(step, round),
    step,
    role,
    content,
    JSON.stringify(payload),
  );
}

export function listMessages(siteId: number, step: StepKey, round: number): GuideMessage[] {
  return all<{
    id: number;
    role: 'user' | 'assistant';
    content: string;
    payload: string;
    created_at: string;
  }>(
    `SELECT id, role, content, payload, created_at FROM guide_messages
     WHERE site_id = ? AND round = ? AND step_key = ? ORDER BY id`,
    siteId,
    scopeOf(step, round),
    step,
  ).map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      // A broken payload loses its chips, not the message.
    }
    return { ...row, payload };
  });
}

/* -- What later steps read ------------------------------------------------- */

export function siteContext(
  siteId: number,
  round: number,
): { identity: string; pillars: string[]; currentPillar: string } {
  return {
    identity: getResult<IdentityResult>(siteId, 'identity', round)?.identity ?? '',
    pillars: getResult<PillarsResult>(siteId, 'pillars', round)?.pillars ?? [],
    currentPillar: getResult<KeywordsResult>(siteId, 'keywords', round)?.pillar ?? '',
  };
}

export const existingKeywordsForSite = (siteId: number): string[] =>
  all<{ seed_keyword: string }>(
    `SELECT k.seed_keyword FROM keywords k
     JOIN keyword_sites ks ON ks.keyword_id = k.id
     WHERE ks.site_id = ? ORDER BY k.id`,
    siteId,
  ).map((r) => r.seed_keyword);

export interface SiteProgress {
  started: boolean;
  step: StepKey;
  index: number;
  total: number;
  round: number;
  finished: boolean;
}

/** For the site list. Reading it does not start the guide for a site. */
export function progressFor(siteId: number): SiteProgress {
  const started = get('SELECT 1 AS x FROM guide_sites WHERE site_id = ?', siteId) !== undefined;
  if (!started) {
    return { started, step: 'identity', index: 1, total: STEPS.length, round: 1, finished: false };
  }
  const c = getCursor(siteId);
  return {
    started,
    step: c.step,
    index: stepIndex(c.step) + 1,
    total: STEPS.length,
    round: c.round,
    finished: isRoundFinished(siteId),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/guide-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/guide/state.ts test/guide-state.test.ts
git commit -m "Remember where each site is in the guide and what it decided

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Google autocomplete

**Files:**
- Create: `src/integrations/google-suggest.ts`
- Test: `test/google-suggest.test.ts`

**Interfaces:**
- Produces:
  - `SUGGEST_MODIFIERS: string[]`
  - `parseSuggestResponse(body: unknown): string[]`
  - `suggest(query: string, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<string[]>` — never throws; `[]` on any failure
  - `expandSeeds(seeds: string[], options?: { fetchImpl?: typeof fetch; timeoutMs?: number; maxRequests?: number; delayMs?: number }): Promise<string[]>` — unique (case-insensitive), in first-seen order

- [ ] **Step 1: Write the failing test**

Create `test/google-suggest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  expandSeeds,
  parseSuggestResponse,
  suggest,
  SUGGEST_MODIFIERS,
} from '../src/integrations/google-suggest.js';

/**
 * A model alone invents keywords nobody types. Google's autocomplete is what
 * people actually type, free and keyless; these tests pin its response shape
 * and keep the number of requests bounded.
 */

const answer = (body: unknown, ok = true) =>
  ({ ok, json: async () => body }) as unknown as Response;

describe('google suggest', () => {
  it('reads the client=firefox shape', () => {
    expect(parseSuggestResponse(['chicken', ['chicken thighs', ' chicken soup ', 3]])).toEqual([
      'chicken thighs',
      'chicken soup',
    ]);
    expect(parseSuggestResponse({})).toEqual([]);
    expect(parseSuggestResponse(['q'])).toEqual([]);
  });

  it('returns nothing when Google fails or refuses', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await suggest('x', { fetchImpl: throwing })).toEqual([]);
    const refused = (async () => answer(null, false)) as unknown as typeof fetch;
    expect(await suggest('x', { fetchImpl: refused })).toEqual([]);
  });

  it('asks for each seed with each modifier, de-duplicated', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      const q = new URL(url).searchParams.get('q')!;
      asked.push(q);
      return answer([q, [`${q} recipe`, 'Same Everywhere']]);
    }) as unknown as typeof fetch;

    const out = await expandSeeds(['chicken', ' '], { fetchImpl, delayMs: 0 });

    expect(asked).toHaveLength(SUGGEST_MODIFIERS.length);
    expect(asked[0]).toBe('chicken');
    expect(asked).toContain('chicken can you');
    expect(out.filter((s) => s.toLowerCase() === 'same everywhere')).toHaveLength(1);
    expect(out).toContain('chicken how recipe');
  });

  it('never sends more than the cap', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return answer(['q', []]);
    }) as unknown as typeof fetch;
    await expandSeeds(['a', 'b', 'c'], { fetchImpl, delayMs: 0, maxRequests: 5 });
    expect(calls).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/google-suggest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/integrations/google-suggest.ts`**

```ts
/**
 * Google autocomplete, as a check on what people really search.
 *
 * The suggest endpoint needs no key and answers `[query, [suggestion, ...]]`
 * for client=firefox. It is unofficial, so every failure -- blocked, offline,
 * a changed shape -- comes back as an empty list rather than an error; the
 * guide then says its keywords are unchecked guesses instead of stopping.
 */

const ENDPOINT = 'https://suggestqueries.google.com/complete/search';

/** Each seed is asked alone and followed by each of these. */
export const SUGGEST_MODIFIERS = ['', 'how', 'best', 'easy', 'with', 'without', 'for', 'can you'];

export function parseSuggestResponse(body: unknown): string[] {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return [];
  return (body[1] as unknown[])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SuggestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function suggest(query: string, options: SuggestOptions = {}): Promise<string[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${ENDPOINT}?client=firefox&hl=en&q=${encodeURIComponent(query)}`;
  try {
    const response = await doFetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
    if (!response.ok) return [];
    return parseSuggestResponse(await response.json());
  } catch {
    return [];
  }
}

export interface ExpandOptions extends SuggestOptions {
  /** Hard cap on requests for one expansion. */
  maxRequests?: number;
  /** Pause between requests, so a step run does not look like a flood. */
  delayMs?: number;
}

export async function expandSeeds(seeds: string[], options: ExpandOptions = {}): Promise<string[]> {
  const maxRequests = options.maxRequests ?? 100;
  const delayMs = options.delayMs ?? 200;

  const queries: string[] = [];
  for (const raw of seeds) {
    const seed = raw.trim();
    if (!seed) continue;
    for (const modifier of SUGGEST_MODIFIERS) queries.push(modifier ? `${seed} ${modifier}` : seed);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const [i, query] of queries.slice(0, maxRequests).entries()) {
    if (i > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    for (const s of await suggest(query, options)) {
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/google-suggest.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/google-suggest.ts test/google-suggest.test.ts
git commit -m "Check keyword ideas against what people type into Google

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The five guide prompts

**Files:**
- Create: `prompts/guide-identity.system.txt`, `prompts/guide-identity.user.txt`, and the same pair for `guide-pillars`, `guide-search-console`, `guide-keywords`, `guide-shortlist`
- Modify: `src/pipeline/prompts.ts` (`PROMPT_MODELS`, after the `'reel-plan'` entry)
- Modify: `src/pipeline/prompt-contexts.ts` (`STEP_CONTEXTS`)
- Test: existing `test/prompts.test.ts` (it already asserts every prompt in `PROMPT_MODELS` exists on disk, has a context, and uses only declared variables)

**Interfaces:**
- Produces: prompt names `guide-identity`, `guide-pillars`, `guide-search-console`, `guide-keywords`, `guide-shortlist`, each rendered with exactly these variables: `site_name`, `site_domain`, `identity`, `pillars`, `current_pillar`, `step_title`, `step_goal`, `user_text`, `history`, `extra`.

- [ ] **Step 1: Register the prompts so the existing test fails**

In `src/pipeline/prompts.ts`, add inside `PROMPT_MODELS` after `'reel-plan': { model: 'gpt-oss:120b', format: 'json' },`:

```ts
  // The content guide's assistant, one prompt per step. JSON because every
  // reply carries chips and maybe a draft alongside the message.
  'guide-identity': { model: 'gpt-oss:120b', format: 'json' },
  'guide-pillars': { model: 'gpt-oss:120b', format: 'json' },
  'guide-search-console': { model: 'gpt-oss:120b', format: 'json' },
  'guide-keywords': { model: 'gpt-oss:120b', format: 'json' },
  'guide-shortlist': { model: 'gpt-oss:120b', format: 'json' },
```

- [ ] **Step 2: Run the prompt test to verify it fails**

Run: `npx vitest run test/prompts.test.ts`
Expected: FAIL — prompt files for `guide-identity` (etc.) do not exist / no step context defined.

- [ ] **Step 3: Declare the variables**

In `src/pipeline/prompt-contexts.ts`, add above `export const STEP_CONTEXTS`:

```ts
/** Every guide prompt gets the same variables; `extra` carries step-specific data as JSON. */
const GUIDE_CONTEXT = {
  site_name: 's',
  site_domain: 'd',
  identity: 'i',
  pillars: 'p',
  current_pillar: 'c',
  step_title: 't',
  step_goal: 'g',
  user_text: 'u',
  history: 'h',
  extra: {},
};
```

and inside the `STEP_CONTEXTS` object, after the `'reel-plan'` entry:

```ts
  'guide-identity': GUIDE_CONTEXT,
  'guide-pillars': GUIDE_CONTEXT,
  'guide-search-console': GUIDE_CONTEXT,
  'guide-keywords': GUIDE_CONTEXT,
  'guide-shortlist': GUIDE_CONTEXT,
```

- [ ] **Step 4: Write the five user prompts**

All five `.user.txt` files have this identical content. Create `prompts/guide-identity.user.txt`, `prompts/guide-pillars.user.txt`, `prompts/guide-search-console.user.txt`, `prompts/guide-keywords.user.txt`, `prompts/guide-shortlist.user.txt` each containing:

```
Site: {{site_name}} ({{site_domain}})
Who the site is for: {{identity}}
Pillar topics: {{pillars}}
Current pillar: {{current_pillar}}

Step: {{step_title}}
Goal of this step: {{step_goal}}

Extra data for this step (JSON): {{extra}}

Conversation so far:
{{history}}

What they just said: {{user_text}}

If "What they just said" is empty, this is the start of the step: greet them in one short line and ask your first question.
Answer with the JSON object only.
```

- [ ] **Step 5: Write the five system prompts**

Every system prompt starts with the same block, then adds its step rules. Create `prompts/guide-identity.system.txt`:

```
You are a patient, upbeat helper inside a content platform for recipe websites. The person you help has ADHD: long text makes them lose track, and a blank box makes them freeze.

How you talk:
- Short. At most 3 short sentences per message. Plain words, no jargon. If you must use a term, explain it in under 6 words.
- Ask at most ONE question per message, and always offer choices they can tap instead of typing.
- Never ask for something already answered in the conversation.
- If they say they are stuck, shrink the task: one tiny next action and one easy question.
- Warm, never preachy, never lecture.

Answer with JSON only, exactly this shape:
{"message": "...", "choices": ["..."], "multi": false, "draft": null}
- "choices": 0 to 8 options, each at most 8 words.
- "multi": true only when they should pick several choices at once.
- "draft": null, or this step's result in the shape below once you have enough to propose it.
- If the extra data has a "problem", your last draft was rejected for that reason: fix it.

THIS STEP: help them write ONE line saying who the site is for and what it is known for.
- Interview them with multiple-choice questions, one per message: who cooks these recipes (e.g. busy parents, students, healthy eaters, beginners), how much time they have, any style or diet focus, what feeling the site should give.
- After 2 to 4 answers, offer 3 different one-line versions as "choices" and say "Tap the one that sounds most like you, or tell me what to change."
- When they pick or approve a version, return it as the draft.
Draft shape: {"identity": "one line, 10 to 200 characters"}
Example of a good line: "Quick weeknight dinners for busy parents who hate washing up."
```

Create `prompts/guide-pillars.system.txt` with the same opening block (everything up to and including the "problem" line), then:

```
THIS STEP: help them choose exactly 3 pillar topics. A pillar is a broad topic the site will cover again and again (e.g. "Chicken dinners", "One-pan meals", "Air fryer recipes").
- First message: offer 6 to 8 pillars that fit "Who the site is for" as choices with "multi": true, and ask them to tap the 3 they like most.
- If they pick fewer or more than 3, help them get to exactly 3 in one more question.
- Prefer topics with many possible recipes. Avoid overlapping pillars.
- When they have 3, return them as the draft.
Draft shape: {"pillars": ["first", "second", "third"]}
```

Create `prompts/guide-search-console.system.txt` with the same opening block, then:

```
THIS STEP: walk them through connecting the site to Google Search Console, ONE action per message. Never return a draft here; "draft" is always null. They finish the step by ticking a box on the page.
The actions, in order:
1. Open https://search.google.com/search-console and sign in with their Google account.
2. Click "Add property" and choose "URL prefix", then type https://{{site_domain}}/ (use the site domain from the data).
3. Choose the "HTML tag" verification method, copy the tag, and add it to the site's header (or use their SEO plugin's "Google verification" field). Then click Verify.
4. Open "Sitemaps" on the left, type sitemap.xml (or sitemap_index.xml if the site uses Yoast/RankMath), and click Submit.
5. Tell them they are done and to tick "I've done this" below.
After each action, offer the choices: "Done ✓", "It didn't work", "I'm stuck". If something did not work, ask one question to find out what they see on screen, then give one fix.
```

Note: the `{{site_domain}}` inside that system prompt is a real placeholder; it renders to the site's domain.

Create `prompts/guide-keywords.system.txt` with the same opening block, then:

```
THIS STEP: collect long-tail keywords for ONE pillar. A long-tail keyword is a specific search of 3 or more words, like "crispy air fryer chicken thighs no breading". New sites can win these.

The extra data has a "phase":
- "start": no keyword list yet.
  - If no pillar is chosen yet (Current pillar is "(not chosen yet)" and they have not named one in the conversation), ask which pillar to work on, with the site's pillars as choices.
  - Once the pillar is known, do NOT write the list yourself. Return 8 to 12 short seed phrases (2 to 4 words) for that pillar in a top-level "seeds" field, and the pillar in a top-level "pillar" field, with message "Checking what people really search for…" and "draft": null.
    Example: {"message": "Checking what people really search for…", "choices": [], "multi": false, "draft": null, "pillar": "Chicken dinners", "seeds": ["chicken thighs", "chicken breast dinner", "baked chicken"]}
- "pick": the extra data has "suggestions" (real Google searches) and "pillar".
  - If "suggestions" is not empty: pick the 30 to 50 best long-tail ones (3+ words, clearly about cooking or recipes, fitting the site) ONLY from "suggestions". Copy them exactly. Never invent new ones.
  - If "suggestions" is empty: Google could not be reached. Write 30 to 50 yourself, set "verified": false in the draft, and say in the message that these are unchecked guesses.
  - Message: one sentence saying how many you picked, then ask if the list looks good. Choices: "👍 Looks good", "More specific ones", "A different angle".
  - If they ask for changes later, you may return new "seeds" again to check another angle.
Draft shape: {"pillar": "the pillar", "keywords": ["...", "..."], "verified": true}
```

Create `prompts/guide-shortlist.system.txt` with the same opening block, then:

```
THIS STEP: turn the collected keywords into a shortlist of exactly 1 pillar article and 10 recipes.
The extra data has "pillar", "keywords" (the collected list, already without ones the site has) and "already_have" (ones skipped because the site already has them).
- Merge near-duplicates (e.g. "easy banana bread" and "simple banana bread"): keep the more specific one.
- The pillar article is the broad guide for the pillar, e.g. "how to cook chicken thighs" or "best chicken dinner ideas". Use a keyword from the list that fits; it has type "article".
- The 10 recipes are specific dishes from the list; each has type "recipe".
- First message: say in one line how many duplicates you merged and how many you skipped because the site already has them, then present the draft and ask if it looks good. Choices: "👍 Looks good", "Swap a recipe", "Different pillar article".
- If they want a swap, ask which one with the current items as choices, then offer replacements from the remaining keywords.
Draft shape: {"pillar": "the pillar", "items": [{"keyword": "...", "type": "article"}, {"keyword": "...", "type": "recipe"}]}
```

- [ ] **Step 6: Run the prompt test to verify it passes**

Run: `npx vitest run test/prompts.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: all pass. If `scripts/copy-assets.mjs` or the Prompts page enumerates prompts from `prompts/index.json`, also add five entries there in the existing shape (`{"sourceNode": "Content guide", "model": "gpt-oss:120b", "format": "json", "hasSystem": true}`) — check with `grep -rn "index.json" src scripts`; if nothing reads it, leave it alone.

- [ ] **Step 8: Commit**

```bash
git add prompts/guide-*.txt src/pipeline/prompts.ts src/pipeline/prompt-contexts.ts
git commit -m "Write the guide assistant's five prompts, editable like the rest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The assistant

**Files:**
- Create: `src/guide/assistant.ts`
- Test: `test/guide-assistant.test.ts`

**Interfaces:**
- Consumes: Task 1 (`stepDef`, `validateResult`, `StepKey`, `KeywordsResult`), Task 2 (`addMessage`, `existingKeywordsForSite`, `getCursor`, `getResult`, `listMessages`, `siteContext`), `tryParseJson` from `src/pipeline/json.ts`, `findDuplicate` from `src/core/similar-title.ts`, `getSite` from `src/db/repos.ts`, `NoEndpointAvailableError` from `src/llm/client.ts`.
- Produces:
  - `type Ask = (promptName: string, variables: Record<string, unknown>) => Promise<string>`
  - `type Suggest = (seeds: string[]) => Promise<string[]>`
  - `interface AssistantDeps { ask: Ask; suggest: Suggest }`
  - `interface AssistantReply { message: string; choices: string[]; multi: boolean; draft: unknown | null }`
  - `STUCK_TEXT: string`
  - `parseReply(raw: string, step: StepKey): ParsedReply | null` where `ParsedReply = { reply: AssistantReply; seeds: string[]; pillar: string; problem: string | null }`
  - `respond(deps: AssistantDeps, siteId: number, userText: string | null): Promise<AssistantReply>` — never throws for model failures

- [ ] **Step 1: Write the failing test**

Create `test/guide-assistant.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { insertKeyword, setLink, upsertSite } from '../src/db/repos.js';
import { NoEndpointAvailableError } from '../src/llm/client.js';
import { setLogLevel } from '../src/lib/logger.js';
import { parseReply, respond, type Ask } from '../src/guide/assistant.js';
import { getCursor, goTo, listMessages, markDone, saveResult } from '../src/guide/state.js';

/**
 * The assistant is a loop around one model call: build the variables from what
 * the site has decided, ask, check the reply, keep the chat. Step 4 asks twice
 * with Google in between; step 5 drops keywords the site already has.
 */

const KEY = randomBytes(32);
let siteId = 0;

const reply = (fields: Record<string, unknown>) =>
  JSON.stringify({ message: 'ok', choices: [], multi: false, draft: null, ...fields });

const noSuggest = async () => [] as string[];

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  siteId = upsertSite(
    {
      name: 'Bitespoon',
      domain: 'bitespoon.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 1,
      interval_minutes: 0,
    },
    KEY,
  );
});
afterEach(() => closeDatabase());

describe('parseReply', () => {
  it('reads message, choices and a valid draft', () => {
    const parsed = parseReply(
      reply({ choices: ['a', 'b'], draft: { identity: 'Quick dinners for busy parents' } }),
      'identity',
    );
    expect(parsed?.reply).toEqual({
      message: 'ok',
      choices: ['a', 'b'],
      multi: false,
      draft: { identity: 'Quick dinners for busy parents' },
    });
    expect(parsed?.problem).toBeNull();
  });

  it('drops an invalid draft and says why', () => {
    const parsed = parseReply(reply({ draft: { pillars: ['one'] } }), 'pillars');
    expect(parsed?.reply.draft).toBeNull();
    expect(parsed?.problem).toMatch(/exactly 3/);
  });

  it('caps choices at eight and refuses a reply with no message', () => {
    const many = Array.from({ length: 12 }, (_, i) => `c${i}`);
    expect(parseReply(reply({ choices: many }), 'identity')?.reply.choices).toHaveLength(8);
    expect(parseReply('{"choices": []}', 'identity')).toBeNull();
    expect(parseReply('not json at all', 'identity')).toBeNull();
  });
});

describe('respond', () => {
  it('opens a step with the site in the variables and stores the reply', async () => {
    const seen: Record<string, unknown>[] = [];
    const ask: Ask = async (name, vars) => {
      expect(name).toBe('guide-identity');
      seen.push(vars);
      return reply({ message: 'Who cooks?', choices: ['Parents', 'Students'] });
    };

    const out = await respond({ ask, suggest: noSuggest }, siteId, null);

    expect(out.message).toBe('Who cooks?');
    expect(seen[0]).toMatchObject({ site_domain: 'bitespoon.com', user_text: '', history: '(nothing yet)' });
    const stored = listMessages(siteId, 'identity', 1);
    expect(stored.map((m) => m.role)).toEqual(['assistant']);
    expect(stored[0].payload).toMatchObject({ choices: ['Parents', 'Students'] });
  });

  it('stores what the person said and passes the history', async () => {
    await respond({ ask: async () => reply({ message: 'Who cooks?' }), suggest: noSuggest }, siteId, null);
    let vars: Record<string, unknown> = {};
    await respond(
      { ask: async (_n, v) => ((vars = v), reply({ message: 'Got it' })), suggest: noSuggest },
      siteId,
      'Parents',
    );
    expect(vars.user_text).toBe('Parents');
    expect(vars.history).toBe('YOU: Who cooks?');
    expect(listMessages(siteId, 'identity', 1).map((m) => m.content)).toEqual([
      'Who cooks?', 'Parents', 'Got it',
    ]);
  });

  it('asks once more when the draft is invalid, with the problem', async () => {
    const extras: unknown[] = [];
    let n = 0;
    const ask: Ask = async (_name, vars) => {
      extras.push(vars.extra);
      n += 1;
      return n === 1
        ? reply({ draft: { identity: 'x' } })
        : reply({ draft: { identity: 'Quick dinners for busy parents' } });
    };
    const out = await respond({ ask, suggest: noSuggest }, siteId, 'go');
    expect(n).toBe(2);
    expect(extras[1]).toMatchObject({ problem: expect.any(String) });
    expect(out.draft).toEqual({ identity: 'Quick dinners for busy parents' });
  });

  it('says it is confused rather than throwing on nonsense', async () => {
    const out = await respond({ ask: async () => 'nonsense', suggest: noSuggest }, siteId, 'hi');
    expect(out.message).toMatch(/confused/);
    expect(listMessages(siteId, 'identity', 1).map((m) => m.role)).toEqual(['user']);
  });

  it('says plainly when no model can be reached', async () => {
    const ask: Ask = async () => {
      throw new NoEndpointAvailableError('gpt-oss:120b', [], '');
    };
    const out = await respond({ ask, suggest: noSuggest }, siteId, null);
    expect(out.message).toMatch(/can't reach a model/);
  });

  it('step 4: expands seeds through Google, then asks the model to pick', async () => {
    reachStep('keywords');
    const phases: unknown[] = [];
    const ask: Ask = async (_name, vars) => {
      const extra = vars.extra as { phase: string; suggestions?: string[] };
      phases.push(extra);
      if (extra.phase === 'start') return reply({ seeds: ['chicken thighs'], pillar: 'Chicken' });
      return reply({
        draft: { pillar: 'Chicken', keywords: extra.suggestions!.slice(0, 10) },
      });
    };
    const suggestions = Array.from({ length: 12 }, (_, i) => `crispy chicken thighs ${i}`);
    let seeded: string[] = [];
    const out = await respond(
      { ask, suggest: async (s) => ((seeded = s), suggestions) },
      siteId,
      'Chicken',
    );
    expect(seeded).toEqual(['chicken thighs']);
    expect(phases[1]).toMatchObject({ phase: 'pick', pillar: 'Chicken', suggestions, verified: true });
    expect(out.draft).toMatchObject({ pillar: 'Chicken', verified: true });
    // Only the final reply is kept, not the "checking…" one.
    expect(listMessages(siteId, 'keywords', 1).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('step 4: marks the list unverified when Google gave nothing', async () => {
    reachStep('keywords');
    const ten = Array.from({ length: 10 }, (_, i) => `easy chicken dinner ${i}`);
    const ask: Ask = async (_name, vars) =>
      (vars.extra as { phase: string }).phase === 'start'
        ? reply({ seeds: ['chicken'], pillar: 'Chicken' })
        : reply({ draft: { pillar: 'Chicken', keywords: ten } });
    const out = await respond({ ask, suggest: noSuggest }, siteId, 'Chicken');
    expect(out.draft).toMatchObject({ verified: false });
  });

  it('step 5: leaves out keywords the site already has', async () => {
    reachStep('shortlist');
    const id = insertKeyword({ seed_keyword: 'honey garlic chicken thighs' });
    setLink(id, siteId, 'go');
    let extra: Record<string, unknown> = {};
    await respond(
      { ask: async (_n, v) => ((extra = v.extra as Record<string, unknown>), reply({})), suggest: noSuggest },
      siteId,
      null,
    );
    expect(extra.pillar).toBe('Chicken');
    expect(extra.already_have).toEqual(['Honey garlic chicken thighs']);
    expect((extra.keywords as string[]).length).toBe(10);
  });
});

/** Fill the site's results up to `step` and put the cursor there. */
function reachStep(step: 'keywords' | 'shortlist') {
  saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
  markDone(siteId);
  saveResult(siteId, 'pillars', 1, { pillars: ['Chicken', 'Pasta', 'Soup'] });
  markDone(siteId);
  saveResult(siteId, 'search-console', 1, { confirmed: true });
  markDone(siteId);
  if (step === 'shortlist') {
    saveResult(siteId, 'keywords', 1, {
      pillar: 'Chicken',
      keywords: [
        'Honey garlic chicken thighs',
        ...Array.from({ length: 10 }, (_, i) => `easy chicken dinner ${i}`),
      ],
    });
    markDone(siteId);
  }
  expect(goTo(siteId, step)).toBe(true);
  expect(getCursor(siteId).step).toBe(step);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/guide-assistant.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/guide/assistant.ts`**

```ts
import { findDuplicate } from '../core/similar-title.js';
import { getSite } from '../db/repos.js';
import { NoEndpointAvailableError } from '../llm/client.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { tryParseJson } from '../pipeline/json.js';
import {
  addMessage,
  existingKeywordsForSite,
  getCursor,
  getResult,
  listMessages,
  siteContext,
} from './state.js';
import { stepDef, validateResult, type KeywordsResult, type StepKey } from './steps.js';

const log = createLogger('guide');

/**
 * The guide's assistant: one model call per message, with the site's own
 * decisions folded into the variables so it never asks twice.
 *
 * The model is reached through `ask`, which the server wires to askPrompt --
 * the same endpoint pool and failover the pipeline uses -- and tests replace.
 */

export type Ask = (promptName: string, variables: Record<string, unknown>) => Promise<string>;
export type Suggest = (seeds: string[]) => Promise<string[]>;

export interface AssistantDeps {
  ask: Ask;
  suggest: Suggest;
}

export interface AssistantReply {
  message: string;
  choices: string[];
  multi: boolean;
  draft: unknown | null;
}

export interface ParsedReply {
  reply: AssistantReply;
  /** Step 4 only: phrases to check against Google before picking. */
  seeds: string[];
  pillar: string;
  /** Why a draft was rejected, to hand back to the model once. */
  problem: string | null;
}

/** What the "I'm stuck" button sends. */
export const STUCK_TEXT = "I'm stuck. Break this into tiny steps and ask me one easy question.";

const CONFUSED: AssistantReply = {
  message: 'I got confused — tap 🔄 to try again.',
  choices: ['🔄 Try again'],
  multi: false,
  draft: null,
};

const UNREACHABLE: AssistantReply = {
  message: "The assistant can't reach a model right now. You can still type your answer in the box below.",
  choices: [],
  multi: false,
  draft: null,
};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    : [];

export function parseReply(raw: string, step: StepKey): ParsedReply | null {
  const parsed = tryParseJson<Record<string, unknown>>(raw);
  if (!parsed) return null;
  const v = parsed.value;

  const message = typeof v.message === 'string' ? v.message.trim() : '';
  if (!message) return null;

  let draft: unknown = null;
  let problem: string | null = null;
  if (v.draft !== null && v.draft !== undefined) {
    const checked = validateResult(step, v.draft);
    if (checked.ok) draft = checked.value;
    else problem = checked.problem;
  }

  return {
    reply: { message, choices: strings(v.choices).slice(0, 8), multi: v.multi === true, draft },
    seeds: strings(v.seeds),
    pillar: typeof v.pillar === 'string' ? v.pillar.trim() : '',
    problem,
  };
}

function historyText(siteId: number, step: StepKey, round: number): string {
  const lines = listMessages(siteId, step, round)
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'THEM' : 'YOU'}: ${m.content}`);
  return lines.length ? lines.join('\n') : '(nothing yet)';
}

/** Step-specific data the prompt needs, computed fresh each call. */
function initialExtra(siteId: number, step: StepKey, round: number): Record<string, unknown> {
  if (step === 'keywords') return { phase: 'start' };
  if (step === 'shortlist') {
    const collected = getResult<KeywordsResult>(siteId, 'keywords', round);
    const existing = existingKeywordsForSite(siteId).map((title) => ({ title, url: null }));
    const keywords: string[] = [];
    const alreadyHave: string[] = [];
    for (const keyword of collected?.keywords ?? []) {
      (findDuplicate(keyword, existing) ? alreadyHave : keywords).push(keyword);
    }
    return { pillar: collected?.pillar ?? '', keywords, already_have: alreadyHave };
  }
  return {};
}

export async function respond(
  deps: AssistantDeps,
  siteId: number,
  userText: string | null,
): Promise<AssistantReply> {
  const cursor = getCursor(siteId);
  const def = stepDef(cursor.step);
  const site = getSite(siteId);
  if (!def.prompt || !site) {
    return { message: 'There is no assistant on this step.', choices: [], multi: false, draft: null };
  }
  const prompt = def.prompt;

  const text = (userText ?? '').trim();
  // History first, so it holds what came before this message, not the message itself.
  const history = historyText(siteId, cursor.step, cursor.round);
  if (text) addMessage(siteId, cursor.step, cursor.round, 'user', text);

  const ctx = siteContext(siteId, cursor.round);
  const base = {
    site_name: site.name,
    site_domain: site.domain,
    identity: ctx.identity || '(not decided yet)',
    pillars: ctx.pillars.join(', ') || '(not decided yet)',
    current_pillar: ctx.currentPillar || '(not chosen yet)',
    step_title: def.title,
    step_goal: def.goal,
    user_text: text,
    history,
  };

  const call = async (extra: Record<string, unknown>): Promise<ParsedReply | null> =>
    parseReply(await deps.ask(prompt, { ...base, extra }), cursor.step);

  try {
    let extra = initialExtra(siteId, cursor.step, cursor.round);
    let parsed = await call(extra);

    // Step 4: the model proposes seeds, Google says what people really type,
    // and the model picks only from that. The "checking…" reply is not kept.
    if (parsed && cursor.step === 'keywords' && parsed.seeds.length) {
      const suggestions = await deps.suggest(parsed.seeds);
      extra = {
        phase: 'pick',
        pillar: parsed.pillar || ctx.currentPillar,
        suggestions,
        verified: suggestions.length > 0,
      };
      parsed = await call(extra);
    }

    // One second chance for a draft that did not fit its shape.
    if (parsed?.problem) {
      parsed = await call({ ...extra, problem: parsed.problem });
      if (parsed?.problem) parsed = null;
    }

    if (!parsed) return CONFUSED;

    const out = parsed.reply;
    if (cursor.step === 'keywords' && out.draft && extra.verified === false) {
      (out.draft as KeywordsResult).verified = false;
    }

    addMessage(siteId, cursor.step, cursor.round, 'assistant', out.message, {
      choices: out.choices,
      multi: out.multi,
      draft: out.draft,
    });
    return out;
  } catch (err) {
    if (err instanceof NoEndpointAvailableError) return UNREACHABLE;
    log.warn(`guide assistant failed on ${cursor.step}: ${errorMessage(err)}`);
    return CONFUSED;
  }
}
```

Check before running: `createLogger` and `errorMessage` are exported from `src/lib/logger.ts` (they are imported that way in `src/llm/pool.ts`). `NoEndpointAvailableError`'s constructor is `(model: string, tried: string[], lastError: string)` (see `src/llm/client.ts:38-46`); adjust the test's `new NoEndpointAvailableError(...)` call if the signature differs.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/guide-assistant.test.ts`
Expected: PASS. If the step 5 test's `already_have` casing differs, it is because `existingKeywordsForSite` returns the stored spelling while the comparison list is the collected list — the expected value is the **collected** spelling (`'Honey garlic chicken thighs'`), which is what the code pushes.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/guide/assistant.ts test/guide-assistant.test.ts
git commit -m "Give every guide step an assistant that drafts, checks, and remembers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Import the shortlist

**Files:**
- Create: `src/guide/import.ts`
- Test: `test/guide-import.test.ts`

**Interfaces:**
- Consumes: `ShortlistItem` (Task 1); `get`, `transaction` from `src/db/index.ts`; `insertKeyword`, `setLink`, `setKeywordStatus` from `src/db/repos.ts`.
- Produces: `importShortlist(siteId: number, pillar: string, items: ShortlistItem[]): number[]` — keyword ids in item order.

- [ ] **Step 1: Write the failing test**

Create `test/guide-import.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, openDatabase } from '../src/db/index.js';
import { getKeyword, insertKeyword, setKeywordStatus, upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import { importShortlist } from '../src/guide/import.js';

/**
 * The last step of a pillar round: the shortlist becomes ordinary keywords,
 * switched on for this site, so the scheduler writes them like any other.
 */

const KEY = randomBytes(32);
let siteId = 0;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  siteId = upsertSite(
    {
      name: 'bitespoon',
      domain: 'bitespoon.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 1,
      interval_minutes: 0,
    },
    KEY,
  );
});
afterEach(() => closeDatabase());

describe('importShortlist', () => {
  it('adds each item as a keyword switched on for the site', () => {
    const ids = importShortlist(siteId, 'Chicken', [
      { keyword: 'chicken dinner guide', type: 'article' },
      { keyword: 'crispy chicken thighs', type: 'recipe' },
    ]);
    expect(ids).toHaveLength(2);

    const article = getKeyword(ids[0])!;
    expect(article).toMatchObject({
      seed_keyword: 'chicken dinner guide',
      content_type: 'article',
      niche: 'Chicken',
      annotation: 'guide:Chicken',
      status: 'go',
    });
    expect(getKeyword(ids[1])).toMatchObject({ content_type: 'recipe', niche: '' });

    const links = all<{ keyword_id: number; status: string }>(
      'SELECT keyword_id, status FROM keyword_sites WHERE site_id = ? ORDER BY keyword_id',
      siteId,
    );
    expect(links).toEqual(ids.map((keyword_id) => ({ keyword_id, status: 'go' })));
  });

  it('links an exact existing keyword instead of adding it twice', () => {
    const existing = insertKeyword({ seed_keyword: 'Crispy Chicken Thighs' });
    setKeywordStatus(existing, 'done');

    const ids = importShortlist(siteId, 'Chicken', [{ keyword: 'crispy chicken thighs', type: 'recipe' }]);

    expect(ids).toEqual([existing]);
    expect(getKeyword(existing)?.status).toBe('go');
    expect(all('SELECT id FROM keywords')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/guide-import.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/guide/import.ts`**

```ts
import { get, transaction } from '../db/index.js';
import { insertKeyword, setKeywordStatus, setLink } from '../db/repos.js';
import type { ShortlistItem } from './steps.js';

/**
 * The shortlist, into Keywords.
 *
 * Each item becomes a keyword switched on for this site, and nothing else --
 * the scheduler then writes them at the site's own pace. An exact match of a
 * keyword that already exists is reused rather than added twice; the operator
 * just chose it for this site, so it is switched back on.
 *
 * `annotation` records where it came from, so a keyword list can tell guide
 * keywords from imported ones.
 */
export function importShortlist(siteId: number, pillar: string, items: ShortlistItem[]): number[] {
  return transaction(() =>
    items.map((item) => {
      const existing = get<{ id: number }>(
        'SELECT id FROM keywords WHERE lower(trim(seed_keyword)) = lower(trim(?)) ORDER BY id LIMIT 1',
        item.keyword,
      );

      const id =
        existing?.id ??
        insertKeyword({
          seed_keyword: item.keyword,
          content_type: item.type,
          niche: item.type === 'article' ? pillar : '',
          annotation: `guide:${pillar}`,
          status: 'go',
        });

      if (existing) setKeywordStatus(id, 'go');
      setLink(id, siteId, 'go');
      return id;
    }),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/guide-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/guide/import.ts test/guide-import.test.ts
git commit -m "Send a guide shortlist into Keywords, switched on for its site

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The pages

**Files:**
- Modify: `src/web/views/layout.ts:101-106` (Content section pages)
- Create: `src/web/views/guide.ts`
- Modify: `test/navigation.test.ts` (add two cases)
- Test: `test/guide-views.test.ts`

**Interfaces:**
- Consumes: `html`, `raw`, `escapeHtml`, `Html` from `src/web/views/layout.ts`; Task 1 `StepDef`, `StepKey`, `ShortlistResult`, `KeywordsResult`; Task 2 `GuideMessage`, `SiteProgress`; Task 5 `STUCK_TEXT`.
- Produces:
  - `interface GuideListRow { site: { id: number; name: string; domain: string }; progress: SiteProgress; stepTitle: string }`
  - `guideListPage(rows: GuideListRow[]): Html`
  - `interface GuideCardData { site: { id: number; name: string; domain: string }; step: StepDef; index: number; total: number; round: number; currentPillar: string; messages: GuideMessage[]; result: unknown | null; map: { def: StepDef; state: 'done' | 'current' | 'open' | 'locked' }[]; finished: boolean }`
  - `guideCardPage(data: GuideCardData): Html`
  - `summarizeResult(step: StepKey, result: unknown): string[]`

- [ ] **Step 1: Write the failing tests**

In `test/navigation.test.ts`, add these two rows to the `it.each([...])` table, after `['/keywords/7', 'Content'],`:

```ts
    ['/guide', 'Content'],
    ['/guide/3', 'Content'],
```

Create `test/guide-views.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { guideCardPage, guideListPage, summarizeResult } from '../src/web/views/guide.js';
import { STEPS, stepDef } from '../src/guide/steps.js';

/**
 * One card on screen, never a wall: the map exists but is closed, the chat is
 * there, and what has been decided is shown in plain words.
 */

const site = { id: 3, name: 'Bitespoon', domain: 'bitespoon.com' };

describe('guide views', () => {
  it('lists sites with where each one is', () => {
    const out = guideListPage([
      {
        site,
        progress: { started: true, step: 'pillars', index: 2, total: 6, round: 1, finished: false },
        stepTitle: 'Pick 3 pillar topics',
      },
    ]).toString();
    expect(out).toContain('Step 2 of 6');
    expect(out).toContain('href="/guide/3"');
    expect(out).toContain('Continue');
  });

  it('shows one card, the chat, and a closed map', () => {
    const out = guideCardPage({
      site,
      step: stepDef('pillars'),
      index: 2,
      total: 6,
      round: 1,
      currentPillar: '',
      messages: [
        { id: 1, role: 'assistant', content: 'Tap 3 <b>', payload: { choices: ['A', 'B'], multi: true }, created_at: '' },
      ],
      result: null,
      map: STEPS.map((def, i) => ({ def, state: i === 0 ? 'done' : i === 1 ? 'current' : 'locked' })),
      finished: false,
    }).toString();
    expect(out).toContain('Step 2 of 6');
    expect(out).toContain('Pick 3 pillar topics');
    expect(out).toContain('Tap 3 &lt;b&gt;');
    expect(out).toContain('<details class="guide-map">');
    expect(out).not.toContain('<details class="guide-map" open');
    expect(out).toContain('data-chat-url="/guide/3/chat"');
    expect(out).toContain('name="manual"');
  });

  it('says what a saved result is in plain words', () => {
    expect(summarizeResult('identity', { identity: 'Dinners for parents' })).toEqual(['Dinners for parents']);
    expect(summarizeResult('pillars', { pillars: ['A', 'B', 'C'] })).toEqual(['A', 'B', 'C']);
    expect(
      summarizeResult('shortlist', {
        pillar: 'P',
        items: [{ keyword: 'g', type: 'article' }, { keyword: 'r', type: 'recipe' }],
      }),
    ).toEqual(['Article: g', 'Recipe: r']);
    expect(summarizeResult('identity', null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/navigation.test.ts test/guide-views.test.ts`
Expected: FAIL — `/guide` has no section; `guide.js` not found.

- [ ] **Step 3: Add Guide to the menu**

In `src/web/views/layout.ts`, change the Content section's `pages` to put Guide first:

```ts
    pages: [
      { href: '/guide', label: 'Guide' },
      { href: '/runs', label: 'Posts' },
      { href: '/flow', label: 'Flow' },
      { href: '/keywords', label: 'Keywords' },
      { href: '/reels', label: 'Reels' },
    ],
```

Leave the section's own `href: '/runs'` as it is.

- [ ] **Step 4: Write `src/web/views/guide.ts`**

```ts
import { html, raw, type Html } from './layout.js';
import { STUCK_TEXT } from '../../guide/assistant.js';
import type { GuideMessage, SiteProgress } from '../../guide/state.js';
import type {
  IdentityResult,
  KeywordsResult,
  PillarsResult,
  ShortlistResult,
  StepDef,
  StepKey,
} from '../../guide/steps.js';

/**
 * The content guide.
 *
 * Built for someone who loses the thread in long pages: one card, one step,
 * the assistant speaking first, and the full map folded away until asked for.
 */

export interface GuideListRow {
  site: { id: number; name: string; domain: string };
  progress: SiteProgress;
  stepTitle: string;
}

export function guideListPage(rows: GuideListRow[]): Html {
  return html`
    <div class="page-head"><h1>Guide</h1></div>
    <p class="muted">Pick one site and follow it step by step. The assistant helps on every step.</p>
    <div class="guide-sites">
      ${rows.length
        ? rows.map(
            (r) => html`
              <div class="card guide-site">
                <div>
                  <strong>${r.site.name}</strong> <span class="muted">${r.site.domain}</span>
                  <div class="muted">
                    ${r.progress.started
                      ? r.progress.finished
                        ? `Pillar ${r.progress.round} done — ready for the next one`
                        : `Step ${r.progress.index} of ${r.progress.total} · ${r.stepTitle}`
                      : 'Not started'}
                  </div>
                </div>
                <a class="btn primary" href="/guide/${r.site.id}">${r.progress.started ? 'Continue' : 'Start'}</a>
              </div>
            `,
          )
        : html`<p>Add a site under Channels first.</p>`}
    </div>
  `;
}

export interface GuideCardData {
  site: { id: number; name: string; domain: string };
  step: StepDef;
  index: number;
  total: number;
  round: number;
  currentPillar: string;
  messages: GuideMessage[];
  result: unknown | null;
  map: { def: StepDef; state: 'done' | 'current' | 'open' | 'locked' }[];
  finished: boolean;
}

/** A saved result in plain words, one line per item. */
export function summarizeResult(step: StepKey, result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  switch (step) {
    case 'identity':
      return [(result as IdentityResult).identity];
    case 'pillars':
      return (result as PillarsResult).pillars;
    case 'search-console':
      return ['Connected'];
    case 'keywords': {
      const r = result as KeywordsResult;
      return [
        `${r.keywords.length} keywords for “${r.pillar}”${r.verified ? '' : ' (unchecked guesses)'}`,
        ...r.keywords,
      ];
    }
    case 'shortlist':
      return (result as ShortlistResult).items.map(
        (i) => `${i.type === 'article' ? 'Article' : 'Recipe'}: ${i.keyword}`,
      );
    case 'import':
      return ['Added to Keywords'];
  }
}

const MANUAL_HINT: Record<StepKey, string> = {
  identity: 'One line: who the site is for.',
  pillars: 'Three lines, one pillar each.',
  'search-console': '',
  keywords: 'First line: the pillar. Then one keyword per line.',
  shortlist: 'First line: the pillar article. Then one recipe per line.',
  import: '',
};

function bubble(m: GuideMessage): Html {
  return html`<div class="guide-msg ${m.role}">${m.content}</div>`;
}

function savedBlock(data: GuideCardData): Html {
  const lines = summarizeResult(data.step.key, data.result);
  return html`
    <div class="guide-saved">
      <h3>Saved</h3>
      ${lines.length
        ? html`<ul>${lines.slice(0, 60).map((l) => html`<li>${l}</li>`)}</ul>`
        : html`<p class="muted">Nothing yet.</p>`}
    </div>
  `;
}

function manualForm(data: GuideCardData): Html {
  const id = data.site.id;
  if (data.step.key === 'search-console') {
    return html`
      <form method="post" action="/guide/${id}/save" class="guide-manual">
        <label><input type="checkbox" name="confirmed" value="1" required /> I’ve done this</label>
        <button class="btn" type="submit">Save</button>
      </form>
    `;
  }
  if (data.step.key === 'import') return html``;
  return html`
    <details class="guide-manual">
      <summary>Or type it yourself</summary>
      <form method="post" action="/guide/${id}/save">
        <p class="muted">${MANUAL_HINT[data.step.key]}</p>
        <textarea name="manual" rows="5"></textarea>
        <button class="btn" type="submit">Save</button>
      </form>
    </details>
  `;
}

function importBlock(data: GuideCardData): Html {
  const id = data.site.id;
  if (data.finished) {
    return html`
      <div class="guide-finished">
        <p><strong>Done!</strong> These keywords are in Keywords and will be written on the site’s normal schedule.</p>
        <form method="post" action="/guide/${id}/next-pillar">
          <button class="btn primary" type="submit">Start next pillar →</button>
        </form>
      </div>
    `;
  }
  const shortlist = data.result as ShortlistResult | null;
  return html`<p class="muted">Untick anything you changed your mind about.</p>
    <form method="post" action="/guide/${id}/import" class="guide-import">
      <ul>
        ${(shortlist?.items ?? []).map(
          (item, i) => html`<li><label>
            <input type="checkbox" name="pick" value="${i}" checked />
            ${item.type === 'article' ? 'Article' : 'Recipe'}: ${item.keyword}
          </label></li>`,
        )}
      </ul>
      <button class="btn primary" type="submit">Add to Keywords</button>
    </form>`;
}

export function guideCardPage(data: GuideCardData): Html {
  const id = data.site.id;
  const pct = Math.round(((data.index - 1) / data.total) * 100);
  const last = [...data.messages].reverse().find((m) => m.role === 'assistant');
  const hasAssistant = data.step.prompt !== null;

  return html`
    <div class="guide-card card">
      <div class="guide-head">
        <span><a href="/guide">Guide</a> › ${data.site.domain}${data.step.perRound ? ` · Pillar ${data.round}` : ''}</span>
        <span>Step ${data.index} of ${data.total}</span>
      </div>
      <div class="guide-progress"><div style="width:${pct}%"></div></div>

      <h1>${data.step.title}</h1>
      <p><strong>Why:</strong> ${data.step.why}</p>
      <details><summary>How</summary><ul>${data.step.how.map((h) => html`<li>${h}</li>`)}</ul></details>

      ${data.step.key === 'import'
        ? importBlock(data)
        : html`${hasAssistant
              ? html`
                  <div
                    class="guide-chat"
                    id="guide-chat"
                    data-chat-url="/guide/${id}/chat"
                    data-save-url="/guide/${id}/save"
                    data-stuck="${STUCK_TEXT}"
                    data-empty="${data.messages.length === 0 ? '1' : ''}"
                    data-last="${last ? JSON.stringify(last.payload) : ''}"
                  >
                    <div class="guide-log" id="guide-log">${data.messages.map(bubble)}</div>
                    <div class="guide-controls" id="guide-controls"></div>
                    <form class="guide-send" id="guide-send">
                      <input type="text" name="text" placeholder="Type here if you want…" autocomplete="off" />
                      <button class="btn" type="submit">Send</button>
                    </form>
                    <div class="guide-quick">
                      <button class="btn" type="button" data-say="Give me other ideas.">🔄 Other ideas</button>
                      <button class="btn" type="button" data-stuck-button>😵 I’m stuck</button>
                    </div>
                  </div>
                `
              : html``}
            ${savedBlock(data)} ${manualForm(data)}`}

      <div class="guide-nav">
        <form method="post" action="/guide/${id}/back">
          <button class="btn" type="submit" ${data.index === 1 ? raw('disabled') : raw('')}>← Back</button>
        </form>
        ${data.step.key === 'import'
          ? html``
          : html`<form method="post" action="/guide/${id}/done">
              <button class="btn primary" type="submit" ${data.result ? raw('') : raw('disabled')}>Done →</button>
            </form>`}
      </div>
    </div>

    <details class="guide-map">
      <summary>See the whole map</summary>
      <ol>
        ${data.map.map(({ def, state }) =>
          state === 'locked'
            ? html`<li class="locked">${def.title}</li>`
            : html`<li class="${state}"><a href="/guide/${id}/step/${def.key}">${state === 'done' ? '✓ ' : ''}${def.title}</a></li>`,
        )}
      </ol>
    </details>
    ${raw(GUIDE_SCRIPT)}
  `;
}

/**
 * The chat. Plain DOM, textContent only -- model text is never parsed as HTML.
 * A reply's chips and draft replace the controls; "Use this" posts the draft
 * to /save as a normal form so the page reloads with it saved.
 */
const GUIDE_SCRIPT = `<script>
(function () {
  var box = document.getElementById('guide-chat');
  if (!box) return;
  var log = document.getElementById('guide-log');
  var controls = document.getElementById('guide-controls');
  var form = document.getElementById('guide-send');
  var busy = false;

  function bubble(role, text) {
    var div = document.createElement('div');
    div.className = 'guide-msg ' + role;
    div.textContent = text;
    log.appendChild(div);
    div.scrollIntoView({ block: 'nearest' });
    return div;
  }

  function draftLines(d) {
    if (!d) return [];
    if (d.identity) return [d.identity];
    if (d.pillars) return d.pillars;
    if (d.keywords) return [d.keywords.length + ' keywords for \\u201c' + d.pillar + '\\u201d'].concat(d.keywords);
    if (d.items) return d.items.map(function (i) { return (i.type === 'article' ? 'Article: ' : 'Recipe: ') + i.keyword; });
    return [];
  }

  function button(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + (cls || '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function show(payload) {
    controls.textContent = '';
    if (!payload) return;
    var choices = payload.choices || [];
    var picked = [];
    if (choices.length) {
      var row = document.createElement('div');
      row.className = 'guide-chips';
      choices.forEach(function (c) {
        var chip = button(c, 'chip', function () {
          if (!payload.multi) return send(c);
          var at = picked.indexOf(c);
          if (at >= 0) { picked.splice(at, 1); chip.classList.remove('on'); }
          else { picked.push(c); chip.classList.add('on'); }
        });
        row.appendChild(chip);
      });
      controls.appendChild(row);
      if (payload.multi) {
        controls.appendChild(button('Send selected', 'primary', function () {
          if (picked.length) send(picked.join(', '));
        }));
      }
    }
    if (payload.draft) {
      var card = document.createElement('div');
      card.className = 'guide-draft';
      var ul = document.createElement('ul');
      draftLines(payload.draft).slice(0, 60).forEach(function (l) {
        var li = document.createElement('li');
        li.textContent = l;
        ul.appendChild(li);
      });
      card.appendChild(ul);
      card.appendChild(button('\\ud83d\\udc4d Use this', 'primary', function () { save(payload.draft); }));
      card.appendChild(button('\\u270f\\ufe0f Change it', '', function () {
        form.elements.text.focus();
      }));
      controls.appendChild(card);
    }
  }

  function save(draft) {
    var f = document.createElement('form');
    f.method = 'post';
    f.action = box.dataset.saveUrl;
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'draft_json';
    input.value = JSON.stringify(draft);
    f.appendChild(input);
    document.body.appendChild(f);
    f.submit();
  }

  function send(text) {
    if (busy) return;
    busy = true;
    if (text) bubble('user', text);
    controls.textContent = '';
    var wait = bubble('assistant thinking', 'Thinking\\u2026');
    fetch(box.dataset.chatUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text || null })
    })
      .then(function (r) { return r.json(); })
      .then(function (reply) {
        wait.remove();
        bubble('assistant', reply.message);
        show(reply);
      })
      .catch(function () {
        wait.remove();
        bubble('assistant', 'Something went wrong. Try again in a moment.');
      })
      .then(function () { busy = false; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = form.elements.text.value.trim();
    if (!text) return;
    form.elements.text.value = '';
    send(text);
  });

  box.querySelectorAll('[data-say]').forEach(function (b) {
    b.addEventListener('click', function () { send(b.dataset.say); });
  });
  var stuck = box.querySelector('[data-stuck-button]');
  if (stuck) stuck.addEventListener('click', function () { send(box.dataset.stuck); });

  if (box.dataset.empty) send(null);
  else if (box.dataset.last) { try { show(JSON.parse(box.dataset.last)); } catch (e) {} }
})();
</script>`;
```

- [ ] **Step 5: Add the styles**

Append to `src/web/styles/input.css` (use the theme variables already defined there; check the file's top for the variable names — if it uses e.g. `--accent` / `--border`, use those; the values below assume `--border` and `--accent` exist and fall back otherwise):

```css
/* -- Content guide --------------------------------------------------------- */
.guide-sites { display: grid; gap: 0.75rem; margin-top: 1rem; }
.guide-site { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.guide-card { max-width: 46rem; margin: 0 auto; display: grid; gap: 0.75rem; }
.guide-head { display: flex; justify-content: space-between; font-size: 0.875rem; opacity: 0.8; }
.guide-progress { height: 6px; border-radius: 3px; background: var(--border, #ddd); overflow: hidden; }
.guide-progress > div { height: 100%; background: var(--accent, #2563eb); }
.guide-chat { border: 1px solid var(--border, #ddd); border-radius: 0.75rem; padding: 0.75rem; display: grid; gap: 0.5rem; }
.guide-log { display: grid; gap: 0.5rem; max-height: 22rem; overflow-y: auto; }
.guide-msg { padding: 0.5rem 0.75rem; border-radius: 0.75rem; max-width: 85%; white-space: pre-wrap; }
.guide-msg.assistant { background: var(--border, #eee); justify-self: start; }
.guide-msg.user { background: var(--accent, #2563eb); color: #fff; justify-self: end; }
.guide-msg.thinking { opacity: 0.6; font-style: italic; }
.guide-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.guide-chips .chip { border-radius: 999px; }
.guide-chips .chip.on { background: var(--accent, #2563eb); color: #fff; }
.guide-draft { border: 1px dashed var(--accent, #2563eb); border-radius: 0.5rem; padding: 0.5rem 0.75rem; display: grid; gap: 0.5rem; }
.guide-draft ul, .guide-saved ul { margin: 0; padding-left: 1.25rem; max-height: 14rem; overflow-y: auto; }
.guide-send { display: flex; gap: 0.5rem; }
.guide-send input { flex: 1; }
.guide-quick { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.guide-manual textarea { width: 100%; }
.guide-nav { display: flex; justify-content: space-between; }
.guide-map { max-width: 46rem; margin: 1rem auto 0; }
.guide-map li.locked { opacity: 0.5; }
.guide-map li.current { font-weight: 600; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/navigation.test.ts test/guide-views.test.ts`
Expected: PASS. If `navigation.test.ts` has another assertion listing Content pages exactly, add `/guide` to it.

- [ ] **Step 7: Build CSS, typecheck, full suite**

Run: `npm run build:css && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/web/views/layout.ts src/web/views/guide.ts src/web/styles/input.css src/web/public/style.css test/navigation.test.ts test/guide-views.test.ts
git commit -m "Show the guide one card at a time, with the assistant on the card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(If `src/web/public/style.css` is git-ignored, drop it from `git add`.)

---

### Task 8: Routes and a real run

**Files:**
- Modify: `src/web/server.ts` (imports at the top; routes inserted directly before `app.get('/keywords', …)` at about line 1754)
- Test: `test/guide-routes.test.ts`

**Interfaces:**
- Consumes: everything above; inside `buildServer`: `settings`, `encryptionKey`, `page`, `redirect`, `formBody`, `asString`, `asNumber`, `readFlash`; `askPrompt` from `src/llm/ask.ts`; `listSites`, `getSite` from `src/db/repos.ts`.
- Produces: the routes in the spec's route table.

- [ ] **Step 1: Write the failing test**

Look at `test/auth.test.ts` lines 1–60 for how it builds the server and logs in (it calls `buildServer(new Settings(KEY), KEY, { password: PASSWORD, … })` and has a `login` helper that returns a cookie). Copy that setup into `test/guide-routes.test.ts`, then add:

```ts
// (setup copied from test/auth.test.ts: openDatabase(':memory:'), buildServer, login → cookie)

it('lists sites and opens a card', async () => {
  const siteId = upsertSite(
    { name: 'Bitespoon', domain: 'bitespoon.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 0 },
    KEY,
  );
  const cookie = await loginCookie();

  const list = await app.inject({ method: 'GET', url: '/guide', headers: { cookie } });
  expect(list.statusCode).toBe(200);
  expect(list.body).toContain('bitespoon.com');

  const card = await app.inject({ method: 'GET', url: `/guide/${siteId}`, headers: { cookie } });
  expect(card.statusCode).toBe(200);
  expect(card.body).toContain('Step 1 of 6');
});

it('saves a typed result and moves on with Done', async () => {
  const siteId = upsertSite(
    { name: 'Bitespoon', domain: 'bitespoon.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 0 },
    KEY,
  );
  const cookie = await loginCookie();
  const form = { 'content-type': 'application/x-www-form-urlencoded', cookie };

  const refused = await app.inject({ method: 'POST', url: `/guide/${siteId}/done`, headers: form, payload: '' });
  expect(refused.headers.location).toContain('warn=');

  await app.inject({
    method: 'POST',
    url: `/guide/${siteId}/save`,
    headers: form,
    payload: 'manual=' + encodeURIComponent('Quick dinners for busy parents'),
  });
  const done = await app.inject({ method: 'POST', url: `/guide/${siteId}/done`, headers: form, payload: '' });
  expect(done.statusCode).toBe(303);

  const card = await app.inject({ method: 'GET', url: `/guide/${siteId}`, headers: { cookie } });
  expect(card.body).toContain('Step 2 of 6');
});

it('answers 404 for a site that does not exist', async () => {
  const cookie = await loginCookie();
  const res = await app.inject({ method: 'GET', url: '/guide/999', headers: { cookie } });
  expect(res.statusCode).toBe(404);
});
```

`loginCookie()` is the auth test's login helper returning the `set-cookie` value; name it to match whatever `test/auth.test.ts` does.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/guide-routes.test.ts`
Expected: FAIL — `/guide` returns 404.

- [ ] **Step 3: Add imports to `src/web/server.ts`**

Next to the other imports at the top:

```ts
import { guideCardPage, guideListPage } from './views/guide.js';
import { respond, type AssistantDeps } from '../guide/assistant.js';
import { importShortlist } from '../guide/import.js';
import {
  canOpen,
  getCursor,
  getResult,
  getStatus,
  goBack,
  goTo,
  isRoundFinished,
  listMessages,
  markDone,
  progressFor,
  saveResult,
  siteContext,
  startNextPillar,
} from '../guide/state.js';
import { isStepKey, manualResult, stepDef, stepIndex, STEPS, type ShortlistResult } from '../guide/steps.js';
import { expandSeeds } from '../integrations/google-suggest.js';
```

If `askPrompt` is not yet imported in `server.ts`, add `import { askPrompt } from '../llm/ask.js';`. `listSites` and `getSite` are already imported from `../db/repos.js` (they are used by `/sites` routes); if not, add them to that import.

- [ ] **Step 4: Add the routes**

Insert directly before `app.get('/keywords', async (request, reply) => {`:

```ts
  /* -- Guide --------------------------------------------------------------- */

  // The assistant reaches the model the same way the pipeline does: the prompt
  // page's model choice, the endpoint pool, its failover.
  const guideDeps: AssistantDeps = {
    ask: async (promptName, variables) =>
      (await askPrompt(settings, encryptionKey, promptName, variables)).content,
    suggest: (seeds) => expandSeeds(seeds),
  };

  const guideSite = (request: FastifyRequest) => {
    const id = asNumber((request.params as { siteId: string }).siteId, 0);
    return getSite(id) ?? null;
  };

  const renderCard = (reply: FastifyReply, siteId: number, flash: Flash) => {
    const site = getSite(siteId)!;
    const cursor = getCursor(siteId);
    const def = stepDef(cursor.step);
    // The import card shows the shortlist; every other card shows its own result.
    const result =
      cursor.step === 'import' && !isRoundFinished(siteId)
        ? getResult<ShortlistResult>(siteId, 'shortlist', cursor.round)
        : getResult(siteId, cursor.step, cursor.round);
    const map = STEPS.map((s) => ({
      def: s,
      state:
        s.key === cursor.step
          ? ('current' as const)
          : getStatus(siteId, s.key, cursor.round) === 'done'
            ? ('done' as const)
            : canOpen(siteId, s.key)
              ? ('open' as const)
              : ('locked' as const),
    }));
    return page(
      reply,
      `Guide · ${site.domain}`,
      '/guide',
      guideCardPage({
        site: { id: site.id, name: site.name, domain: site.domain },
        step: def,
        index: stepIndex(cursor.step) + 1,
        total: STEPS.length,
        round: cursor.round,
        currentPillar: siteContext(siteId, cursor.round).currentPillar,
        messages: listMessages(siteId, cursor.step, cursor.round),
        result,
        map,
        finished: isRoundFinished(siteId),
      }),
      flash,
    );
  };

  app.get('/guide', async (request, reply) => {
    const rows = listSites().map((site) => {
      const progress = progressFor(site.id);
      return {
        site: { id: site.id, name: site.name, domain: site.domain },
        progress,
        stepTitle: stepDef(progress.step).title,
      };
    });
    return page(reply, 'Guide', '/guide', guideListPage(rows), readFlash(request.query));
  });

  app.get('/guide/:siteId', async (request, reply) => {
    const site = guideSite(request);
    if (!site) return reply.status(404).send('No such site.');
    return renderCard(reply, site.id, readFlash(request.query));
  });

  app.get('/guide/:siteId/step/:key', async (request, reply) => {
    const site = guideSite(request);
    if (!site) return reply.status(404).send('No such site.');
    const key = (request.params as { key: string }).key;
    if (!isStepKey(key) || !goTo(site.id, key)) {
      return redirect(reply, `/guide/${site.id}`, { kind: 'warn', message: 'That step is not open yet.' });
    }
    return redirect(reply, `/guide/${site.id}`);
  });

  app.post('/guide/:siteId/chat', async (request, reply) => {
    const site = guideSite(request);
    if (!site) return reply.status(404).send({ message: 'No such site.', choices: [], multi: false, draft: null });
    const body = formBody(request);
    const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : null;
    return reply.send(await respond(guideDeps, site.id, text));
  });

  app.post('/guide/:siteId/save', async (request, reply) => {
    const site = guideSite(request);
    if (!site) return reply.status(404).send('No such site.');
    const back = `/guide/${site.id}`;
    const body = formBody(request);
    const cursor = getCursor(site.id);

    let value: unknown;
    const draftJson = asString(body.draft_json);
    if (draftJson) {
      try {
        value = JSON.parse(draftJson);
      } catch {
        return redirect(reply, back, { kind: 'error', message: 'That draft could not be read.' });
      }
    } else if (cursor.step === 'search-console') {
      value = { confirmed: asString(body.confirmed) === '1' };
    } else {
      value = manualResult(
        cursor.step,
        asString(body.manual),
        siteContext(site.id, cursor.round).currentPillar,
      );
    }

    const saved = saveResult(site.id, cursor.step, cursor.round, value);
    return saved.ok
      ? redirect(reply, back, { kind: 'ok', message: 'Saved. Press Done when you are happy with it.' })
      : redirect(reply, back, { kind: 'warn', message: saved.problem });
  });

  app.post('/guide/:siteId/done', async (request, reply) => {
    const site = guideSite(request);
    if (!site) return reply.status(404).send('No such site.');
    const done = markDone(site.id);
    return done.ok
      ? redirect(reply, `/guide/${site.id}`)
      : redirect(reply, `/guide/${site.id}`, { kind: 'warn', message: done.problem });
  });

  app.post('/guide/:siteId/back', async (request, reply) => {
    const site = guideSite(request);
    if (!site) return reply.status(404).send('No such site.');
    goBack(site.id);
    return redirect(reply, `/guide/${site.id}`);
  });

  app.post('/guide/:siteId/import', async (request, reply) => {
    const site = guideSite(request);
    if (!site) return reply.status(404).send('No such site.');
    const back = `/guide/${site.id}`;
    const cursor = getCursor(site.id);
    const shortlist = getResult<ShortlistResult>(site.id, 'shortlist', cursor.round);
    if (cursor.step !== 'import' || !shortlist) {
      return redirect(reply, back, { kind: 'warn', message: 'Finish the shortlist first.' });
    }

    const picked = formBody(request).pick;
    const indexes = new Set(
      (Array.isArray(picked) ? picked : picked === undefined ? [] : [picked]).map((v) => asNumber(v, -1)),
    );
    const items = shortlist.items.filter((_, i) => indexes.has(i));
    if (!items.length) return redirect(reply, back, { kind: 'warn', message: 'Nothing was ticked.' });

    const ids = importShortlist(site.id, shortlist.pillar, items);
    saveResult(site.id, 'import', cursor.round, { imported_ids: ids });
    markDone(site.id);
    return redirect(reply, back, {
      kind: 'ok',
      message: `${ids.length} keyword(s) added — they’ll be written on the site’s normal schedule.`,
    });
  });

  app.post('/guide/:siteId/next-pillar', async (request, reply) => {
    const site = guideSite(request);
    if (!site) return reply.status(404).send('No such site.');
    return startNextPillar(site.id)
      ? redirect(reply, `/guide/${site.id}`)
      : redirect(reply, `/guide/${site.id}`, { kind: 'warn', message: 'Finish this pillar first.' });
  });
```

Note: the chat route receives JSON (`Content-Type: application/json`); Fastify parses JSON bodies by default, and `formBody` just returns the parsed object.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/guide-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Try it for real**

Run: `docker compose -f docker-compose.local.yml up -d --build` (or `npm run dev`), sign in, and open **Content → Guide**:

1. Start a site. The assistant's first question appears without pressing anything.
2. Tap chips through step 1 until a draft appears; press 👍 Use this; Saved shows the line; press Done.
3. Step 2: multi-select chips work; Send selected; Use this; Done.
4. Step 3: tick "I've done this", Save, Done.
5. Step 4: pick a pillar; after "Checking…" a list of real-looking searches appears (check the logs for no errors from Google); Use this; Done.
6. Step 5: the shortlist has 1 article and ~10 recipes; Use this; Done.
7. Step 6: untick one; Add to Keywords; the Keywords page shows the new ones switched on for the site; "Start next pillar" opens step 4 with Pillar 2.
8. Press 😵 I'm stuck on any step: the reply is shorter and asks one question.
9. Stop all LLM endpoints (Settings → LLM keys, disable) and send a message: the bubble says it can't reach a model; the "Or type it yourself" box still saves.

Fix anything that does not behave as described before committing.

- [ ] **Step 8: Commit**

```bash
git add src/web/server.ts test/guide-routes.test.ts
git commit -m "Open the content guide at Content -> Guide

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes (for the implementer)

- Spec coverage: steps 1–6 (Tasks 1, 4, 5, 6, 8), one-card UI with map, Back, Done gating, I'm stuck, manual fallback (Task 7, 8), autocomplete grounding (Tasks 3, 5), duplicate filter (Task 5), import with exact-duplicate reuse (Task 6), errors (Task 5 `UNREACHABLE` / `CONFUSED`, Task 8 404s and flashes), tests per the spec's list (Tasks 1–8). Round 2 (steps 7–11, Search Console API) is out of scope.
- Names used across tasks: `respond`, `AssistantDeps`, `STUCK_TEXT`, `importShortlist`, `getCursor`, `saveResult`, `markDone`, `goBack`, `goTo`, `canOpen`, `isRoundFinished`, `startNextPillar`, `listMessages`, `siteContext`, `progressFor`, `getResult`, `getStatus`, `manualResult`, `validateResult`, `stepDef`, `stepIndex`, `STEPS`, `isStepKey`, `expandSeeds`. Keep them exactly.
