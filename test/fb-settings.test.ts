import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  getFbPage,
  insertFbToken,
  insertKeyword,
  listFbPages,
  listFbTokens,
  setFbPageOptions,
  syncFbPages,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Settings -> Facebook is two tables. A token brings its pages the moment it
 * is added; a page takes one niche. Nothing on the page waits for Graph.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

let app: FastifyInstance;
let cookie: string;

/** Answer /me/accounts with these pages, and nothing else over the network. */
const graphReturns = (pages: { id: string; name: string }[]): void => {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (!url.includes('/me/accounts')) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify({ data: pages }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
};

const post = (url: string, fields: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    payload: new URLSearchParams(fields).toString(),
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });

const flashOf = (res: { headers: Record<string, unknown> }): string =>
  decodeURIComponent(String(res.headers.location ?? '')).replace(/\+/g, ' ');

const sorted = () => [...listFbPages()].sort((a, b) => a.page_id.localeCompare(b.page_id));

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');

  const settings = new Settings(KEY);
  app = buildServer(settings, KEY, { password: PASSWORD, secret: KEY, generated: false });
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

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDatabase();
});

describe('Settings -> Facebook', () => {
  it('adding a token lists its pages at once', async () => {
    graphReturns([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);

    const res = await post('/settings/facebook/tokens', { name: 'App 1', token: 'EAAB' });

    expect(res.statusCode).toBe(303);
    expect(flashOf(res)).toContain('App 1: 2 page(s)');
    expect(listFbPages().map((p) => p.name).sort()).toEqual(['One', 'Two']);
    expect(listFbTokens()[0]!.page_count).toBe(2);
  });

  it('a token Graph refuses is kept with the reason on it', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const res = await post('/settings/facebook/tokens', { name: 'Bad', token: 'nope' });

    expect(flashOf(res)).toContain('Invalid OAuth');
    expect(listFbTokens()).toHaveLength(1);
    expect(listFbTokens()[0]!.last_error).toContain('Invalid OAuth');
  });

  it('refuses an empty token without creating anything', async () => {
    const res = await post('/settings/facebook/tokens', { name: 'X', token: '  ' });
    expect(flashOf(res)).toContain('error=');
    expect(listFbTokens()).toEqual([]);
  });

  it('assigns a niche to a page and refuses the same niche twice', async () => {
    insertKeyword({ seed_keyword: 'soup', spy_title: 's' });
    graphReturns([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });
    const [one, two] = sorted();

    let res = await post(`/settings/facebook/pages/${one!.id}`, {
      niche: 'soup',
      autoPublish: 'on',
      enabled: 'on',
    });
    expect(flashOf(res)).toContain('ok=');
    expect(getFbPage(one!.id)).toMatchObject({ niche: 'soup', auto_publish: 1, enabled: 1 });

    res = await post(`/settings/facebook/pages/${two!.id}`, {
      niche: 'soup',
      autoPublish: 'on',
      enabled: 'on',
    });
    expect(flashOf(res)).toContain('already on One');
    expect(getFbPage(two!.id)!.niche).toBeNull();
  });

  it('an unticked box is off', async () => {
    graphReturns([{ id: '1', name: 'One' }]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });

    await post(`/settings/facebook/pages/${listFbPages()[0]!.id}`, { niche: '' });

    expect(listFbPages()[0]).toMatchObject({ niche: null, auto_publish: 0, enabled: 0 });
  });

  it('refuses a niche no keyword has', async () => {
    graphReturns([{ id: '1', name: 'One' }]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });

    const res = await post(`/settings/facebook/pages/${listFbPages()[0]!.id}`, {
      niche: 'nothing',
      enabled: 'on',
    });

    expect(flashOf(res)).toContain('No keyword');
  });

  it('refreshing a token disables a page it no longer manages', async () => {
    graphReturns([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });

    graphReturns([{ id: '1', name: 'One' }]);
    const res = await post(`/settings/facebook/tokens/${listFbTokens()[0]!.id}/refresh`, {});

    expect(flashOf(res)).toContain('1 no longer there');
    expect(sorted()[1]).toMatchObject({ enabled: 0 });
  });

  it('removing a token removes its pages', async () => {
    graphReturns([{ id: '1', name: 'One' }]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });

    await post(`/settings/facebook/tokens/${listFbTokens()[0]!.id}/delete`, {});

    expect(listFbTokens()).toEqual([]);
    expect(listFbPages()).toEqual([]);
  });

  it('renders the page without calling Graph', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('no network on render');
    });
    insertKeyword({ seed_keyword: 'soup', spy_title: 's' });
    const token = insertFbToken('A', 'x', KEY);
    syncFbPages(token, [{ id: '1', name: 'One' }]);
    setFbPageOptions(listFbPages()[0]!.id, { niche: 'soup', autoPublish: true, enabled: true });

    const res = await app.inject({ method: 'GET', url: '/settings/facebook', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Tokens');
    expect(res.body).toContain('Pages');
    expect(res.body).toMatch(/value="soup"\s+selected/);
    expect(res.body).not.toMatch(/route/i);
  });
});
