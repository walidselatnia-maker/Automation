import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { all, closeDatabase, openDatabase, run } from '../src/db/index.js';
import { decrypt } from '../src/lib/crypto.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import type { SiteCheck } from '../src/newsite/client.js';
import { checkSite } from '../src/newsite/client.js';
import type { NewWebsiteRow } from '../src/newsite/repo.js';

const KEY = randomBytes(32);
const API_KEY = 'sk_test_FAKE0000000000000000000000';

const GOOD = {
  name: 'Long Livo',
  domain: 'https://F.longlivo.com/',
  apiKey: API_KEY,
  niche: 'Recipes',
  nicheContext: 'Easy family dinners.',
  persona: 'Storyteller',
  customPersona: '',
  status: 'active',
  autoPublish: '1',
  dailyTarget: '3',
  gapAmount: '8',
  gapUnit: 'hours',
  bufferToken: '',
  pinUsername: '',
  projectId: '',
};

describe('new website routes', () => {
  let app: FastifyInstance;
  let siteAnswer: SiteCheck;
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
    siteAnswer = { ok: true, siteName: 'Long Livo', types: ['recipe', 'article'] };
    asked = [];
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, {
      encryptionKey: KEY,
      isPlatformReady: () => true,
      checkSite: async (domain, apiKey) => {
        asked.push({ domain, apiKey });
        return siteAnswer;
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  it('shows the wizard and the empty list', async () => {
    const wizard = await app.inject({ method: 'GET', url: '/new-website/add' });
    expect(wizard.statusCode).toBe(200);
    expect(wizard.body).toContain('Add a website');
    // Its own dashboard: not the old layout or stylesheet.
    expect(wizard.body).toContain('Back to old dashboard');
    expect(wizard.body).not.toContain('/static/style.css');
    const list = await app.inject({ method: 'GET', url: '/new-website' });
    expect(list.body).toContain('No websites yet');
  });

  it('refuses a bad address without calling the site', async () => {
    const r = (await post('/new-website/check', { ...GOOD, domain: 'not a domain', step: '0' })).json();
    expect(r.errors.domain).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it('asks the real site on step 1 with the cleaned address and passes its answer on', async () => {
    const r = (await post('/new-website/check', { ...GOOD, step: '0' })).json();
    expect(r.errors).toEqual({});
    expect(asked).toEqual([{ domain: 'f.longlivo.com', apiKey: API_KEY }]);
    expect(r.siteName).toBe('Long Livo');
  });

  it('puts a rejected key on the key field', async () => {
    siteAnswer = { ok: false, field: 'apiKey', error: 'rejected' };
    const r = (await post('/new-website/check', { ...GOOD, step: '0' })).json();
    expect(r.errors).toEqual({ apiKey: 'rejected' });
  });

  it('checks only the step it is asked about', async () => {
    const r = (await post('/new-website/check', { step: '1', niche: '' })).json();
    expect(Object.keys(r.errors)).toEqual(['niche']);
    expect(asked).toEqual([]);
  });

  it('saves a good website with its secrets encrypted', async () => {
    const r = (await post('/new-website/save', { ...GOOD, bufferToken: 'buffer-token-123' })).json();
    expect(r.saved).toBe(true);

    const [row] = all<NewWebsiteRow>('SELECT * FROM new_websites');
    expect(row).toMatchObject({
      name: 'Long Livo',
      domain: 'f.longlivo.com',
      niche: 'Recipes',
      persona: 'Storyteller',
      status: 'active',
      auto_publish: 1,
      daily_target: 3,
      interval_minutes: 480,
    });
    expect(row!.api_key_encrypted).not.toContain(API_KEY);
    expect(decrypt(row!.api_key_encrypted, KEY)).toBe(API_KEY);
    expect(decrypt(row!.buffer_token_encrypted, KEY)).toBe('buffer-token-123');

    const list = await app.inject({ method: 'GET', url: '/new-website' });
    expect(list.body).toContain('f.longlivo.com');
    expect(list.body).not.toContain(API_KEY);
  });

  it('saves which channels the website shares its articles on', async () => {
    run(`INSERT INTO newsite_channels (platform, name, buffer_channel_id) VALUES ('pinterest', 'longlivo', 'ch1')`);
    run(`INSERT INTO newsite_channels (platform, name, fb_page_id) VALUES ('facebook', 'Easy Cakes', 'p1')`);
    const wizard = await app.inject({ method: 'GET', url: '/new-website/add' });
    expect(wizard.body).toContain('Share this website’s articles on');
    expect(wizard.body).toContain('data-name="longlivo"');
    const r = (await post('/new-website/save', { ...GOOD, channelId: '2' })).json();
    expect(r.saved).toBe(true);
    expect(all('SELECT website_id, channel_id FROM newsite_website_channels')).toEqual([{ website_id: 1, channel_id: 2 }]);
  });

  it('does not touch the old sites table', async () => {
    await post('/new-website/save', GOOD);
    expect(all('SELECT * FROM sites')).toEqual([]);
  });

  it('refuses to save and says which step to go back to', async () => {
    const r = (await post('/new-website/save', { ...GOOD, niche: '', gapAmount: 'abc' })).json();
    expect(r.saved).toBeUndefined();
    expect(Object.keys(r.errors).sort()).toEqual(['gapAmount', 'niche']);
    expect(r.step).toBe(1);
    expect(all('SELECT * FROM new_websites')).toEqual([]);
  });

  it('refuses to save when the site rejects the key', async () => {
    siteAnswer = { ok: false, field: 'apiKey', error: 'rejected' };
    const r = (await post('/new-website/save', GOOD)).json();
    expect(r.errors.apiKey).toBe('rejected');
    expect(r.step).toBe(0);
    expect(all('SELECT * FROM new_websites')).toEqual([]);
  });

  it('will not add the same website twice', async () => {
    await post('/new-website/save', GOOD);
    const again = (await post('/new-website/save', GOOD)).json();
    expect(again.errors.domain).toMatch(/already been added/);
    expect(all('SELECT * FROM new_websites')).toHaveLength(1);
  });

  describe('editing', () => {
    const saved = async () => {
      await post('/new-website/save', { ...GOOD, bufferToken: 'buffer-token-123' });
      return all<NewWebsiteRow>('SELECT * FROM new_websites')[0]!;
    };

    it('opens the wizard filled in, without sending the secrets back', async () => {
      const row = await saved();
      const page = await app.inject({ method: 'GET', url: `/new-website/${row.id}/edit` });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Edit Long Livo');
      expect(page.body).toContain('value="f.longlivo.com"');
      expect(page.body).toContain('Leave empty to keep the saved key');
      expect(page.body).not.toContain(API_KEY);
      expect(page.body).not.toContain('buffer-token-123');
    });

    it('keeps the saved key and token when left empty, and checks the site with the saved key', async () => {
      const row = await saved();
      asked = [];
      const r = (await post('/new-website/save', {
        ...GOOD, id: String(row.id), apiKey: '', bufferToken: '', niche: 'Baking', dailyTarget: '5',
      })).json();
      expect(r.saved).toBe(true);
      expect(asked).toEqual([{ domain: 'f.longlivo.com', apiKey: API_KEY }]);

      const [after] = all<NewWebsiteRow>('SELECT * FROM new_websites');
      expect(after).toMatchObject({ id: row.id, niche: 'Baking', daily_target: 5 });
      expect(decrypt(after!.api_key_encrypted, KEY)).toBe(API_KEY);
      expect(decrypt(after!.buffer_token_encrypted, KEY)).toBe('buffer-token-123');
    });

    it('replaces the key when a new one is typed, and can remove the Buffer token', async () => {
      const row = await saved();
      const fresh = 'sk_new_ABCDEFGHIJKLMNOPQRSTUVWX';
      await post('/new-website/save', { ...GOOD, id: String(row.id), apiKey: fresh, bufferToken: '', removeBuffer: '1' });
      const [after] = all<NewWebsiteRow>('SELECT * FROM new_websites');
      expect(decrypt(after!.api_key_encrypted, KEY)).toBe(fresh);
      expect(after!.buffer_token_encrypted).toBe('');
    });

    it('does not call its own address a duplicate, but refuses another website’s', async () => {
      const row = await saved();
      await post('/new-website/save', { ...GOOD, domain: 'other.example.com' });
      const r = (await post('/new-website/save', { ...GOOD, id: String(row.id), apiKey: '', domain: 'other.example.com' })).json();
      expect(r.errors.domain).toMatch(/already been added/);
      const same = (await post('/new-website/save', { ...GOOD, id: String(row.id), apiKey: '' })).json();
      expect(same.saved).toBe(true);
      expect(all('SELECT * FROM new_websites')).toHaveLength(2);
    });

    it('still validates everything', async () => {
      const row = await saved();
      const r = (await post('/new-website/save', { ...GOOD, id: String(row.id), apiKey: '', name: '' })).json();
      expect(r.errors.name).toBeTruthy();
    });

    it('says so when the website was removed meanwhile', async () => {
      const r = (await post('/new-website/check', { ...GOOD, id: '999', step: '0' })).json();
      expect(r.errors.name).toMatch(/no longer exists/);
    });
  });

  it('removes a website', async () => {
    await post('/new-website/save', GOOD);
    const [row] = all<NewWebsiteRow>('SELECT * FROM new_websites');
    const res = await app.inject({ method: 'POST', url: `/new-website/${row!.id}/delete` });
    expect(res.statusCode).toBe(303);
    expect(all('SELECT * FROM new_websites')).toEqual([]);
  });
});

describe('site check', () => {
  const answer = (status: number, json?: unknown) =>
    (async () => new Response(json === undefined ? 'nope' : JSON.stringify(json), { status })) as typeof fetch;

  it('accepts a blog-engine site and lists its kinds', async () => {
    const r = await checkSite('f.longlivo.com', API_KEY, answer(200, { name: 'Long Livo', types: [{ key: 'recipe' }, { key: 'article' }] }));
    expect(r).toEqual({ ok: true, siteName: 'Long Livo', types: ['recipe', 'article'] });
  });

  it('sends the key as a bearer header to the right address', async () => {
    let seen: { url: string; auth: string } | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization! };
      return new Response('{}', { status: 401 });
    }) as unknown as typeof fetch;
    await checkSite('f.longlivo.com', API_KEY, spy);
    expect(seen).toEqual({ url: 'https://f.longlivo.com/api/v1/site', auth: `Bearer ${API_KEY}` });
  });

  it('blames the key on 401, and never prints it', async () => {
    const r = await checkSite('f.longlivo.com', API_KEY, answer(401, { error: 'x' }));
    expect(r).toMatchObject({ ok: false, field: 'apiKey' });
    expect(JSON.stringify(r)).not.toContain(API_KEY);
  });

  it('blames the address when the site is down, errors, or is something else', async () => {
    const down = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    expect(await checkSite('x.example.com', API_KEY, down)).toMatchObject({ ok: false, field: 'domain' });
    expect(await checkSite('x.example.com', API_KEY, answer(500))).toMatchObject({ ok: false, field: 'domain' });
    expect(await checkSite('x.example.com', API_KEY, answer(200, { hello: 1 }))).toMatchObject({ ok: false, field: 'domain' });
  });
});
