import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
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

  it('answers 404 for a site that does not exist', async () => {
    const cookie = await loginCookie();
    const res = await app.inject({ method: 'GET', url: '/guide/999', headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});
