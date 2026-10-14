import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { all, closeDatabase, openDatabase } from '../src/db/index.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import { createNewWebsite, deleteNewWebsite, listKeywordPlans } from '../src/newsite/repo.js';
import type { SitePost } from '../src/newsite/client.js';
import { listPosts } from '../src/newsite/client.js';
import { kickSubFinder } from '../src/newsite/keyword-import.js';

const KEY = randomBytes(32);
const API_KEY = 'sk_test_FAKE0000000000000000000000';
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
      autoSeo: false,
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

  it('shows a card per website, and the one-keyword page through Add keywords', async () => {
    const page = await app.inject({ method: 'GET', url: '/new-website/keywords' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`id="website-${websiteId}"`);
    expect(page.body).toContain('Long Livo');
    expect(page.body).toContain('href="/new-website/keywords/add">Add keywords</a>');
    const add = await app.inject({ method: 'GET', url: '/new-website/keywords/add' });
    expect(add.body).toContain('A CSV file');
    const one = await post('/new-website/keywords/add', { how: 'one', websiteId: String(websiteId) });
    expect(one.headers.location).toBe(`/new-website/keywords/new?website=${websiteId}`);
    const finder = await app.inject({ method: 'GET', url: one.headers.location as string });
    expect(finder.body).toContain('Pillar keyword');
    expect((await post('/new-website/keywords/add', { how: 'csv' })).headers.location).toBe('/new-website/keywords/import');
  });

  describe('importing a CSV file', () => {
    const draftIn = (body: string): string => body.match(/name="draft" value="([0-9a-f]+)"/)![1]!;
    let second: number;
    beforeEach(() => {
      second = createNewWebsite(
        {
          name: 'Bake Hub', domain: 'bakehub.com', apiKey: API_KEY, niche: 'Recipes', nicheContext: '',
          persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
          bufferToken: '', pinUsername: '', projectId: '',
        },
        KEY,
      );
    });

    it('takes a file with only Main Keyword and Target Website, each keyword for its own website', async () => {
      const csv = 'Main Keyword,Target Website\nstrawberry cake,f.longlivo.com\nbanana bread,https://www.bakehub.com/\n';
      const check = await post('/new-website/keywords/import/check', { csv });
      expect(check.body).toContain('2 ready');
      expect(check.body).toContain('2 without sub-keywords: the platform finds them');
      const saved = await post('/new-website/keywords/import/save', { draft: draftIn(check.body) });
      expect(saved.headers.location).toMatch(/Imported%202%20keywords/);
      const plans = listKeywordPlans();
      expect(plans.find((p) => p.pillar === 'strawberry cake')).toMatchObject({ website_id: websiteId, source: 'csv', subs_status: 'finding', items: [] });
      expect(plans.find((p) => p.pillar === 'banana bread')).toMatchObject({ website_id: second, subs_status: 'finding' });
    });

    it('keeps a niche and sub-keywords when they are given, and sends the keyword straight on', async () => {
      const csv = 'main keyword;target website;niche;subkeywords\n"lemon tart";f.longlivo.com;Baking;"lemon tart filling | mini lemon tarts | lemon tart"\n';
      const check = await post('/new-website/keywords/import/check', { csv });
      expect(check.body).toContain('1 ready');
      expect(check.body).toContain('1 repeated sub-keyword left out.');
      await post('/new-website/keywords/import/save', { draft: draftIn(check.body) });
      const plan = listKeywordPlans(websiteId).find((p) => p.pillar === 'lemon tart')!;
      expect(plan).toMatchObject({ niche: 'Baking', subs_status: '' });
      expect(plan.items.map((i) => i.keyword)).toEqual(['lemon tart filling', 'mini lemon tarts']);
      // Into the pipeline at once: the pillar and both sub-keywords wait for their SEO.
      expect(all('SELECT keyword FROM keyword_seo WHERE plan_id = ?', plan.id)).toHaveLength(3);
    });

    it('says what is wrong with each row before anything is saved', async () => {
      posts = [{ id: 1, title: 'Chocolate Mousse Cake', status: 'published', url: '', type: 'recipe' } as unknown as SitePost];
      const csv = [
        'Main Keyword,Target Website,Niche,Subkeywords',
        'apple pie,unknown.com,,',
        ',f.longlivo.com,,',
        'apple pie,f.longlivo.com,,',
        'Apple Pie,f.longlivo.com,,',
        'chocolate mousse cake,f.longlivo.com,,',
      ].join('\n');
      const check = await post('/new-website/keywords/import/check', { csv });
      expect(check.body).toContain('“unknown.com” is not one of your websites');
      expect(check.body).toContain('The main keyword is empty.');
      expect(check.body).toContain('The same keyword for the same website is already on line 4.');
      expect(check.body).toContain('Already covered by the post “Chocolate Mousse Cake”');
      expect(check.body).toContain('1 ready');
      expect(check.body).toContain('4 with problems: not imported');
      expect(listKeywordPlans()).toHaveLength(0); // nothing saved by the check
      const noHeader = await post('/new-website/keywords/import/check', { csv: 'apple pie,f.longlivo.com\n' });
      expect(noHeader.body).toContain('Main Keyword');
      expect(noHeader.body).toContain('must name the columns');
    });

    it('finds the missing sub-keywords with the platform’s own finder, then sends the keyword on', async () => {
      const check = await post('/new-website/keywords/import/check', { csv: `Main Keyword,Target Website\n${PILLAR},f.longlivo.com\n` });
      await post('/new-website/keywords/import/save', { draft: draftIn(check.body) });
      let started = 0;
      await kickSubFinder({
        suggest: async () => SEARCHES,
        ask: async () => JSON.stringify({ picks: [{ keyword: 'vegan pumpkin chocolate chip cookies', intent: 'diet', reason: 'No eggs.' }] }),
        listPosts: async () => [],
        encryptionKey: KEY,
        startSeo: () => started++,
      });
      const plan = listKeywordPlans(websiteId)[0]!;
      expect(plan.subs_status).toBe('');
      expect(plan.items.map((i) => i.keyword)).toEqual(['vegan pumpkin chocolate chip cookies']);
      expect(all('SELECT keyword FROM keyword_seo WHERE plan_id = ?', plan.id)).toHaveLength(2);
      expect(started).toBe(1);
      const page = await app.inject({ method: 'GET', url: '/new-website/keywords' });
      expect(page.body).toContain('vegan pumpkin chocolate chip cookies');
      expect(page.body).toContain('From a CSV file');
    });

    it('sends the main keyword on alone when no sub-keyword can be found', async () => {
      const check = await post('/new-website/keywords/import/check', { csv: `Main Keyword,Target Website\n${PILLAR},f.longlivo.com\n` });
      await post('/new-website/keywords/import/save', { draft: draftIn(check.body) });
      await kickSubFinder({ suggest: async () => [], ask: async () => '{}', listPosts: async () => [], encryptionKey: KEY, startSeo: () => {} });
      const plan = listKeywordPlans(websiteId)[0]!;
      expect(plan.subs_status).toBe('failed');
      expect(plan.subs_error).toMatch(/Google autocomplete could not be reached/);
      expect(all('SELECT keyword FROM keyword_seo WHERE plan_id = ?', plan.id)).toHaveLength(1);
    });
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
