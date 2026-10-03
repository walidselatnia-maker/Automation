import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { getCursor, markDone, saveResult } from '../src/guide/state.js';
import { all } from '../src/db/index.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

describe('guide routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    app = buildServer(new Settings(KEY), KEY, { password: PASSWORD, secret: KEY, generated: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  const loginCookie = async (): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const header = response.headers['set-cookie'];
    return Array.isArray(header) ? header[0]! : String(header);
  };

  const addSite = () =>
    upsertSite(
      { name: 'Bitespoon', domain: 'bitespoon.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 0 },
      KEY,
    );

  it('lists sites and opens a card', async () => {
    const siteId = addSite();
    const cookie = await loginCookie();

    const list = await app.inject({ method: 'GET', url: '/guide', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('bitespoon.com');

    const card = await app.inject({ method: 'GET', url: `/guide/${siteId}`, headers: { cookie } });
    expect(card.statusCode).toBe(200);
    expect(card.body).toContain('Step 1 of 6');
  });

  it('saves a typed result and moves on with Done', async () => {
    const siteId = addSite();
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

  it('refuses a draft with the wrong shape instead of saving it', async () => {
    const siteId = addSite();
    const cookie = await loginCookie();
    const form = { 'content-type': 'application/x-www-form-urlencoded', cookie };

    const bad = await app.inject({
      method: 'POST',
      url: `/guide/${siteId}/save`,
      headers: form,
      payload: 'draft_json=' + encodeURIComponent(JSON.stringify({ identity: 42 })),
    });
    expect(bad.headers.location).toContain('warn=');

    const garbage = await app.inject({
      method: 'POST',
      url: `/guide/${siteId}/save`,
      headers: form,
      payload: 'draft_json=' + encodeURIComponent('{not json'),
    });
    expect(garbage.headers.location).toContain('error=');

    // Nothing was stored, so Done is still refused.
    const done = await app.inject({ method: 'POST', url: `/guide/${siteId}/done`, headers: form, payload: '' });
    expect(done.headers.location).toContain('warn=');
  });

  /** Walk the cursor to the import step with a valid shortlist saved. */
  const reachImport = (siteId: number): void => {
    const items = [
      { keyword: 'Pillar guide', type: 'article' },
      ...Array.from({ length: 5 }, (_, i) => ({ keyword: `recipe ${i}`, type: 'recipe' })),
    ];
    const steps: Array<[string, unknown]> = [
      ['identity', { identity: 'Quick dinners for busy parents' }],
      ['pillars', { pillars: ['a', 'b', 'c'] }],
      ['search-console', { confirmed: true }],
      ['keywords', { pillar: 'a', keywords: Array.from({ length: 10 }, (_, i) => `kw ${i}`) }],
      ['shortlist', { pillar: 'a', items }],
    ];
    for (const [step, value] of steps) {
      const cursor = getCursor(siteId);
      expect(saveResult(siteId, step as never, cursor.round, value).ok).toBe(true);
      expect(markDone(siteId).ok).toBe(true);
    }
    expect(getCursor(siteId).step).toBe('import');
  };

  it('does not let a saved draft finish the import step', async () => {
    const siteId = addSite();
    const cookie = await loginCookie();
    const form = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    reachImport(siteId);

    const save = await app.inject({
      method: 'POST',
      url: `/guide/${siteId}/save`,
      headers: form,
      payload: 'draft_json=' + encodeURIComponent(JSON.stringify({ imported_ids: [1] })),
    });
    expect(save.headers.location).toContain('warn=');

    const done = await app.inject({ method: 'POST', url: `/guide/${siteId}/done`, headers: form, payload: '' });
    expect(done.headers.location).toContain('warn=');
  });

  it('imports once even if the button is submitted twice', async () => {
    const siteId = addSite();
    const cookie = await loginCookie();
    const form = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    reachImport(siteId);

    const payload = 'pick=0&pick=1&pick=2';
    const first = await app.inject({ method: 'POST', url: `/guide/${siteId}/import`, headers: form, payload });
    expect(first.headers.location).not.toContain('warn=');
    const count = () => all<{ id: number }>('SELECT id FROM keywords').length;
    expect(count()).toBe(3);

    const second = await app.inject({ method: 'POST', url: `/guide/${siteId}/import`, headers: form, payload });
    expect(second.headers.location).not.toContain('warn=');
    expect(count()).toBe(3);
  });

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

  it('answers 404 for a site that does not exist', async () => {
    const cookie = await loginCookie();
    const res = await app.inject({ method: 'GET', url: '/guide/999', headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});
