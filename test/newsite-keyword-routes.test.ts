import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { all, closeDatabase, openDatabase } from '../src/db/index.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import { createNewWebsite, deleteNewWebsite, listKeywordPlans } from '../src/newsite/repo.js';
import type { SitePost } from '../src/newsite/client.js';
import { listPosts } from '../src/newsite/client.js';

const KEY = randomBytes(32);
const API_KEY = 'sk_k0_CEdT0mjNX4H0D8YPgqQIXtBD356wD';
const PILLAR = 'pumpkin chocolate chip cookies';

const SEARCHES = [
  'vegan pumpkin chocolate chip cookies',
  'pumpkin chocolate chip cookie bars',
  'easy pumpkin chocolate chip cookies',
];

describe('keyword routes', () => {
  let app: FastifyInstance;
  let websiteId: number;
  let posts: SitePost[];
  let postsFail: boolean;
  let asked: { domain: string; apiKey: string }[];

  const post = (url: string, fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

  beforeEach(async () => {
    openDatabase(':memory:');
    websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: API_KEY, niche: 'Recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    posts = [];
    postsFail = false;
    asked = [];
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, {
      encryptionKey: KEY,
      isPlatformReady: () => true,
      listPosts: async (domain, apiKey) => {
        asked.push({ domain, apiKey });
        if (postsFail) throw new Error('Could not reach f.longlivo.com to read its posts.');
        return posts;
      },
      suggest: async () => SEARCHES,
      ask: async () =>
        JSON.stringify({
          picks: [
            { keyword: 'vegan pumpkin chocolate chip cookies', intent: 'diet', reason: 'No eggs.' },
            { keyword: 'easy pumpkin chocolate chip cookies', intent: 'method', reason: 'x' },
          ],
        }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  it('shows the page for the website', async () => {
    const page = await app.inject({ method: 'GET', url: '/new-website/keywords' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Pillar keyword');
    expect(page.body).toContain('Saved plans for Long Livo');
  });

  it('asks the website for its posts with its own decrypted key', async () => {
    await post('/new-website/keywords/find', { websiteId: String(websiteId), pillar: PILLAR });
    expect(asked).toEqual([{ domain: 'f.longlivo.com', apiKey: API_KEY }]);
  });

  it('finds, filters and explains', async () => {
    const r = (await post('/new-website/keywords/find', { websiteId: String(websiteId), pillar: PILLAR })).json();
    expect(r.ok).toBe(true);
    expect(r.kept.map((k: { keyword: string }) => k.keyword)).toEqual(['vegan pumpkin chocolate chip cookies']);
    expect(r.dropped[0].keyword).toBe('easy pumpkin chocolate chip cookies');
  });

  it('stops when the site cannot be read, rather than skipping the duplicate check', async () => {
    postsFail = true;
    const r = (await post('/new-website/keywords/find', { websiteId: String(websiteId), pillar: PILLAR })).json();
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/duplicate check/) });
  });

  it('refuses a pillar the website already has', async () => {
    posts = [{ id: 1, slug: 'pumpkin-chocolate-chip-cookies', title: 'Best Pumpkin Chocolate Chip Cookies' }];
    const r = (await post('/new-website/keywords/find', { websiteId: String(websiteId), pillar: PILLAR })).json();
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Already covered by the post/) });
  });

  it('checks a keyword you add yourself', async () => {
    const ok = (await post('/new-website/keywords/check', {
      websiteId: String(websiteId), pillar: PILLAR, keyword: 'gluten free pumpkin chocolate chip cookies', others: '[]',
    })).json();
    expect(ok).toEqual({ ok: true, keyword: 'gluten free pumpkin chocolate chip cookies' });

    const bad = (await post('/new-website/keywords/check', {
      websiteId: String(websiteId), pillar: PILLAR, keyword: 'best pumpkin chocolate chip cookies', others: '[]',
    })).json();
    expect(bad.ok).toBe(false);
  });

  it('saves a plan, then treats its keywords as taken', async () => {
    const items = [
      { keyword: 'vegan pumpkin chocolate chip cookies', intent: 'diet', reason: 'No eggs.' },
      { keyword: 'gluten free pumpkin chocolate chip cookies', intent: 'yours', reason: '' },
    ];
    const r = (await post('/new-website/keywords/save', {
      websiteId: String(websiteId), pillar: PILLAR, items: JSON.stringify(items),
    })).json();
    expect(r.ok).toBe(true);
    expect(listKeywordPlans(websiteId)).toMatchObject([{ pillar: PILLAR, items }]);

    const again = (await post('/new-website/keywords/find', { websiteId: String(websiteId), pillar: PILLAR })).json();
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/saved plan/) });
  });

  it('re-checks everything on save', async () => {
    const r = (await post('/new-website/keywords/save', {
      websiteId: String(websiteId), pillar: PILLAR,
      items: JSON.stringify([{ keyword: 'easy pumpkin chocolate chip cookies', intent: 'method' }]),
    })).json();
    expect(r.ok).toBe(false);
    expect(all('SELECT * FROM keyword_plans')).toEqual([]);
  });

  it('refuses an empty plan or more than six', async () => {
    const none = (await post('/new-website/keywords/save', { websiteId: String(websiteId), pillar: PILLAR, items: '[]' })).json();
    expect(none.error).toMatch(/at least one/);
    const seven = Array.from({ length: 7 }, (_, i) => ({ keyword: `pumpkin chocolate chip cookies v${i}` }));
    const many = (await post('/new-website/keywords/save', { websiteId: String(websiteId), pillar: PILLAR, items: JSON.stringify(seven) })).json();
    expect(many.error).toMatch(/at most 6/);
  });

  it('removes plans with their website', async () => {
    await post('/new-website/keywords/save', {
      websiteId: String(websiteId), pillar: PILLAR,
      items: JSON.stringify([{ keyword: 'vegan pumpkin chocolate chip cookies', intent: 'diet' }]),
    });
    deleteNewWebsite(websiteId);
    expect(all('SELECT * FROM keyword_plans')).toEqual([]);
    expect(all('SELECT * FROM keyword_plan_items')).toEqual([]);
  });
});

describe('reading every post from the website', () => {
  it('follows the pages and stops at the last one', async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify({ items: [{ id: page, slug: `p${page}`, title: `Post ${page}` }], page, pages: 2 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await listPosts('f.longlivo.com', API_KEY, fake);
    expect(result.map((p) => p.title)).toEqual(['Post 1', 'Post 2']);
    expect(urls[0]).toBe('https://f.longlivo.com/api/v1/posts?perPage=100&page=1');
  });

  it('throws a plain message on a rejected key', async () => {
    const fake = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(listPosts('f.longlivo.com', API_KEY, fake)).rejects.toThrow(/rejected the API key/);
  });
});
