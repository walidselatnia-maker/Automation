# SEO Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keywords imported from the content guide get checked, SEO-sound titles and descriptions written automatically at import, and the two places that already write SEO text (`validate-spy`, `plan-article`) obey the same rules.

**Architecture:** A pure rule checker (`src/seo/rules.ts`) holds every SEO rule as plain code. A writer (`src/seo/writer.ts`) asks the model for one batch of recipe titles/descriptions through an injected `ask`, checks each with the rules, re-asks only the failures (max 2 more rounds) and falls back to a safe version built from the keyword. The `/import` route calls it after the import. A tiny helper (`src/seo/refine.ts`) gives the existing pipeline steps "check, re-ask once, otherwise warn".

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify, `node:sqlite` via `src/db/index.ts`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-seo-writer-design.md`

## Global Constraints

- Display caps (they are display limits, not Google rules; say so in a comment): title ≤ 60 chars, description ≤ 160 chars.
- Title: 15–60 chars; contains every word of the focus keyword; first keyword word within the first 40 chars; no word used more than twice; no `|` or 2+ commas; not ALL CAPS; not ≥ 0.75 similar to any other title.
- Description: 70–160 chars; ends with `.`, `!` or `?`; contains every word of the keyword; the keyword phrase at most once; at most 3 commas and no `|`; not ≥ 0.75 similar to another description.
- Slug: `^[a-z0-9]+(-[a-z0-9]+)*$`; at most 6 words and 60 chars; no 4-digit year; contains every keyword word; not equal to another slug.
- Focus keyword: 3 or more words. Image alt: 10–125 chars.
- Platform content rules apply to all SEO text: no pork (turkey/beef bacon or ham is fine), no alcohol (wine vinegar is fine), no holiday terms (Christmas, Thanksgiving, Valentine's, Easter, Halloween).
- The writer only fills a recipe keyword whose `spy_title` is blank and never touches articles or existing research.
- An SEO failure must never fail an import or stop a pipeline run: fallback for the writer, warning for the pipeline steps.
- AI prompt `seo-writer` uses model `gpt-oss:120b` with `format: 'json'`, registered in `PROMPT_MODELS` and declared in `STEP_CONTEXTS`.
- Existing code style: comments explain *why*, user-facing text is plain English, no new dependencies.
- Run `npm test` and `npm run typecheck` before every commit. `test/reel-assemble.test.ts` fails on this machine because of ffmpeg and is unrelated; everything else must pass.
- End every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/seo/rules.ts` | create | Every SEO rule as pure functions, plus `rulesPrompt()` |
| `src/seo/refine.ts` | create | `refineOnce` — check, re-ask once, keep the better answer |
| `src/seo/writer.ts` | create | `draftSeo`, `fallbackFor`, `writeSeoFor` |
| `prompts/seo-writer.{system,user}.txt` | create | The writer's prompt |
| `src/pipeline/prompts.ts` | modify | Register `seo-writer` |
| `src/pipeline/prompt-contexts.ts` | modify | Declare `seo-writer` variables; add `seoRules` / `seoFeedback` to `spy-validation` and `article-outline` |
| `prompts/spy-validation.{system,user}.txt`, `prompts/article-outline.{system,user}.txt` | modify | Show the rules; carry the feedback line |
| `src/web/server.ts` | modify | `/guide/:siteId/import` calls the writer; message mentions it |
| `src/pipeline/steps/content.ts` | modify | `validate-spy` checks and re-asks once |
| `src/pipeline/steps/blog.ts` | modify | `plan-article` checks and re-asks once; exports `planSeoProblems` |
| `test/seo-rules.test.ts`, `test/seo-refine.test.ts`, `test/seo-writer.test.ts`, `test/seo-plan.test.ts`, `test/guide-routes.test.ts` | create/modify | Tests |

---

### Task 1: The SEO rules

**Files:**
- Create: `src/seo/rules.ts`
- Test: `test/seo-rules.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - constants `TITLE_MAX = 60`, `TITLE_MIN = 15`, `DESCRIPTION_MIN = 70`, `DESCRIPTION_MAX = 160`, `SLUG_MAX_WORDS = 6`, `SLUG_MAX_CHARS = 60`, `ALT_MIN = 10`, `ALT_MAX = 125`, `SIMILAR_AT = 0.75`
  - `interface CheckContext { keyword: string; others?: string[] }`
  - `words(text: string): string[]` — lower-case content words, plural `s` stripped
  - `similarity(a: string, b: string): number` — 0..1
  - `restrictedWords(text: string): string[]`
  - `checkTitle(title, ctx): string[]`, `checkDescription(text, ctx): string[]`, `checkSlug(slug, ctx): string[]`, `checkFocusKeyword(keyword): string[]`, `checkAlt(text): string[]` — each returns plain-English problems; empty = passes
  - `rulesPrompt(): string`

- [ ] **Step 1: Write the failing test**

Create `test/seo-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  checkAlt,
  checkDescription,
  checkFocusKeyword,
  checkSlug,
  checkTitle,
  restrictedWords,
  rulesPrompt,
  similarity,
  words,
} from '../src/seo/rules.js';

/**
 * Google gives no hard length limits, only "unique, descriptive, not stuffed".
 * These tests pin the stricter rules this platform applies on top, so a model
 * can be held to them in plain code instead of being trusted.
 */

const keyword = 'honey garlic chicken thighs';
const goodTitle = 'Honey Garlic Chicken Thighs With Crispy Skin';
const goodDescription =
  'Sticky honey garlic chicken thighs baked until the skin crisps, ready in under an hour.';

describe('words and similarity', () => {
  it('drops filler words and plural s', () => {
    expect(words('The Best Chicken Thighs for Dinner')).toEqual(['best', 'chicken', 'thigh', 'dinner']);
  });

  it('scores overlap from 0 to 1', () => {
    expect(similarity('honey garlic chicken', 'Honey Garlic Chicken')).toBe(1);
    expect(similarity('honey garlic chicken', 'lemon herb salmon')).toBe(0);
    expect(similarity('', '')).toBe(0);
  });
});

describe('restrictedWords', () => {
  it('flags pork, alcohol and holiday words', () => {
    expect(restrictedWords('Christmas ham with wine')).toEqual(['Christmas', 'ham', 'wine']);
  });

  it('lets turkey bacon, beef ham and wine vinegar through', () => {
    expect(restrictedWords('turkey bacon wrap with red wine vinegar and beef ham')).toEqual([]);
  });

  it('does not match inside other words', () => {
    expect(restrictedWords('eastern hamburger')).toEqual([]);
  });
});

describe('checkTitle', () => {
  it('accepts a good title', () => {
    expect(checkTitle(goodTitle, { keyword })).toEqual([]);
  });

  it('rejects one that is too long, too short or all caps', () => {
    expect(checkTitle(goodTitle + ' That Everyone Will Absolutely Love', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('characters')]),
    );
    expect(checkTitle('Chicken', { keyword }).length).toBeGreaterThan(0);
    expect(checkTitle('HONEY GARLIC CHICKEN THIGHS RECIPE', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('capitals')]),
    );
  });

  it('wants every keyword word, near the front', () => {
    expect(checkTitle('Crispy Skin Chicken Thighs', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('missing')]),
    );
    expect(
      checkTitle('A Weeknight Favourite You Will Absolutely Love: Honey Garlic Chicken Thighs', { keyword }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('start')]));
  });

  it('rejects stuffing and lists', () => {
    expect(
      checkTitle('Chicken Chicken Chicken Honey Garlic Thighs', { keyword }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('repeated')]));
    expect(checkTitle('Honey Garlic Chicken Thighs, Easy, Quick, Best', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('list')]),
    );
  });

  it('rejects restricted words and near-duplicates of other titles', () => {
    expect(checkTitle('Honey Garlic Chicken Thighs With Bacon', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('Bacon')]),
    );
    expect(
      checkTitle(goodTitle, { keyword, others: ['Honey Garlic Chicken Thighs With Crispy Skin'] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('similar')]));
  });
});

describe('checkDescription', () => {
  it('accepts a good description', () => {
    expect(checkDescription(goodDescription, { keyword })).toEqual([]);
  });

  it('wants 70 to 160 characters ending like a sentence', () => {
    expect(checkDescription('Honey garlic chicken thighs.', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('characters')]),
    );
    expect(checkDescription(goodDescription.slice(0, -1), { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('sentence')]),
    );
    expect(checkDescription(goodDescription + ' ' + 'More words here. '.repeat(10), { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('characters')]),
    );
  });

  it('wants the keyword words, once, and not a keyword list', () => {
    expect(
      checkDescription('Sticky glazed poultry baked until the skin crisps, ready in under an hour.', { keyword }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('keyword')]));
    expect(
      checkDescription(
        'Honey garlic chicken thighs are the best honey garlic chicken thighs you will bake this week.',
        { keyword },
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('once')]));
    expect(
      checkDescription(
        'Honey garlic chicken thighs, easy, quick, best, juicy, crispy, sticky dinner for busy people.',
        { keyword },
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('list')]));
  });

  it('rejects a description too like another one', () => {
    expect(checkDescription(goodDescription, { keyword, others: [goodDescription] })).toEqual(
      expect.arrayContaining([expect.stringContaining('similar')]),
    );
  });
});

describe('checkSlug', () => {
  it('accepts short descriptive words', () => {
    expect(checkSlug('honey-garlic-chicken-thighs', { keyword })).toEqual([]);
  });

  it('rejects bad characters, length, years and missing keyword words', () => {
    expect(checkSlug('Honey_Garlic', { keyword }).length).toBeGreaterThan(0);
    expect(checkSlug('honey-garlic-chicken-thighs-with-crispy-skin-and-more', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('words')]),
    );
    expect(checkSlug('honey-garlic-chicken-thighs-2026', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('year')]),
    );
    expect(checkSlug('crispy-chicken', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('missing')]),
    );
  });

  it('rejects a slug another page already has', () => {
    expect(checkSlug('honey-garlic-chicken-thighs', { keyword, others: ['honey-garlic-chicken-thighs'] })).toEqual(
      expect.arrayContaining([expect.stringContaining('already')]),
    );
  });
});

describe('focus keyword and alt text', () => {
  it('wants three or more words', () => {
    expect(checkFocusKeyword('chicken thighs')).toHaveLength(1);
    expect(checkFocusKeyword('honey garlic chicken thighs')).toEqual([]);
  });

  it('wants alt text of a sensible length', () => {
    expect(checkAlt('Sliced thighs on a plate')).toEqual([]);
    expect(checkAlt('Plate')).toHaveLength(1);
    expect(checkAlt('x'.repeat(130))).toHaveLength(1);
  });
});

describe('rulesPrompt', () => {
  it('tells the model the caps that will be checked', () => {
    const text = rulesPrompt();
    expect(text).toContain('60');
    expect(text).toContain('160');
    expect(text).toContain('keyword');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/seo-rules.test.ts`
Expected: FAIL — `Cannot find module '../src/seo/rules.js'`.

- [ ] **Step 3: Write `src/seo/rules.ts`**

```ts
/**
 * The platform's SEO rules, as code.
 *
 * Google gives no hard limits for titles or descriptions -- only "unique,
 * descriptive, readable, not stuffed". The numbers here are stricter on
 * purpose: 60 and 160 characters are where search results *cut text off*
 * (display limits, not Google rules), and the rest turn "don't stuff keywords"
 * and "write something different for every page" into things a program can
 * check. Every check returns plain-English problems, so the same text can be
 * shown to a model that must fix them.
 */

export const TITLE_MAX = 60;
export const TITLE_MIN = 15;
export const DESCRIPTION_MIN = 70;
export const DESCRIPTION_MAX = 160;
export const SLUG_MAX_WORDS = 6;
export const SLUG_MAX_CHARS = 60;
export const ALT_MIN = 10;
export const ALT_MAX = 125;
/** At or above this word overlap, two texts read as the same page. */
export const SIMILAR_AT = 0.75;

export interface CheckContext {
  /** The phrase the page should be found for. */
  keyword: string;
  /** Texts already in use on the site (titles, descriptions or slugs). */
  others?: string[];
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'with', 'to', 'in', 'on', 'at', 'or',
  'is', 'it', 'this', 'that', 'your', 'my', 'you', 'we', 'will', 'are', 'be',
]);

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Lower-case content words, so "Thighs" and "thigh" count as the same word. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/** Share of words two texts have in common, 0 (nothing) to 1 (same words). */
export function similarity(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// The platform's existing content rules (the spy-validation prompt), not new
// policy. Turkey/beef bacon and ham and wine vinegar are the sanctioned
// substitutes and so are allowed.
const RESTRICTED: RegExp[] = [
  /\bvalentine(?:['’]?s)?\b|\b(?:christmas|thanksgiving|halloween|easter)\b/gi,
  /\b(?:pork|prosciutto|pancetta|lard)\b|(?<!turkey )(?<!beef )\b(?:bacon|ham)\b/gi,
  /\b(?:beer|vodka|rum|whisk(?:e)?y|bourbon|brandy|liqueur|tequila|champagne)\b|\bwine\b(?! vinegar)/gi,
];

export function restrictedWords(text: string): string[] {
  const found: string[] = [];
  for (const pattern of RESTRICTED) {
    for (const match of text.matchAll(pattern)) found.push(match[0]);
  }
  return found;
}

function tooSimilar(text: string, others: string[] | undefined): string | null {
  for (const other of others ?? []) {
    if (similarity(text, other) >= SIMILAR_AT) return other;
  }
  return null;
}

const missingWords = (keyword: string, text: string): string[] => {
  const have = new Set(words(text));
  return words(keyword).filter((w) => !have.has(w));
};

export function checkTitle(title: string, ctx: CheckContext): string[] {
  const text = clean(title);
  const problems: string[] = [];

  if (text.length > TITLE_MAX) {
    problems.push(`The title is ${text.length} characters; keep it to ${TITLE_MAX} or fewer so it is not cut off.`);
  }
  if (text.length < TITLE_MIN) {
    problems.push(`The title is only ${text.length} characters; say what the dish is (at least ${TITLE_MIN}).`);
  }

  const missing = missingWords(ctx.keyword, text);
  if (missing.length) {
    problems.push(`The title is missing the keyword words: ${missing.join(', ')}.`);
  } else {
    const first = words(ctx.keyword)[0];
    if (first && text.toLowerCase().indexOf(first) > 40) {
      problems.push('Put the keyword nearer the start of the title.');
    }
  }

  const counts = new Map<string, number>();
  for (const w of words(text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const [w, n] of counts) {
    if (n > 2) problems.push(`The word "${w}" is repeated ${n} times; that reads as stuffing.`);
  }

  if (text.includes('|') || (text.match(/,/g) ?? []).length >= 2) {
    problems.push('The title reads like a keyword list; write it as a normal title.');
  }

  const letters = text.replace(/[^a-z]/gi, '');
  if (letters.length >= 5 && text === text.toUpperCase()) {
    problems.push('The title is all capitals; use normal title case.');
  }

  for (const word of restrictedWords(text)) {
    problems.push(`The title contains "${word}", which this site does not publish.`);
  }

  const twin = tooSimilar(text, ctx.others);
  if (twin) problems.push(`The title is too similar to another title on the site: "${twin}".`);

  return problems;
}

export function checkDescription(description: string, ctx: CheckContext): string[] {
  const text = clean(description);
  const problems: string[] = [];

  if (text.length < DESCRIPTION_MIN || text.length > DESCRIPTION_MAX) {
    problems.push(
      `The description is ${text.length} characters; keep it between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX}.`,
    );
  }
  if (!/[.!?]$/.test(text)) {
    problems.push('Write the description as a sentence that ends with a full stop.');
  }

  const missing = missingWords(ctx.keyword, text);
  if (missing.length) {
    problems.push(`The description is missing the keyword words: ${missing.join(', ')}.`);
  }
  const phrase = clean(ctx.keyword).toLowerCase();
  if (phrase && text.toLowerCase().split(phrase).length - 1 > 1) {
    problems.push('Use the keyword phrase once, naturally, not repeated.');
  }

  if (text.includes('|') || (text.match(/,/g) ?? []).length > 3) {
    problems.push('The description reads like a list; write it as a sentence a person would say.');
  }

  for (const word of restrictedWords(text)) {
    problems.push(`The description contains "${word}", which this site does not publish.`);
  }

  const twin = tooSimilar(text, ctx.others);
  if (twin) problems.push('The description is too similar to another description on the site.');

  return problems;
}

export function checkSlug(slug: string, ctx: CheckContext): string[] {
  const problems: string[] = [];

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    problems.push('The slug may only use lower-case letters, numbers and single dashes.');
  }
  const parts = slug.split('-').filter(Boolean);
  if (parts.length > SLUG_MAX_WORDS || slug.length > SLUG_MAX_CHARS) {
    problems.push(`Keep the slug to ${SLUG_MAX_WORDS} words and ${SLUG_MAX_CHARS} characters.`);
  }
  if (parts.some((p) => /^(?:19|20)\d{2}$/.test(p))) {
    problems.push('Leave the year out of the slug so it does not date the page.');
  }

  const missing = missingWords(ctx.keyword, slug.replace(/-/g, ' '));
  if (missing.length) problems.push(`The slug is missing the keyword words: ${missing.join(', ')}.`);

  if ((ctx.others ?? []).includes(slug)) problems.push('Another page already has this slug.');

  return problems;
}

export function checkFocusKeyword(keyword: string): string[] {
  const count = clean(keyword).split(' ').filter(Boolean).length;
  return count >= 3 ? [] : [`The focus keyword is ${count} word(s); a long-tail keyword has 3 or more.`];
}

export function checkAlt(alt: string): string[] {
  const text = clean(alt);
  if (text.length < ALT_MIN || text.length > ALT_MAX) {
    return [`The alt text is ${text.length} characters; describe the picture in ${ALT_MIN} to ${ALT_MAX}.`];
  }
  return [];
}

/** The rules above, as text for a prompt, so the model is told what will be checked. */
export function rulesPrompt(): string {
  return [
    'SEO RULES (your answer is checked by a program against these):',
    `- Title: ${TITLE_MIN}-${TITLE_MAX} characters, includes every word of the keyword with the keyword near the start, no word used more than twice, no lists or "|", normal title case, different from every other title.`,
    `- Description: ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters, one natural sentence that ends with a full stop, includes the keyword once, no lists, different from every other description. Say what the page really delivers.`,
    `- Slug: lower-case words joined by single dashes, at most ${SLUG_MAX_WORDS} words, includes the keyword words, no year.`,
    '- Never stuff keywords. Write for the person searching, not for a robot.',
    '- No pork, no alcohol, no holiday words (Christmas, Thanksgiving, Valentine\'s, Easter, Halloween).',
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/seo-rules.test.ts`
Expected: PASS. If a single expectation fails because of a counting detail in the test's own sample text (for example a sample that is a character over or under a bound), fix the *sample text in the test* to sit clearly inside or outside the bound; do not loosen a rule. Record any such change in your report.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; everything passes except the known ffmpeg test.

- [ ] **Step 6: Commit**

```bash
git add src/seo/rules.ts test/seo-rules.test.ts
git commit -m "Turn the SEO rules into code a program can check

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The import-time writer

**Files:**
- Create: `src/seo/writer.ts`, `prompts/seo-writer.system.txt`, `prompts/seo-writer.user.txt`
- Modify: `src/pipeline/prompts.ts` (`PROMPT_MODELS`, after the `guide-shortlist` entry), `src/pipeline/prompt-contexts.ts` (`STEP_CONTEXTS`)
- Test: `test/seo-writer.test.ts`; existing `test/prompts.test.ts` must keep passing

**Interfaces:**
- Consumes: Task 1 (`checkTitle`, `checkDescription`, `rulesPrompt`, `TITLE_MAX`); `getKeyword`, `updateKeywordFields`, type `KeywordRow` from `src/db/repos.ts`; `all` from `src/db/index.ts`; `createLogger`, `errorMessage` from `src/lib/logger.ts`.
- Produces (used by Task 3):
  - `interface WriterDeps { ask: (promptName: string, variables: Record<string, unknown>) => Promise<string> }` (same shape as the guide assistant's `ask`)
  - `interface SeoDraft { title: string; description: string; notes: string }`, `interface Drafted extends SeoDraft { fallback: boolean }`
  - `interface SeoItem { id: number; keyword: string }`, `interface WriterContext { identity: string; pillar: string; others: string[] }`
  - `fallbackFor(keyword: string): SeoDraft`
  - `draftSeo(deps, items: SeoItem[], context: WriterContext): Promise<Map<number, Drafted>>` — never throws; every item gets an entry
  - `interface WriterReport { written: number; fallbacks: number }`
  - `writeSeoFor(deps, siteId: number, pillar: string, identity: string, ids: number[]): Promise<WriterReport>`

- [ ] **Step 1: Register the prompt so the existing prompt test fails**

In `src/pipeline/prompts.ts`, add to `PROMPT_MODELS` after the `'guide-shortlist'` entry:

```ts
  // Writes the title and description a guide keyword is missing. JSON because
  // one call answers for a whole batch of recipes.
  'seo-writer': { model: 'gpt-oss:120b', format: 'json' },
```

Run: `npx vitest run test/prompts.test.ts`
Expected: FAIL — prompt files / context for `seo-writer` missing.

- [ ] **Step 2: Declare the variables**

In `src/pipeline/prompt-contexts.ts`, inside `STEP_CONTEXTS` after the `'guide-shortlist'` entry add:

```ts
  'seo-writer': {
    identity: 'i',
    pillar: 'p',
    itemsJson: '[]',
    takenJson: '[]',
    rules: 'r',
  },
```

- [ ] **Step 3: Write the prompt files**

Create `prompts/seo-writer.system.txt`:

```
You write the search title and description for recipe pages on a recipe website, following Google's own advice: every page gets its own specific title and description, written for the person searching, never stuffed with keywords.

You are given a batch of recipes, each with a keyword. For each one write:
- "title": the specific dish. Whatever makes it different from the others (the sauce, the method, the pan, the cuisine) must be in it. Not a generic version of the topic.
- "description": ONE natural sentence saying what the dish is and what the cook gets.
- "notes": one or two sentences for the recipe writer: what makes this dish different from the other recipes in the batch.

Every recipe in the batch must read clearly different from the others and from the titles already taken.

{{rules}}

If an item has "fix" problems, your last answer for it broke those rules: fix exactly those.

Answer with JSON only, exactly this shape, one entry per item, keeping each "n":
{"items": [{"n": 1, "title": "...", "description": "...", "notes": "..."}]}
```

Create `prompts/seo-writer.user.txt`:

```
Site is for: {{identity}}
Pillar topic: {{pillar}}

Titles already taken on this site or in this batch (do not repeat or closely copy these):
{{takenJson}}

Recipes to write for (JSON, each with its keyword and any problems to fix):
{{itemsJson}}

Answer with the JSON object only.
```

- [ ] **Step 4: Run the prompt test to verify it passes**

Run: `npx vitest run test/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing writer test**

Create `test/seo-writer.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { randomBytes } from 'node:crypto';
import { getKeyword, insertKeyword, setLink, upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import { checkDescription, checkTitle } from '../src/seo/rules.js';
import { draftSeo, fallbackFor, writeSeoFor } from '../src/seo/writer.js';

/**
 * The writer fills in what a guide keyword is missing -- a specific dish
 * title and a description -- and holds the model to the SEO rules. Only the
 * model is faked; the rules, the database and the retry logic are real.
 */

const KEY = randomBytes(32);

const ONE = {
  n: 1,
  title: 'Honey Garlic Chicken Thighs With Crispy Skin',
  description: 'Sticky honey garlic chicken thighs baked until the skin crisps, ready in under an hour.',
  notes: 'Sticky glaze, oven-baked.',
};
const TWO = {
  n: 2,
  title: 'Lemon Herb Baked Salmon in Foil Packets',
  description: 'Flaky lemon herb baked salmon steamed in foil with butter and fresh dill, done in 20 minutes.',
  notes: 'Foil packet, fish.',
};

const reply = (...items: object[]) => JSON.stringify({ items });

let siteId = 0;
const site = () =>
  upsertSite(
    { name: 'Bitespoon', domain: 'bitespoon.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 0 },
    KEY,
  );

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  siteId = site();
});
afterEach(() => closeDatabase());

describe('fallbackFor', () => {
  it('builds text that passes the rules from the keyword alone', () => {
    const f = fallbackFor('honey garlic chicken thighs');
    expect(f.title).toBe('Honey Garlic Chicken Thighs');
    expect(checkTitle(f.title, { keyword: 'honey garlic chicken thighs' })).toEqual([]);
    expect(checkDescription(f.description, { keyword: 'honey garlic chicken thighs' })).toEqual([]);
  });
});

describe('draftSeo', () => {
  const items = [
    { id: 11, keyword: 'honey garlic chicken thighs' },
    { id: 12, keyword: 'lemon herb baked salmon' },
  ];
  const context = { identity: 'Quick dinners', pillar: 'Dinners', others: [] as string[] };

  it('accepts a batch that follows the rules', async () => {
    const out = await draftSeo({ ask: async () => reply(ONE, TWO) }, items, context);
    expect(out.get(11)).toMatchObject({ title: ONE.title, fallback: false });
    expect(out.get(12)).toMatchObject({ title: TWO.title, fallback: false });
  });

  it('sends back only the failures, with the exact problem', async () => {
    const tooLong = { ...TWO, title: 'Lemon Herb Baked Salmon The Absolute Best Way To Cook Salmon In Foil Every Single Time' };
    const calls: Array<Record<string, unknown>> = [];
    const answers = [reply(ONE, tooLong), reply(TWO)];
    const ask = async (_name: string, vars: Record<string, unknown>) => {
      calls.push(vars);
      return answers.shift()!;
    };

    const out = await draftSeo({ ask }, items, context);

    expect(calls).toHaveLength(2);
    const second = JSON.parse(String(calls[1]!.itemsJson)) as Array<{ n: number; fix: string[] }>;
    expect(second.map((i) => i.n)).toEqual([2]);
    expect(second[0]!.fix.join(' ')).toContain('characters');
    expect(out.get(12)).toMatchObject({ title: TWO.title, fallback: false });
  });

  it('falls back for an item that never passes, after three rounds', async () => {
    const bad = { ...ONE, title: 'Chicken' };
    let calls = 0;
    const ask = async () => {
      calls += 1;
      return reply(bad, TWO);
    };
    const out = await draftSeo({ ask }, items, context);
    expect(calls).toBe(3);
    expect(out.get(11)).toMatchObject({ fallback: true, title: 'Honey Garlic Chicken Thighs' });
    expect(out.get(12)).toMatchObject({ fallback: false });
  });

  it('falls back for everything when the model is unreachable or answers nonsense', async () => {
    const down = await draftSeo({ ask: async () => { throw new Error('offline'); } }, items, context);
    expect([...down.values()].every((d) => d.fallback)).toBe(true);
    const junk = await draftSeo({ ask: async () => 'sorry, no' }, items, context);
    expect([...junk.values()].every((d) => d.fallback)).toBe(true);
  });

  it('treats titles already on the site as taken', async () => {
    const taken = { ...context, others: [ONE.title] };
    const better = { ...ONE, title: 'Oven Baked Honey Garlic Chicken Thighs for Weeknights' };
    const answers = [reply(ONE, TWO), reply(better)];
    const out = await draftSeo({ ask: async () => answers.shift()! }, items, taken);
    expect(out.get(11)).toMatchObject({ title: better.title, fallback: false });
  });
});

describe('writeSeoFor', () => {
  const recipe = (keyword: string, extra: Record<string, unknown> = {}) => {
    const id = insertKeyword({ seed_keyword: keyword, content_type: 'recipe', annotation: 'guide:Dinners', ...extra });
    setLink(id, siteId, 'go');
    return id;
  };

  it('fills a blank recipe with a title, description and notes', async () => {
    const a = recipe('honey garlic chicken thighs');
    const b = recipe('lemon herb baked salmon');
    const report = await writeSeoFor({ ask: async () => reply(ONE, TWO) }, siteId, 'Dinners', 'Quick dinners', [a, b]);

    expect(report).toEqual({ written: 2, fallbacks: 0 });
    expect(getKeyword(a)).toMatchObject({
      spy_title: ONE.title,
      spy_description: ONE.description,
      annotation: 'guide:Dinners | Sticky glaze, oven-baked.',
    });
  });

  it('marks fallback text so it can be found and redone', async () => {
    const a = recipe('honey garlic chicken thighs');
    const report = await writeSeoFor({ ask: async () => { throw new Error('offline'); } }, siteId, 'Dinners', 'Quick dinners', [a]);
    expect(report).toEqual({ written: 1, fallbacks: 1 });
    expect(getKeyword(a)!.spy_title).toBe('Honey Garlic Chicken Thighs');
    expect(getKeyword(a)!.annotation).toContain('seo:fallback');
  });

  it('leaves articles and keywords that already have research alone', async () => {
    const article = insertKeyword({ seed_keyword: 'how to cook chicken thighs', content_type: 'article' });
    setLink(article, siteId, 'go');
    const researched = recipe('lemon herb baked salmon', { spy_title: 'Original source title' });
    let asked = 0;
    const report = await writeSeoFor(
      { ask: async () => { asked += 1; return reply(ONE); } },
      siteId, 'Dinners', 'Quick dinners', [article, researched],
    );
    expect(asked).toBe(0);
    expect(report).toEqual({ written: 0, fallbacks: 0 });
    expect(getKeyword(article)!.spy_title).toBe('');
    expect(getKeyword(researched)!.spy_title).toBe('Original source title');
  });

  it('counts titles already on the site as taken', async () => {
    recipe('crispy baked chicken thighs', { spy_title: ONE.title });
    const a = recipe('honey garlic chicken thighs');
    const better = { ...ONE, title: 'Oven Baked Honey Garlic Chicken Thighs for Weeknights' };
    const answers = [reply(ONE), reply(better)];
    await writeSeoFor({ ask: async () => answers.shift()! }, siteId, 'Dinners', 'Quick dinners', [a]);
    expect(getKeyword(a)!.spy_title).toBe(better.title);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run test/seo-writer.test.ts`
Expected: FAIL — `Cannot find module '../src/seo/writer.js'`.

- [ ] **Step 7: Write `src/seo/writer.ts`**

```ts
import { all } from '../db/index.js';
import { getKeyword, updateKeywordFields, type KeywordRow } from '../db/repos.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { checkDescription, checkTitle, rulesPrompt, TITLE_MAX } from './rules.js';

const log = createLogger('seo');

/**
 * Writes the title and description a guide keyword arrives without.
 *
 * A recipe is written from a source title and description; a keyword added by
 * the guide has neither, so the pipeline would stop at the first step. One
 * model call answers for the whole batch, so the recipes come out different
 * from each other. Everything it says is checked by the rules in rules.ts;
 * only the failures go back, with the exact problem. What still fails after
 * that gets a plain version built from the keyword -- importing must never
 * fail because the wording was hard.
 */

export interface WriterDeps {
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
}

export interface SeoDraft {
  title: string;
  description: string;
  notes: string;
}

export interface Drafted extends SeoDraft {
  /** True when the model never produced something that passed. */
  fallback: boolean;
}

export interface SeoItem {
  id: number;
  keyword: string;
}

export interface WriterContext {
  identity: string;
  pillar: string;
  /** Titles already used on the site. */
  others: string[];
}

/** The first ask plus two corrections. */
const ROUNDS = 3;

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const titleCase = (text: string): string => text.replace(/(^|\s)[a-z]/g, (m) => m.toUpperCase());

/** Plain, honest text from the keyword alone. It says nothing the keyword does not. */
export function fallbackFor(keyword: string): SeoDraft {
  const phrase = clean(keyword).toLowerCase();
  const title = titleCase(phrase);
  const cut = title.lastIndexOf(' ', TITLE_MAX);
  return {
    title: title.length > TITLE_MAX ? title.slice(0, cut > 0 ? cut : TITLE_MAX) : title,
    description: `A clear, step-by-step way to make ${phrase}, with the ingredients, timing and tips you need.`,
    notes: '',
  };
}

/** The model's answer as a list of objects, tolerating text around the JSON. */
function parseAnswer(raw: string): Record<string, unknown>[] {
  const tryParse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  let value = tryParse(raw);
  if (value === undefined) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) value = tryParse(raw.slice(start, end + 1));
  }
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (value as { items?: unknown }).items
      : undefined;
  return Array.isArray(list)
    ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
}

export async function draftSeo(
  deps: WriterDeps,
  items: SeoItem[],
  context: WriterContext,
): Promise<Map<number, Drafted>> {
  const done = new Map<number, Drafted>();
  const problems = new Map<number, string[]>();
  const takenTitles = [...context.others];
  const takenDescriptions: string[] = [];
  let pending = items.map((item, index) => ({ ...item, n: index + 1 }));

  for (let round = 0; round < ROUNDS && pending.length > 0; round += 1) {
    let answers: Record<string, unknown>[];
    try {
      answers = parseAnswer(
        await deps.ask('seo-writer', {
          identity: context.identity,
          pillar: context.pillar,
          itemsJson: JSON.stringify(
            pending.map((p) => ({ n: p.n, keyword: p.keyword, fix: problems.get(p.n) ?? [] })),
          ),
          takenJson: JSON.stringify(takenTitles),
          rules: rulesPrompt(),
        }),
      );
    } catch (err) {
      log.warn(`SEO writer unavailable, using plain text: ${errorMessage(err)}`);
      break;
    }

    const stillPending: typeof pending = [];
    for (const item of pending) {
      const answer = answers.find((a) => Number(a.n) === item.n);
      const title = clean(answer?.title);
      const description = clean(answer?.description);
      const found = answer
        ? [
            ...checkTitle(title, { keyword: item.keyword, others: takenTitles }),
            ...checkDescription(description, { keyword: item.keyword, others: takenDescriptions }),
          ]
        : ['No answer came back for this recipe.'];

      if (found.length === 0) {
        done.set(item.id, { title, description, notes: clean(answer?.notes), fallback: false });
        takenTitles.push(title);
        takenDescriptions.push(description);
      } else {
        problems.set(item.n, found);
        stillPending.push(item);
      }
    }
    pending = stillPending;
  }

  for (const item of pending) {
    done.set(item.id, { ...fallbackFor(item.keyword), fallback: true });
  }
  return done;
}

export interface WriterReport {
  written: number;
  fallbacks: number;
}

/**
 * Fill in the recipes among `ids` that have no source title yet.
 *
 * Articles are left alone (the article pipeline plans its own metadata, and a
 * source title would make it write "the same ground, better"), and so is any
 * recipe that already has research -- the operator's own words win.
 */
export async function writeSeoFor(
  deps: WriterDeps,
  siteId: number,
  pillar: string,
  identity: string,
  ids: number[],
): Promise<WriterReport> {
  const rows = ids
    .map((id) => getKeyword(id))
    .filter((row): row is KeywordRow => !!row && row.content_type === 'recipe' && row.spy_title.trim() === '');
  if (rows.length === 0) return { written: 0, fallbacks: 0 };

  const others = all<{ spy_title: string }>(
    `SELECT k.spy_title FROM keywords k
     JOIN keyword_sites ks ON ks.keyword_id = k.id
     WHERE ks.site_id = ? AND k.spy_title != ''`,
    siteId,
  ).map((r) => r.spy_title);

  let drafts: Map<number, Drafted>;
  try {
    drafts = await draftSeo(
      deps,
      rows.map((row) => ({ id: row.id, keyword: row.seed_keyword })),
      { identity, pillar, others },
    );
  } catch (err) {
    // draftSeo is built not to throw; this is the belt to its braces.
    log.warn(`SEO writer failed, using plain text: ${errorMessage(err)}`);
    drafts = new Map(
      rows.map((row) => [row.id, { ...fallbackFor(row.seed_keyword), fallback: true }]),
    );
  }

  let fallbacks = 0;
  for (const row of rows) {
    const draft = drafts.get(row.id) ?? { ...fallbackFor(row.seed_keyword), fallback: true };
    if (draft.fallback) fallbacks += 1;
    const { id, seed_keyword: _seed, ...fields } = row;
    updateKeywordFields(id, {
      ...fields,
      spy_title: draft.title,
      spy_description: draft.description,
      annotation: [row.annotation, draft.notes, draft.fallback ? 'seo:fallback' : '']
        .filter(Boolean)
        .join(' | '),
    });
  }
  return { written: rows.length, fallbacks };
}
```

If `npm run typecheck` rejects the unused `_seed` binding or `KeywordRow` is not exported from `src/db/repos.ts`, make the smallest fix (export the interface; or build the fields object by hand) and note it in your report.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/seo-writer.test.ts test/prompts.test.ts`
Expected: PASS. As in Task 1, if a test's own sample text lands on the wrong side of a bound, fix the sample, not the rule, and say so in your report.

- [ ] **Step 9: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: all pass except the known ffmpeg test.

- [ ] **Step 10: Commit**

```bash
git add src/seo/writer.ts prompts/seo-writer.system.txt prompts/seo-writer.user.txt src/pipeline/prompts.ts src/pipeline/prompt-contexts.ts test/seo-writer.test.ts
git commit -m "Write checked titles and descriptions for guide recipes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Run the writer when the shortlist is imported

**Files:**
- Modify: `src/web/server.ts` (the `/guide/:siteId/import` route, near `importShortlistReport(`)
- Test: `test/guide-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 `writeSeoFor`, `WriterReport`; the route's existing `guideDeps.ask` (same `ask` shape); `siteContext(siteId, round)` from `src/guide/state.ts` (returns `{ identity, pillars, currentPillar }`).
- Produces: after an import, new recipe keywords have a `spy_title`, `spy_description`, and an `annotation` that mentions the pillar; the success message says how many got SEO text and how many used a plain default.

- [ ] **Step 1: Write the failing test**

In `test/guide-routes.test.ts`, add this test after `'imports once even if the button is submitted twice'` (it reuses the file's `reachImport`, `addSite`, `loginCookie`, and the imports `all`, `closeDatabase`, etc.). No model is configured in tests, so the writer falls back — which is exactly what the test relies on:

```ts
  it('gives imported recipes a title and description, and leaves the article alone', async () => {
    const siteId = addSite();
    const cookie = await loginCookie();
    const form = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    reachImport(siteId);

    // pick=0 is the pillar article; 1 and 2 are recipes.
    const res = await app.inject({
      method: 'POST',
      url: `/guide/${siteId}/import`,
      headers: form,
      payload: 'pick=0&pick=1&pick=2',
    });
    // Falling back to plain text is not a problem worth a warning.
    expect(res.headers.location).not.toContain('warn=');

    const rows = all<{ seed_keyword: string; content_type: string; spy_title: string; spy_description: string; annotation: string }>(
      'SELECT seed_keyword, content_type, spy_title, spy_description, annotation FROM keywords ORDER BY id',
    );
    const article = rows.find((r) => r.content_type === 'article')!;
    expect(article.spy_title).toBe('');

    const recipes = rows.filter((r) => r.content_type === 'recipe');
    expect(recipes).toHaveLength(2);
    for (const r of recipes) {
      expect(r.spy_title.length).toBeGreaterThan(0);
      expect(r.spy_description.length).toBeGreaterThan(0);
      expect(r.annotation).toContain('guide:a');
      expect(r.annotation).toContain('seo:fallback');
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/guide-routes.test.ts`
Expected: the new test FAILS (`spy_title` is empty); the others pass.

- [ ] **Step 3: Wire the writer into the route**

In `src/web/server.ts`:

1. Add imports next to the other guide imports:

```ts
import { writeSeoFor } from '../seo/writer.js';
```

   and add `siteContext` to the existing import from `'../guide/state.js'` if it is not already imported.

2. In the `/guide/:siteId/import` route, directly after the line
   `const { ids, alreadyOnSite, switchedOff } = importShortlistReport(site.id, shortlist.pillar, items);`
   add:

```ts
    // Recipes are written from a source title and description, which a guide
    // keyword does not have. Write them now, checked against the SEO rules;
    // it falls back to plain text rather than ever failing the import.
    const seo = await writeSeoFor(
      guideDeps,
      site.id,
      shortlist.pillar,
      siteContext(site.id, cursor.round).identity,
      ids,
    );
```

3. Extend the success message. Replace the existing `return redirect(reply, back, {` call's `message` expression so that it ends with the SEO sentence. The final route code from `const notes` down must read:

```ts
    const notes = [
      alreadyOnSite.length ? `${alreadyOnSite.length} already on the site` : '',
      switchedOff.length ? `${switchedOff.length} are switched off in Keywords` : '',
    ].filter(Boolean);
    const added = ids.length - alreadyOnSite.length - switchedOff.length;
    const seoNote = seo.written
      ? ` Search title and description written for ${seo.written} recipe(s)` +
        (seo.fallbacks ? `; ${seo.fallbacks} used a simple default you can improve in Keywords.` : '.')
      : '';
    return redirect(reply, back, {
      kind: notes.length ? 'warn' : 'ok',
      message:
        `${added} keyword(s) queued — they’ll be written on the site’s normal schedule.` +
        (notes.length ? ` Not queued: ${notes.join(', ')}.` : '') +
        seoNote,
    });
```

(Keep the existing `notes`/`added` lines exactly as they are in the file; only the `seoNote` constant and the added `+ seoNote` are new.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/guide-routes.test.ts`
Expected: PASS (all, including the double-submit test).

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: all pass except the known ffmpeg test.

- [ ] **Step 6: Commit**

```bash
git add src/web/server.ts test/guide-routes.test.ts
git commit -m "Write search titles and descriptions when the guide imports recipes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Hold the existing SEO steps to the same rules

**Files:**
- Create: `src/seo/refine.ts`
- Modify: `src/pipeline/steps/content.ts` (`validateSpy`), `src/pipeline/steps/blog.ts` (`planArticle`, new export `planSeoProblems`), `src/pipeline/prompt-contexts.ts` (`spy-validation`, `article-outline`), `prompts/spy-validation.system.txt`, `prompts/spy-validation.user.txt`, `prompts/article-outline.system.txt`, `prompts/article-outline.user.txt`
- Test: `test/seo-refine.test.ts`, `test/seo-plan.test.ts`; `test/prompts.test.ts` must keep passing

**Interfaces:**
- Consumes: Task 1 (`checkTitle`, `checkDescription`, `checkSlug`, `checkFocusKeyword`, `checkAlt`, `rulesPrompt`).
- Produces:
  - `refineOnce<T>(first: T, check: (value: T) => string[], reask: (problems: string[]) => Promise<T | null>): Promise<{ value: T; problems: string[] }>` — if `first` passes, return it; otherwise ask once with the problems; keep the second answer only if it has fewer problems; never throws (a throwing `reask` keeps `first`).
  - `planSeoProblems(plan: Record<string, unknown>, keyword: string): string[]` exported from `src/pipeline/steps/blog.ts`.
  - Prompt variables `seoRules` (the rules text) and `seoFeedback` (empty, or "YOUR LAST ANSWER BROKE THESE SEO RULES: …") available to `spy-validation` and `article-outline`.

- [ ] **Step 1: Write the failing tests**

Create `test/seo-refine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { refineOnce } from '../src/seo/refine.js';

/**
 * SEO wording should be corrected when it can be, and never stop a run when
 * it cannot: one more try with the exact problems, then keep the best answer.
 */

const lengthProblems = (s: string): string[] => (s.length > 5 ? [`"${s}" is too long`] : []);

describe('refineOnce', () => {
  it('leaves a passing answer alone and never asks again', async () => {
    let asked = 0;
    const out = await refineOnce('ok', lengthProblems, async () => {
      asked += 1;
      return 'x';
    });
    expect(out).toEqual({ value: 'ok', problems: [] });
    expect(asked).toBe(0);
  });

  it('asks once with the problems and takes a better answer', async () => {
    const seen: string[][] = [];
    const out = await refineOnce('far too long', lengthProblems, async (problems) => {
      seen.push(problems);
      return 'short';
    });
    expect(seen).toEqual([['"far too long" is too long']]);
    expect(out).toEqual({ value: 'short', problems: [] });
  });

  it('keeps the first answer when the second is no better', async () => {
    const out = await refineOnce('far too long', lengthProblems, async () => 'also far too long');
    expect(out.value).toBe('far too long');
    expect(out.problems).toHaveLength(1);
  });

  it('keeps the first answer when asking again fails or returns nothing', async () => {
    const thrown = await refineOnce('far too long', lengthProblems, async () => {
      throw new Error('down');
    });
    expect(thrown.value).toBe('far too long');
    const none = await refineOnce('far too long', lengthProblems, async () => null);
    expect(none.value).toBe('far too long');
  });
});
```

Create `test/seo-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planSeoProblems } from '../src/pipeline/steps/blog.js';

/** What an article plan's search text is held to before the article is written. */

const keyword = 'how to repot a monstera';
const good = {
  metaTitle: 'How to Repot a Monstera Without Killing It',
  metaDescription: 'Learn how to repot a monstera in six steps, from choosing the pot to watering afterwards.',
  slug: 'how-to-repot-a-monstera',
  focusKeyword: 'how to repot a monstera',
  images: [{ alt: 'A monstera lifted out of its old pot with roots showing' }],
};

describe('planSeoProblems', () => {
  it('passes a plan that follows the rules', () => {
    expect(planSeoProblems(good, keyword)).toEqual([]);
  });

  it('labels each problem with the field it belongs to', () => {
    const bad = {
      ...good,
      metaTitle: 'Monstera',
      metaDescription: 'Repot it.',
      slug: 'Repot_Monstera_2026',
      focusKeyword: 'monstera',
      images: [{ alt: 'x' }],
    };
    const problems = planSeoProblems(bad, keyword);
    for (const field of ['metaTitle', 'metaDescription', 'slug', 'focusKeyword', 'images[0].alt']) {
      expect(problems.some((p) => p.startsWith(field))).toBe(true);
    }
  });

  it('falls back to the topic when the plan has no focus keyword', () => {
    const { focusKeyword: _omit, ...rest } = good;
    expect(planSeoProblems(rest, keyword)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/seo-refine.test.ts test/seo-plan.test.ts`
Expected: FAIL — `refine.js` not found; `planSeoProblems` is not exported.

- [ ] **Step 3: Write `src/seo/refine.ts`**

```ts
/**
 * "Check it, ask once more with the exact problems, keep the better answer."
 *
 * Used where SEO wording is produced inside a pipeline run. Wording is never
 * worth stopping a run for, so this cannot throw and an unfixable answer is
 * returned with its remaining problems for the caller to log.
 */
export async function refineOnce<T>(
  first: T,
  check: (value: T) => string[],
  reask: (problems: string[]) => Promise<T | null>,
): Promise<{ value: T; problems: string[] }> {
  const firstProblems = check(first);
  if (firstProblems.length === 0) return { value: first, problems: [] };

  try {
    const second = await reask(firstProblems);
    if (second !== null) {
      const secondProblems = check(second);
      if (secondProblems.length < firstProblems.length) {
        return { value: second, problems: secondProblems };
      }
    }
  } catch {
    // Asking again is a bonus; the first answer still stands.
  }
  return { value: first, problems: firstProblems };
}

/** The line a prompt shows when its previous answer broke rules; empty when it did not. */
export const feedbackFor = (problems: string[]): string =>
  problems.length ? `YOUR LAST ANSWER BROKE THESE SEO RULES. Fix them: ${problems.join(' ')}` : '';
```

- [ ] **Step 4: Declare the new prompt variables and show them in the prompts**

In `src/pipeline/prompt-contexts.ts`, change the `'spy-validation'` and `'article-outline'` entries to add the two variables:

```ts
  'spy-validation': {
    spy: SPY,
    categoryTitles: '[]',
    site: { domain: 'example.com' },
    seoRules: 'r',
    seoFeedback: '',
  },
```

```ts
  'article-outline': {
    keyword: 'kyoto in autumn',
    niche: 'travel',
    spyNote: '',
    categoryTitles: '[]',
    seoRules: 'r',
    seoFeedback: '',
  },
```

In `prompts/spy-validation.system.txt`, directly before the line `STRICT OUTPUT RULES:` insert:

```
{{seoRules}}

```

In `prompts/spy-validation.user.txt`, append a final line:

```
{{seoFeedback}}
```

In `prompts/article-outline.system.txt`, replace the whole `SEO` paragraph (the lines from `SEO` through `...no stop-words padding it out.`) with:

```
SEO

{{seoRules}}

The metaTitle and metaDescription must read as sentences a person wrote, not as keyword lists.
```

In `prompts/article-outline.user.txt`, append a final line:

```
{{seoFeedback}}
```

- [ ] **Step 5: Make `validate-spy` check and re-ask once**

In `src/pipeline/steps/content.ts`:

1. Add imports:

```ts
import { checkDescription, checkTitle, rulesPrompt } from '../../seo/rules.js';
import { feedbackFor, refineOnce } from '../../seo/refine.js';
```

2. Replace the body of `validateSpy.run` from the `const result = await ctx.prompt('spy-validation', {` call through the `const seo = {...};` object (keep the `SpyRejectedError` guard for a missing spy title above it, and keep the `collapsedToGroup` block and the final `return` below it) with:

```ts
    const ask = (feedback: string) =>
      ctx.prompt('spy-validation', {
        spy: spyContext(ctx),
        categoryTitles: JSON.stringify(categories.map((c) => c.title)),
        site: { domain: ctx.site.domain },
        seoRules: rulesPrompt(),
        seoFeedback: feedback,
      });

    const derive = async (content: string): Promise<SeoData> => {
      if (content.includes('FALSE')) throw new SpyRejectedError(content.slice(0, 300));
      const parsed = await parseJsonOrRepair<Record<string, string>>(
        ctx,
        content,
        'Spy validation output',
        { requiredFields: ['keyword', 'title', 'description', 'category'] },
      );
      requireFields(parsed, ['keyword', 'title', 'description', 'category'], 'Spy validation');
      return {
        keyword: parsed.keyword!,
        title: parsed.title!,
        description: parsed.description!,
        category: parsed.category!,
      };
    };

    const result = await ask('');
    // Rejection and unreadable JSON still stop the run, exactly as before.
    const first = await derive(result.content);

    // Wording is different: ask once more with the exact problems, and if it
    // still breaks a rule keep the answer and say so rather than stop.
    const refined = await refineOnce(
      first,
      (s) => [
        ...checkTitle(s.title, { keyword: s.keyword }),
        ...checkDescription(s.description, { keyword: s.keyword }),
      ],
      async (problems) => {
        try {
          return await derive((await ask(feedbackFor(problems))).content);
        } catch {
          return null;
        }
      },
    );
    if (refined.problems.length) {
      log.warn(`run ${ctx.runId}: SEO text for "${refined.value.keyword}" still breaks rules: ${refined.problems.join(' ')}`);
    }
    const seo = refined.value;
```

   Make sure `SeoData` is the type already used by the step (`Step<Category[], SeoData>`); if `SpyRejectedError` or `SeoData` is declared lower in the file that is fine (they are hoisted/used at call time).

- [ ] **Step 6: Make `plan-article` check and re-ask once, and export `planSeoProblems`**

In `src/pipeline/steps/blog.ts`:

1. Add imports:

```ts
import { checkAlt, checkDescription, checkFocusKeyword, checkSlug, checkTitle, rulesPrompt } from '../../seo/rules.js';
import { feedbackFor, refineOnce } from '../../seo/refine.js';
```

2. Add this exported function above `planArticle`:

```ts
/**
 * What is wrong with a plan's search text, each problem labelled with its
 * field so the model can be told exactly what to fix. Empty means it passes.
 */
export function planSeoProblems(plan: Record<string, unknown>, keyword: string): string[] {
  const focus = String(plan.focusKeyword ?? '').trim() || keyword;
  const label = (field: string, problems: string[]): string[] => problems.map((p) => `${field}: ${p}`);
  const images = Array.isArray(plan.images) ? plan.images : [];
  return [
    ...label('focusKeyword', checkFocusKeyword(focus)),
    ...label('metaTitle', checkTitle(String(plan.metaTitle ?? ''), { keyword: focus })),
    ...label('metaDescription', checkDescription(String(plan.metaDescription ?? ''), { keyword: focus })),
    ...label('slug', checkSlug(String(plan.slug ?? ''), { keyword: focus })),
    ...images.flatMap((image, i) =>
      label(`images[${i}].alt`, checkAlt(String((image as { alt?: unknown })?.alt ?? ''))),
    ),
  ];
}
```

3. In `planArticle.run`, replace the `const result = await ctx.prompt('article-outline', {...})` call and the `const parsed = await parseJsonOrRepair(...)` + `requireFields(...)` lines with:

```ts
    const ask = (feedback: string) =>
      ctx.prompt('article-outline', {
        keyword: ctx.keyword.seed_keyword,
        niche: ctx.keyword.niche || 'general interest',
        // Optional on purpose: an article keyword is a topic, and unlike a
        // recipe it does not need a source page to be written from.
        spyNote: spy
          ? `It was found from a page titled "${spy}". Cover the same ground, better.`
          : '',
        categoryTitles: JSON.stringify(categories.map((c) => c.title)),
        seoRules: rulesPrompt(),
        seoFeedback: feedback,
      });

    const read = async (content: string): Promise<Record<string, unknown>> => {
      const plan = await parseJsonOrRepair<Record<string, unknown>>(ctx, content, 'Article plan', {
        requiredFields: ['title', 'sections', 'images'],
      });
      requireFields(plan, ['title', 'sections', 'images'], 'Article plan');
      return plan;
    };

    const result = await ask('');
    const firstPlan = await read(result.content);

    // Ask once more with the exact problems; keep the plan and log a warning if
    // it still breaks a rule, since the .slice() guards below are the last resort.
    const refined = await refineOnce(
      firstPlan,
      (p) => planSeoProblems(p, ctx.keyword.seed_keyword),
      async (problems) => {
        try {
          return await read((await ask(feedbackFor(problems))).content);
        } catch {
          return null;
        }
      },
    );
    if (refined.problems.length) {
      log.warn(`run ${ctx.runId}: article plan SEO text still breaks rules: ${refined.problems.join(' ')}`);
    }
    const parsed = refined.value;
```

   Everything after (the `sections` / `images` filtering and the returned plan) stays as it is. Make sure `log` (the file's `createLogger` instance) is in scope; use whatever the file already names it.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/seo-refine.test.ts test/seo-plan.test.ts test/prompts.test.ts`
Expected: PASS. The prompt test confirms `seoRules` and `seoFeedback` are declared for both prompts.

- [ ] **Step 8: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: all pass except the known ffmpeg test. If an existing pipeline test fakes `ctx.prompt` and now sees extra variables or a second call, adjust that test's fake minimally and say so in the report.

- [ ] **Step 9: Commit**

```bash
git add src/seo/refine.ts src/pipeline/steps/content.ts src/pipeline/steps/blog.ts src/pipeline/prompt-contexts.ts prompts/spy-validation.system.txt prompts/spy-validation.user.txt prompts/article-outline.system.txt prompts/article-outline.user.txt test/seo-refine.test.ts test/seo-plan.test.ts
git commit -m "Hold the recipe and article SEO text to the same rules

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
