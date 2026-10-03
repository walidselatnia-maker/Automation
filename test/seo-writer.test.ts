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
