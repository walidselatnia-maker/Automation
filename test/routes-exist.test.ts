import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { queuePlanSeo } from '../src/newsite/seo.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';
import { upsertEndpoint } from '../src/llm/pool.js';
import { SETUP_DONE_KEY } from '../src/newsite/platform.js';

/**
 * Every form on every page must post somewhere that exists.
 *
 * Written (for the old dashboard) after `POST /keywords/import` was deleted by a block removal that
 * was aiming at the routes either side of it. Nothing failed: it typechecked,
 * 447 tests passed, and the button stayed on the page. The only symptom was a
 * 404 in someone's face days later, on the one page you cannot use the app
 * without.
 *
 * A unit test per route would not have caught it either, because the route
 * that vanished had no test — that is what made it deletable. So this asserts
 * the property instead: crawl the rendered HTML, collect every action and
 * internal href, and check the server answers each of them with something
 * other than "no such route".
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

/** Pages worth crawling: everything with a form on it. */
const PAGES = [
  '/new-website/dashboard',
  '/new-website/home',
  '/new-website',
  '/new-website/add',
  '/new-website/channels',
  '/new-website/keywords',
  '/new-website/prompts',
  '/new-website/pin-designs',
  '/new-website/sharing',
  '/new-website/sharing/reels',
  '/new-website/platform',
  '/new-website/platform/setup',
];

describe('every control points at a route that exists', () => {
  let app: FastifyInstance;
  let cookie: string;
  let extra: string[] = [];

  beforeAll(async () => {
    setLogLevel('error');
    openDatabase(':memory:');

    // Enough rows that the per-record pages render with real ids in their
    // form actions rather than collapsing to empty states.
    const siteId = createNewWebsite(
      { name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '', persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 60, bufferToken: '', pinUsername: '', projectId: '' },
      KEY,
    );
    const planId = saveKeywordPlan(siteId, 'cakes', [], 'recipe');
    queuePlanSeo(planId, 'cakes', ['lemon cake'], 'recipe');

    extra = [`/new-website/${siteId}/edit`, `/new-website/keywords/plan/${planId}/seo`];

    // The new dashboard sends everything to Platform until it is set up;
    // set it up so its pages render rather than redirect.
    const settings = new Settings(KEY);
    settings.set(SETUP_DONE_KEY, 'true');
    upsertEndpoint({ name: 'Main key', baseUrl: '', apiKey: 'abc123secretkey', models: ['gpt-oss:120b'], enabled: true }, KEY);

    app = buildServer(settings, KEY, {
      password: PASSWORD,
      secret: KEY,
      generated: false,
    });
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const header = login.headers['set-cookie'];
    cookie = Array.isArray(header) ? header[0]! : String(header);
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
  });

  /** Collect form actions and internal links from one rendered page. */
  const controlsOn = async (url: string): Promise<{ posts: string[]; gets: string[] }> => {
    const response = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(response.statusCode, `${url} should render`).toBe(200);

    const posts = [...response.body.matchAll(/<form[^>]*method="post"[^>]*action="([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    const gets = [...response.body.matchAll(/href="(\/[^"#?]*)/g)]
      .map((m) => m[1]!)
      .filter((href) => !href.startsWith('/static/'));

    return { posts, gets };
  };

  it('crawls every page and finds no dead control', async () => {
    // The old dashboard's address opens the Dashboard.
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).headers.location).toBe('/new-website/dashboard');
    const posts = new Set<string>();
    const gets = new Set<string>();

    for (const url of [...PAGES, ...extra]) {
      const found = await controlsOn(url);
      found.posts.forEach((a) => posts.add(a));
      found.gets.forEach((h) => gets.add(h));
    }

    // Sanity: the crawl has to have actually found things, or this test would
    // pass by finding nothing and checking nothing.
    expect(posts.size).toBeGreaterThan(10);
    expect(gets.size).toBeGreaterThan(15);

    const dead: string[] = [];

    for (const url of posts) {
      // The database is in memory and thrown away, so a real POST is safe and
      // is the only way to be sure the route resolves the way a browser's
      // submission would.
      const res = await app.inject({
        method: 'POST',
        url,
        payload: '',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      });
      if (res.statusCode === 404) dead.push(`POST ${url}`);
    }

    for (const url of gets) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      if (res.statusCode === 404) dead.push(`GET ${url}`);
    }

    expect(dead, 'controls pointing at routes that do not exist').toEqual([]);
    // Generous on purpose: this renders every page in the app and then asks
    // for every control it found, which lands within a second of the default
    // five on its own and over it whenever the rest of the suite is running
    // alongside. The slowness is the point of the test, not a symptom.
  }, 30_000);

});
