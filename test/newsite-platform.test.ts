import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { listEndpointRows, upsertEndpoint } from '../src/llm/pool.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import { normalizeBaseUrl, parseBulkKeys, SETUP_DONE_KEY, validatePlatform } from '../src/newsite/platform.js';

const KEY = randomBytes(32);
const TG_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';

/** A full, valid platform form as the wizard submits it. */
const FORM: Record<string, string> = {
  llm_base_url: 'https://ollama.com',
  newKeyName: 'Main key',
  newKeyValue: 'abc123secretkey',
  newKeyModels: 'gpt-oss:120b',
  removeKeys: '',
  timezone: 'Africa/Algiers',
  auto_retry_enabled: 'true',
  auto_retry_max: '1',
  auto_retry_delay_minutes: '15',
  flow_project_id: '',
  image_model: 'auto',
  image_gap_seconds: '30',
  telegram_enabled: 'false',
  telegram_bot_token: '',
  telegram_chat_id: '',
};

describe('platform rules', () => {
  const none = { keys: [], hasTelegramToken: false };

  it('accepts the defaults with one new key', () => {
    const { errors, clean } = validatePlatform(FORM, none);
    expect(errors).toEqual({});
    expect(clean.newKey).toEqual({ name: 'Main key', apiKey: 'abc123secretkey', models: ['gpt-oss:120b'] });
    expect(clean.settings.auto_retry_max).toBe('1');
  });

  it('needs at least one AI key', () => {
    expect(validatePlatform({ ...FORM, newKeyName: '', newKeyValue: '' }, none).errors.newKeyValue).toMatch(/at least one AI key/);
    const withSaved = validatePlatform({ ...FORM, newKeyName: '', newKeyValue: '' }, { keys: [{ id: 1, name: 'Old' }], hasTelegramToken: false });
    expect(withSaved.errors).toEqual({});
    const removingLast = validatePlatform({ ...FORM, newKeyName: '', newKeyValue: '', removeKeys: '1' }, { keys: [{ id: 1, name: 'Old' }], hasTelegramToken: false });
    expect(removingLast.errors.newKeyValue).toMatch(/at least one AI key/);
  });

  it('refuses a duplicate key name, no models, and junk keys', () => {
    const ctx = { keys: [{ id: 1, name: 'Main key' }], hasTelegramToken: false };
    expect(validatePlatform(FORM, ctx).errors.newKeyName).toMatch(/already exists/);
    expect(validatePlatform({ ...FORM, newKeyModels: '' }, none).errors.newKeyModels).toBeTruthy();
    expect(validatePlatform({ ...FORM, newKeyModels: 'made-up-model' }, none).errors.newKeyModels).toBeTruthy();
    expect(validatePlatform({ ...FORM, newKeyValue: 'has space' }, none).errors.newKeyValue).toBeTruthy();
  });

  it.each([
    ['auto_retry_max', 'abc'],
    ['auto_retry_max', '11'],
    ['auto_retry_delay_minutes', '-5'],
    ['image_gap_seconds', '1.5'],
  ])('refuses %s = %s', (key, value) => {
    expect(validatePlatform({ ...FORM, [key]: value }, none).errors[key]).toBeTruthy();
  });

  it('reads pasted keys: bare or named, numbered after taken names, duplicates once', () => {
    const r = parseBulkKeys('sk-aaaaaaaa1\n\n# note\nBackup = sk-bbbbbbbb2\nsk-aaaaaaaa1\nsk-cccccccc3', ['Key 01']);
    expect(r.problems).toEqual([]);
    expect(r.keys).toEqual([
      { name: 'Backup', apiKey: 'sk-bbbbbbbb2' },
      { name: 'Key 02', apiKey: 'sk-aaaaaaaa1' },
      { name: 'Key 03', apiKey: 'sk-cccccccc3' },
    ]);
    expect(parseBulkKeys('short\nMain key = sk-dddddddd4', ['main key']).problems).toEqual([
      'Line 1 does not look like an API key (no spaces, at least 8 characters).',
      'Line 2: a key named "Main key" already exists.',
    ]);
  });

  it('accepts pasted keys instead of a single one', () => {
    const { errors, clean } = validatePlatform({ ...FORM, newKeyName: '', newKeyValue: '', bulkKeys: 'sk-aaaaaaaa1\nsk-bbbbbbbb2' }, none);
    expect(errors).toEqual({});
    expect(clean.bulkKeys.map((k) => [k.name, k.models])).toEqual([['Key 01', ['gpt-oss:120b']], ['Key 02', ['gpt-oss:120b']]]);
  });

  it('checks the timezone, image model, Flow project and switches', () => {
    const bad = validatePlatform({ ...FORM, timezone: 'Mars/Base', image_model: 'x', flow_project_id: 'no' }, none);
    expect(Object.keys(bad.errors).sort()).toEqual(['flow_project_id', 'image_model', 'timezone']);
  });

  it('needs a token and chat ID only when Telegram is on', () => {
    expect(validatePlatform(FORM, none).errors).toEqual({});
    const on = validatePlatform({ ...FORM, telegram_enabled: 'true' }, none).errors;
    expect(Object.keys(on).sort()).toEqual(['telegram_bot_token', 'telegram_chat_id']);
    const keep = validatePlatform({ ...FORM, telegram_enabled: 'true', telegram_chat_id: '-1001234567' }, { keys: [], hasTelegramToken: true });
    expect(keep.errors).toEqual({});
    expect(validatePlatform({ ...FORM, telegram_bot_token: 'nope' }, none).errors.telegram_bot_token).toBeTruthy();
  });

  it('cleans the provider address', () => {
    expect(normalizeBaseUrl('https://Ollama.com/')).toBe('https://ollama.com');
    expect(normalizeBaseUrl('ollama')).toBeNull();
    expect(normalizeBaseUrl('ftp://x.com')).toBeNull();
  });
});

describe('platform routes', () => {
  let app: FastifyInstance;
  let settings: Settings;
  let calls: { url: string; body?: string }[];
  let aiAnswer: number;

  const post = (url: string, fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

  beforeEach(async () => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    calls = [];
    aiAnswer = 200;
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, {
      encryptionKey: KEY,
      settings,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body as string | undefined });
        if (String(url).includes('/api/chat')) {
          return new Response(JSON.stringify({ message: { content: 'OK' } }), { status: aiAnswer });
        }
        if (String(url).includes('api.telegram.org')) return new Response('{"ok":true}', { status: 200 });
        return new Response('{}', { status: 503 });
      }) as unknown as typeof fetch,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  it('blocks websites and keywords until the platform is set up', async () => {
    const add = await app.inject({ method: 'GET', url: '/new-website/add' });
    expect(add.statusCode).toBe(303);
    expect(add.headers.location).toMatch(/^\/new-website\/platform\?error=/);
    const keywords = await app.inject({ method: 'GET', url: '/new-website/keywords' });
    expect(keywords.statusCode).toBe(303);
    const list = await app.inject({ method: 'GET', url: '/new-website' });
    expect(list.body).toContain('Set up the platform first');
  });

  it('tests a new AI key with a real request before accepting the step', async () => {
    const ok = (await post('/new-website/platform/check', { ...FORM, step: '0' })).json();
    expect(ok.errors).toEqual({});
    expect(calls.map((c) => c.url)).toEqual(['https://ollama.com/api/chat']);

    aiAnswer = 401;
    const bad = (await post('/new-website/platform/check', { ...FORM, step: '0' })).json();
    expect(bad.errors.newKeyValue).toMatch(/rejected this key/);
  });

  it('saves everything, adds the key, and unlocks websites', async () => {
    const r = (await post('/new-website/platform/save', { ...FORM, auto_retry_max: '3', timezone: 'Europe/Paris' })).json();
    expect(r.saved).toBe(true);
    expect(settings.get('auto_retry_max')).toBe('3');
    expect(settings.get('timezone')).toBe('Europe/Paris');
    expect(settings.get(SETUP_DONE_KEY)).toBe('true');
    expect(listEndpointRows().map((e) => e.name)).toEqual(['Main key']);

    const add = await app.inject({ method: 'GET', url: '/new-website/add' });
    expect(add.statusCode).toBe(200);
  });

  it('does not save, and points at the step, when something is wrong', async () => {
    const r = (await post('/new-website/platform/save', { ...FORM, auto_retry_max: '99' })).json();
    expect(r.step).toBe(2);
    expect(settings.get(SETUP_DONE_KEY)).not.toBe('true');
    expect(listEndpointRows()).toEqual([]);
  });

  it('tests every pasted key, then saves them all', async () => {
    const r = (await post('/new-website/platform/save', { ...FORM, bulkKeys: 'sk-aaaaaaaa1\nSpare = sk-bbbbbbbb2' })).json();
    expect(r.saved).toBe(true);
    expect(calls.filter((c) => c.url.includes('/api/chat'))).toHaveLength(3);
    expect(listEndpointRows().map((e) => e.name).sort()).toEqual(['Key 01', 'Main key', 'Spare']);
  });

  it('adds a key only once, whether pasted twice, typed and pasted, or already saved', async () => {
    const first = (await post('/new-website/platform/save', { ...FORM, newKeyValue: 'sk-aaaaaaaa1', bulkKeys: 'sk-aaaaaaaa1\nsk-bbbbbbbb2\nsk-bbbbbbbb2' })).json();
    expect(first.saved).toBe(true);
    expect(listEndpointRows().map((e) => e.name).sort()).toEqual(['Key 01', 'Main key']);

    const typedAgain = (await post('/new-website/platform/check', { ...FORM, newKeyName: 'Other', newKeyValue: 'sk-bbbbbbbb2', step: '0' })).json();
    expect(typedAgain.errors.newKeyValue).toBe('This key is already saved as "Key 01".');

    calls = [];
    const pastedAgain = (await post('/new-website/platform/save', { ...FORM, newKeyName: '', newKeyValue: '', bulkKeys: 'sk-aaaaaaaa1\nsk-cccccccc3' })).json();
    expect(pastedAgain.saved).toBe(true);
    expect(pastedAgain.message).toMatch(/1 pasted key added\. 1 already saved, so skipped\./);
    expect(calls.filter((c) => c.url.includes('/api/chat'))).toHaveLength(1);
    expect(listEndpointRows()).toHaveLength(3);
  });

  it('adds the pasted keys that work and keeps a refused one off, in red', async () => {
    let n = 0;
    await app.close();
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, {
      encryptionKey: KEY,
      settings,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const bad = String(init?.headers && (init.headers as Record<string, string>).Authorization).endsWith('bbbbbbb2');
        n++;
        return new Response(JSON.stringify({ message: { content: 'OK' } }), { status: bad ? 401 : 200 });
      }) as unknown as typeof fetch,
    });
    await app.ready();
    const r = (await post('/new-website/platform/save', { ...FORM, bulkKeys: 'sk-aaaaaaaa1\nsk-bbbbbbbb2\nsk-cccccccc3' })).json();
    expect(r.saved).toBe(true);
    expect(r.message).toMatch(/2 pasted keys added\. 1 not accepted, shown in red: Key 02\./);
    expect(n).toBe(4);
    const rows = listEndpointRows();
    expect(rows.find((e) => e.name === 'Key 02')).toMatchObject({ enabled: 0, last_error: 'The AI provider rejected this key.' });
    expect(rows.filter((e) => e.enabled === 1).map((e) => e.name).sort()).toEqual(['Key 01', 'Key 03', 'Main key']);
    const page = await app.inject({ method: 'GET', url: '/new-website/platform/setup?section=0' });
    expect(page.body).toContain('Not accepted: The AI provider rejected this key.');
  });

  it('removes a saved key and keeps the Telegram token when the field is empty', async () => {
    upsertEndpoint({ name: 'Old', baseUrl: '', apiKey: 'oldkey12345', models: ['gpt-oss:120b'], enabled: true }, KEY);
    settings.set('telegram_bot_token', TG_TOKEN);
    const oldId = listEndpointRows()[0]!.id;
    const r = (await post('/new-website/platform/save', {
      ...FORM, removeKeys: String(oldId), telegram_enabled: 'true', telegram_chat_id: '-1001234567',
    })).json();
    expect(r.saved).toBe(true);
    expect(listEndpointRows().map((e) => e.name)).toEqual(['Main key']);
    expect(settings.get('telegram_bot_token')).toBe(TG_TOKEN);
  });

  it('sends a Telegram test with the saved token when none is typed', async () => {
    settings.set('telegram_bot_token', TG_TOKEN);
    const r = (await post('/new-website/platform/telegram-test', { telegram_chat_id: '-1001234567' })).json();
    expect(r).toEqual({ ok: true });
    expect(calls.at(-1)!.url).toContain(`/bot${TG_TOKEN}/sendMessage`);
  });

  it('remembers the https address the dashboard is opened at as its public address, never a local one', async () => {
    await app.inject({ method: 'GET', url: '/new-website/platform', headers: { host: 'localhost:8080' } });
    expect(settings.get('public_base_url')).toBe('');
    await app.inject({ method: 'GET', url: '/new-website/platform', headers: { host: 'dash.example.com', 'x-forwarded-proto': 'https' } });
    expect(settings.get('public_base_url')).toBe('https://dash.example.com');
    // A forwarded host header is never trusted.
    settings.set('public_base_url', '');
    await app.inject({ method: 'GET', url: '/new-website/platform', headers: { host: 'dash.example.com', 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https' } });
    expect(settings.get('public_base_url')).toBe('https://dash.example.com');
    // Set once, it is not changed by visits from another address.
    await app.inject({ method: 'GET', url: '/new-website/platform', headers: { host: 'other.example.com', 'x-forwarded-proto': 'https' } });
    expect(settings.get('public_base_url')).toBe('https://dash.example.com');
  });

  it('shows the platform page with the image service problem and no secrets', async () => {
    settings.set('telegram_bot_token', TG_TOKEN);
    const page = await app.inject({ method: 'GET', url: '/new-website/platform' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Image service');
    expect(page.body).not.toContain(TG_TOKEN);
    const wizard = await app.inject({ method: 'GET', url: '/new-website/platform/setup' });
    expect(wizard.body).toContain('Set up the platform');
    expect(wizard.body).not.toContain(TG_TOKEN);
  });

  it('once set up: each part has its own Change, the AI connection comes last, and a part opens alone', async () => {
    expect((await post('/new-website/platform/save', FORM)).json().saved).toBe(true);
    const page = await app.inject({ method: 'GET', url: '/new-website/platform' });
    expect(page.body).toContain('Platform settings');
    for (const n of [0, 1, 2, 3, 4]) expect(page.body).toContain(`/new-website/platform/setup?section=${n}`);
    expect(page.body.indexOf('<h2>AI connection</h2>')).toBeGreaterThan(page.body.indexOf('<b>Advanced</b>')); // at the bottom
    expect(page.body.indexOf('aria-label="Automation"')).toBeLessThan(page.body.indexOf('<b>Advanced</b>')); // the switch first
    expect(page.body.indexOf('<h2>Retries</h2>')).toBeGreaterThan(page.body.indexOf('<b>Advanced</b>')); // the timings tucked away
    expect(page.body).toContain('class="im-grid"'); // the image model cards live here now

    const one = await app.inject({ method: 'GET', url: '/new-website/platform/setup?section=3' });
    expect(one.body).toContain('Change: Images');
    expect(one.body).toContain('var SECTION = 3;');
    // Saving a single part sends the whole saved form, so the rest stays as it was.
    const r = (await post('/new-website/platform/save', { ...FORM, newKeyName: '', newKeyValue: '', image_gap_seconds: '40' })).json();
    expect(r.saved).toBe(true);
    expect(settings.get('image_gap_seconds')).toBe('40');
    expect(listEndpointRows().map((e) => e.name)).toEqual(['Main key']);
  });
});
