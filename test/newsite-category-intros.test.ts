import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { introDue, introProblems, refreshCategoryIntro, syncCategoryIntros } from '../src/newsite/category-intros.js';

const KEY = randomBytes(32);
const DAY = 86_400_000;
const GOOD = Array.from({ length: 150 }, (_, i) => (i === 75 ? 'cakes.\n\nMore' : 'cakes')).join(' ');

describe('Category intros', () => {
  let websiteId: number;
  let calls: { url: string; body: unknown }[];
  let asked: Record<string, unknown>[];
  let answer: string;

  const fakeSite = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') {
      calls.push({ url: u, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ category: {} }));
    }
    return new Response(JSON.stringify({ items: [{ id: 5, name: 'Cakes', slug: 'cakes-and-bakes', authorIds: [] }] }));
  }) as unknown as typeof fetch;

  let now = Date.UTC(2026, 9, 1);
  const deps = () => ({
    encryptionKey: KEY,
    fetchImpl: fakeSite,
    now: () => now,
    ask: async (_name: string, vars: Record<string, unknown>) => {
      asked.push(vars);
      return answer;
    },
  });

  /** A plan (pillar plus subs) whose first `published` keywords are published in Cakes. */
  const plan = (pillar: string, subs: string[], published: number): number[] => {
    const planId = saveKeywordPlan(websiteId, pillar, [], 'article');
    queuePlanSeo(planId, pillar, subs, 'article');
    const ids = listPlanSeo(planId).map((r) => r.id);
    ids.slice(0, published).forEach((id, i) =>
      run(
        `UPDATE keyword_seo SET post_status = 'published', post_category = 'Cakes', title = ?, focus_keyword = ?, posted_at = datetime('now') WHERE id = ?`,
        `Title ${id}`, i === 0 ? pillar : subs[i - 1], id,
      ),
    );
    return ids;
  };

  beforeEach(() => {
    openDatabase(':memory:');
    new Settings(KEY);
    websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    calls = [];
    asked = [];
    answer = GOOD;
    now = Date.UTC(2026, 9, 1);
  });

  afterEach(() => closeDatabase());

  it('waits for 3 articles, then writes the intro once and sends it to the website', async () => {
    plan('strawberry cake', ['strawberry cake for kids', 'strawberry frosting'], 2);
    expect(introDue(websiteId, 'Cakes', now)).toBeNull();
    expect(await refreshCategoryIntro(websiteId, 'Cakes', deps())).toBe(false);

    run(`UPDATE keyword_seo SET post_status = 'published', post_category = 'Cakes' WHERE role = 'sub' AND post_status <> 'published'`);
    expect(introDue(websiteId, 'Cakes', now)).toBe('first');
    expect(await refreshCategoryIntro(websiteId, 'Cakes', deps())).toBe(true);
    expect(calls).toEqual([{ url: 'https://f.longlivo.com/api/v1/categories', body: { name: 'Cakes', slug: 'cakes-and-bakes', intro: GOOD } }]);
    expect(JSON.parse(String(asked[0]!.pillarsJson))).toEqual([{ title: expect.any(String), keyword: 'strawberry cake' }]);
    expect(JSON.parse(String(asked[0]!.articlesJson))).toHaveLength(2);

    // nothing new: never rewritten, even much later
    now += 90 * DAY;
    expect(introDue(websiteId, 'Cakes', now)).toBeNull();
  });

  it('rewrites only for a new pillar, and only 30 days after the last text', async () => {
    plan('strawberry cake', ['strawberry cake for kids', 'strawberry frosting'], 3);
    await refreshCategoryIntro(websiteId, 'Cakes', deps());

    // another sub-article, 40 days later: no rewrite
    const planId = Number(listPlanSeo(1)[0]!.plan_id);
    run(`INSERT INTO keyword_seo (plan_id, keyword, role, position, page, post_status, post_category) VALUES (?, 'strawberry jam', 'sub', 9, 'article', 'published', 'Cakes')`, planId);
    expect(introDue(websiteId, 'Cakes', now + 40 * DAY)).toBeNull();

    // a new pillar 10 days after the text: waits
    now = Date.UTC(2026, 9, 11);
    plan('lemon cake', [], 1);
    expect(introDue(websiteId, 'Cakes', now)).toBeNull();
    // 30 days after the text: rewritten, with both pillars
    now = Date.UTC(2026, 9, 31);
    expect(introDue(websiteId, 'Cakes', now)).toBe('rewrite');
    expect(await refreshCategoryIntro(websiteId, 'Cakes', deps())).toBe(true);
    expect(JSON.parse(String(asked[1]!.pillarsJson)).map((p: { keyword: string }) => p.keyword)).toEqual(['strawberry cake', 'lemon cake']);
    expect(introDue(websiteId, 'Cakes', now + 60 * DAY)).toBeNull();
  });

  it('gives the AI its mistakes back, and sends nothing when it never gets it right', async () => {
    plan('strawberry cake', ['strawberry cake for kids', 'strawberry frosting'], 3);
    answer = '## Cakes\n\nToo short.';
    expect(await refreshCategoryIntro(websiteId, 'Cakes', deps())).toBe(false);
    expect(asked).toHaveLength(3);
    expect(JSON.parse(String(asked[1]!.problemsJson)).join(' ')).toMatch(/120 to 200 words/);
    expect(calls).toEqual([]);
    expect(introDue(websiteId, 'Cakes', now)).toBe('first');
  });

  it('catches up every full category of every website', async () => {
    plan('strawberry cake', ['strawberry cake for kids', 'strawberry frosting'], 3);
    expect(await syncCategoryIntros(deps())).toBe(1);
    expect(await syncCategoryIntros(deps())).toBe(0);
  });

  it('checks the text', () => {
    expect(introProblems(GOOD)).toEqual([]);
    expect(introProblems(`${GOOD}\n\n- a list`)).toEqual(['Plain paragraphs only: no headings and no lists.']);
    expect(introProblems(`${GOOD} https://x.com`)).toEqual(['No links.']);
  });
});
