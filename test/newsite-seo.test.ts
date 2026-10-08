import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import {
  checkSeo,
  kickSeoWriter,
  listPlanSeo,
  parseSeoAnswer,
  queuePlanSeo,
  type SeoAnswer,
} from '../src/newsite/seo.js';

const KEY = randomBytes(32);
const KW = 'vegan pumpkin chocolate chip cookies';

/** A good answer: every length and rule met. */
const GOOD: SeoAnswer = {
  title: 'Vegan Pumpkin Chocolate Chip Cookies: Easy Egg-Free Bake', // 56
  description:
    'Soft vegan pumpkin chocolate chip cookies with no eggs or butter, ready in 30 minutes. Tested again and again in a home kitchen. Learn how to bake them today.', // 157
  focusKeyword: KW,
  altText: 'Vegan pumpkin chocolate chip cookies cooling on a wire rack',
  eeat: 'Experience',
  confidence: 'high',
  reasoning: 'Matches the main intent.',
};

const ctx = { keyword: KW, searches: ['vegan pumpkin chocolate chip cookies easy'], otherTitles: [] };

describe('AI#1 checks', () => {
  it('passes a good answer', () => {
    expect(GOOD.title.length).toBeGreaterThanOrEqual(50);
    expect(GOOD.description.length).toBeGreaterThanOrEqual(150);
    expect(checkSeo(GOOD, ctx)).toEqual([]);
  });

  it.each([
    ['a short title', { title: 'Vegan Pumpkin Chocolate Chip Cookies' }, /title is \d+ characters/],
    ['a title without the keyword', { title: 'The Softest Egg-Free Autumn Cookies You Will Ever Bake Now' }, /title must contain the focus keyword/],
    ['all caps', { title: 'EASY Vegan Pumpkin Chocolate Chip Cookies for Busy Weekdays' }, /all caps/],
    ['an exclamation mark', { title: 'Vegan Pumpkin Chocolate Chip Cookies You Will Love Baking!' }, /exclamation/],
    ['a long description', { description: GOOD.description + ' More words here.' }, /description is \d+ characters/],
    ['filler', { description: 'In this guide you learn vegan pumpkin chocolate chip cookies with no eggs or butter, ready in 30 minutes, tested again and again. Learn how to bake them now.' }, /filler phrase/],
    ['an invented focus keyword', { focusKeyword: 'best cookies ever' }, /focus keyword must be/],
    ['short alt text', { altText: 'Cookies on a rack' }, /alt text is \d+ words/],
    ['"image of" alt text', { altText: 'Image of vegan pumpkin chocolate chip cookies on a wire rack' }, /must not start with "image of"/],
    ['an unknown E-E-A-T signal', { eeat: 'Vibes' }, /E-E-A-T/],
  ])('catches %s', (_name, change, message) => {
    expect(checkSeo({ ...GOOD, ...change }, ctx).join(' ')).toMatch(message as RegExp);
  });

  it('refuses a title already used in the plan', () => {
    expect(checkSeo(GOOD, { ...ctx, otherTitles: [GOOD.title] }).join(' ')).toMatch(/already used in this plan/);
  });

  it('accepts a real autocomplete search as the focus keyword', () => {
    const answer = { ...GOOD, focusKeyword: 'vegan pumpkin chocolate chip cookies easy' };
    expect(checkSeo(answer, ctx).join(' ')).not.toMatch(/focus keyword must be/);
  });

  it('reads the answer and tidies the E-E-A-T name', () => {
    const parsed = parseSeoAnswer(`Sure! ${JSON.stringify({ ...GOOD, eeat: 'experience (tested)' })}`);
    expect(parsed?.eeat).toBe('Experience');
    expect(parseSeoAnswer('nonsense')).toBeNull();
  });
});

describe('AI#1 writer', () => {
  let planId: number;

  beforeEach(() => {
    openDatabase(':memory:');
    const websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes',
        nicheContext: 'Easy family baking.', persona: 'Storyteller', status: 'active', autoPublish: true,
        dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    planId = saveKeywordPlan(websiteId, 'pumpkin chocolate chip cookies', [{ keyword: KW, intent: 'diet', reason: '' }]);
  });

  afterEach(() => closeDatabase());

  it('sends the problems back and keeps the answer that passes', async () => {
    queuePlanSeo(planId, 'pumpkin chocolate chip cookies', [KW]);
    const sent: Record<string, unknown>[] = [];
    let call = 0;
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (_name, vars) => {
        sent.push(vars);
        call += 1;
        // The pillar: right first time. The sub-keyword: a short title, then right.
        if (vars.keyword !== KW) {
          return JSON.stringify({
            ...GOOD,
            title: 'Pumpkin Chocolate Chip Cookies: Soft, Easy and Spiced',
            description: 'Soft pumpkin chocolate chip cookies with warm spice and melty chocolate, ready in 30 minutes. Tested again and again at home. Learn how to bake them now.',
            focusKeyword: 'pumpkin chocolate chip cookies',
            altText: 'Pumpkin chocolate chip cookies stacked on a white plate today',
          });
        }
        return JSON.stringify(call === 2 ? { ...GOOD, title: 'Too short' } : GOOD);
      },
    });

    const [pillar, sub] = listPlanSeo(planId);
    expect(pillar).toMatchObject({ role: 'pillar', status: 'done' });
    expect(sub).toMatchObject({ role: 'sub', status: 'done', title: GOOD.title, eeat: 'Experience' });
    // Second try for the sub-keyword was told what was wrong, and which titles are taken.
    const retry = sent.filter((v) => v.keyword === KW)[1]!;
    expect(String(retry.problemsJson)).toMatch(/title is 9 characters/);
    expect(String(retry.takenTitlesJson)).toContain('Pumpkin Chocolate Chip Cookies: Soft');
    expect(retry.persona).toBe('Storyteller');
  });

  it('gives up after three rounds and says why', async () => {
    queuePlanSeo(planId, 'pumpkin chocolate chip cookies', []);
    let calls = 0;
    await kickSeoWriter({ suggest: async () => [], ask: async () => { calls += 1; return JSON.stringify({ ...GOOD, title: 'x' }); } });
    const [row] = listPlanSeo(planId);
    expect(calls).toBe(3);
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.problems).toMatch(/title is 1 characters/);
  });

  it('marks it failed with a plain reason when the AI is down', async () => {
    queuePlanSeo(planId, 'pumpkin chocolate chip cookies', []);
    await kickSeoWriter({ suggest: async () => [], ask: async () => { throw new Error('no endpoint'); } });
    expect(listPlanSeo(planId)[0]).toMatchObject({ status: 'failed', problems: expect.stringMatching(/AI could not be reached/) });
  });
});

describe('saving a plan starts AI#1', () => {
  let app: FastifyInstance;
  const ask = async (name: string, vars: Record<string, unknown>) =>
    name === 'seo-metadata'
      ? JSON.stringify(vars.keyword === KW ? GOOD : {
          ...GOOD,
          title: 'Pumpkin Chocolate Chip Cookies: Soft, Easy and Spiced',
          description: 'Soft pumpkin chocolate chip cookies with warm spice and melty chocolate, ready in 30 minutes. Tested again and again at home. Learn how to bake them now.',
          focusKeyword: 'pumpkin chocolate chip cookies',
          altText: 'Pumpkin chocolate chip cookies stacked on a white plate today',
        })
      : '{}';

  beforeEach(async () => {
    openDatabase(':memory:');
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, {
      encryptionKey: KEY,
      isPlatformReady: () => true,
      listPosts: async () => [],
      suggest: async () => [],
      ask,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  it('writes metadata for the pillar and every sub-keyword', async () => {
    const websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes',
        nicheContext: '', persona: 'Storyteller', status: 'active', autoPublish: true,
        dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    const r = await app.inject({
      method: 'POST',
      url: '/new-website/keywords/save',
      payload: new URLSearchParams({
        websiteId: String(websiteId),
        pillar: 'pumpkin chocolate chip cookies',
        items: JSON.stringify([{ keyword: KW, intent: 'diet', reason: '' }]),
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(r.json().ok).toBe(true);

    await kickSeoWriter({ ask, suggest: async () => [] }); // waits for the run the save started
    const page = await app.inject({ method: 'GET', url: `/new-website/keywords?website=${websiteId}` });
    expect(page.body).toContain(GOOD.title);
    expect(page.body).toContain('Pumpkin Chocolate Chip Cookies: Soft, Easy and Spiced');
  });
});
