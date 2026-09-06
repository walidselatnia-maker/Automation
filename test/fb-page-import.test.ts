import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { listFbPages, upsertFbPage } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * The pages are on the token; nobody should be copying ids off Facebook.
 *
 * The client already asked the Graph API for every page the system user can
 * see, and the only caller was the token check — so thirty-odd page ids were
 * being transcribed into a form by hand.
 *
 * The half worth pinning down is what an import does to a page that is already
 * here. upsertFbPage overwrites auto_publish and enabled from its input, so an
 * import written the obvious way would re-enable a page somebody had turned
 * off on purpose, and start posting to it.
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

const runImport = () =>
  app.inject({
    method: 'POST',
    url: '/settings/facebook/pages/import',
    payload: '',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');

  const settings = new Settings(KEY);
  settings.set('fb_system_token', 'a-system-user-token');

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

describe('importing the pages the token can see', () => {
  it('adds a page that was not registered', async () => {
    graphReturns([{ id: '1010', name: 'Bitespoon Kitchen' }]);

    await runImport();

    const [page] = listFbPages();
    expect(page?.page_id).toBe('1010');
    expect(page?.name).toBe('Bitespoon Kitchen');
  });

  it('leaves a newly found page needing a decision before it publishes', async () => {
    // Discovering a page is not the same as deciding to post to it unattended.
    graphReturns([{ id: '1010', name: 'Bitespoon Kitchen' }]);

    await runImport();

    expect(listFbPages()[0]?.auto_publish).toBe(0);
    expect(listFbPages()[0]?.enabled).toBe(1);
  });

  it('does not re-enable a page somebody turned off', async () => {
    // The whole reason this is not a plain upsert loop.
    upsertFbPage({ pageId: '1010', name: 'Bitespoon Kitchen', autoPublish: false, enabled: false });
    graphReturns([{ id: '1010', name: 'Bitespoon Kitchen' }]);

    await runImport();

    expect(listFbPages()[0]?.enabled).toBe(0);
  });

  it('does not switch off a page that was publishing on its own', async () => {
    upsertFbPage({ pageId: '1010', name: 'Bitespoon Kitchen', autoPublish: true, enabled: true });
    graphReturns([{ id: '1010', name: 'Renamed On Facebook' }]);

    await runImport();

    const [page] = listFbPages();
    expect(page?.auto_publish).toBe(1);
    // ...while still picking up the rename, which is the point of re-importing.
    expect(page?.name).toBe('Renamed On Facebook');
  });

  it('says so when the token is valid but sees nothing', async () => {
    // A token with no pages is a Business Manager permission problem, not a
    // broken token, and the two need different remedies.
    graphReturns([]);

    const response = await runImport();

    expect(response.headers.location).toContain('warn=');
    expect(listFbPages()).toEqual([]);
  });

  it('reports a Graph failure instead of half-importing', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }));

    const response = await runImport();

    expect(response.headers.location).toContain('error=');
    expect(listFbPages()).toEqual([]);
  });
});
