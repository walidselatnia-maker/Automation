import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { markRejected, upsertEndpoint } from '../src/llm/pool.js';
import { Settings } from '../src/settings.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import { createNewWebsite } from '../src/newsite/repo.js';
import { addSearchKeys } from '../src/newsite/search-keys.js';
import { PAGE_KEYS, keyHref, keyLine, keyLines, keyLinesFor, keyMissing, keyState } from '../src/newsite/key-status.js';

const KEY = randomBytes(32);

describe('Key status', () => {
  let settings: Settings;
  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
  });
  afterEach(() => closeDatabase());

  it('says a search key is missing, failing when every key failed, and set otherwise', () => {
    expect(keyState('search')).toBe('missing');
    addSearchKeys('serper-key-1111\nserper-key-2222', KEY);
    expect(keyState('search')).toBe('set');
    run(`UPDATE newsite_search_keys SET status = 'failed'`);
    expect(keyState('search')).toBe('failing');
    run(`UPDATE newsite_search_keys SET status = 'working' WHERE id = 2`);
    expect(keyState('search')).toBe('set');
  });

  it('says an AI key is missing until one is on, and failing when every one that is on errs', () => {
    expect(keyState('ai')).toBe('missing');
    upsertEndpoint({ name: 'Main', baseUrl: '', apiKey: 'sk-1', models: ['m'], enabled: true }, KEY);
    expect(keyState('ai')).toBe('set');
    run(`UPDATE llm_endpoints SET last_error = 'quota'`);
    expect(keyState('ai')).toBe('failing');
    markRejected('Main', 'refused');
    expect(keyState('ai')).toBe('missing');
  });

  it('says the Flow project is missing unless it is shared or every website has its own', () => {
    expect(keyState('flow')).toBeNull();
    settings.set('flow_project_id', '');
    expect(keyState('flow', settings)).toBe(settings.has('flow_project_id') ? 'set' : 'missing');
    settings.set('flow_project_id', 'https://labs.google/fx/tools/flow/project/abc-123');
    expect(keyState('flow', settings)).toBe('set');
    expect(keyLinesFor(['search', 'flow']).map((l) => l.id)).toEqual(['search']);
  });

  it('shows a missing key with a button to its part of Platform settings, and a set key as a link saying where it is', () => {
    expect(keyHref('search')).toBe('/new-website/platform#search-keys');
    expect(keyHref('ai')).toBe('/new-website/platform#ai');
    const missing = String(keyLine({ id: 'search', state: 'missing' }));
    expect(missing).toContain('Search key missing');
    expect(missing).toMatch(/<a class="ns-btn small primary" href="\/new-website\/platform#search-keys">Add key<\/a>/);
    expect(String(keyLine({ id: 'search', state: 'failing' }))).toContain('Search key failing');
    const set = String(keyLine({ id: 'search', state: 'set' }));
    expect(set).toBe('<a class="ns-key ok" href="/new-website/platform#search-keys">Search key: set · Platform settings &gt; Search keys</a>');
    expect(String(keyLines([]))).toBe('');
    expect(keyMissing([{ id: 'ai', state: 'set' }, { id: 'search', state: 'failing' }])).toEqual({ id: 'search', state: 'failing' });
    expect(keyMissing([{ id: 'ai', state: 'set' }])).toBeUndefined();
    expect(PAGE_KEYS.research).toEqual(['search', 'ai']);
  });
});

describe('Key lines on the pages', () => {
  let app: FastifyInstance;
  let settings: Settings;
  const get = async (url: string) => (await app.inject({ method: 'GET', url })).body;

  beforeEach(async () => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, {
      encryptionKey: KEY, settings, isPlatformReady: () => true, autoSeo: false, autoPictures: false,
      fetchImpl: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
      listPosts: async () => [],
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  it('shows what is missing on Content research, Keywords, Reels and the Dashboard, then where it is once set', async () => {
    createNewWebsite(
      {
        name: 'S', domain: 's.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '', persona: 'Storyteller', status: 'active',
        autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    const research = await get('/new-website/research');
    expect(research).toContain('Search key missing');
    expect(research).toContain('AI key missing');
    expect(research).toContain('href="/new-website/platform#search-keys">Add key</a>');
    expect(await get('/new-website/keywords')).toContain('AI key missing');
    expect(await get('/new-website/sharing/reels')).toContain('AI key missing');
    const dashboard = await get('/new-website/dashboard');
    expect(dashboard).toContain('Search key missing');
    expect(dashboard).toContain('AI key missing');

    addSearchKeys('serper-key-1111', KEY);
    upsertEndpoint({ name: 'Main', baseUrl: '', apiKey: 'sk-1', models: ['m'], enabled: true }, KEY);
    const after = await get('/new-website/research');
    expect(after).toContain('Search key: set · Platform settings &gt; Search keys');
    expect(after).toContain('AI key: set · Platform settings &gt; AI connection');
    expect(after).not.toContain('Add key');
  });

  it('keeps the search keys in Platform settings, each part with its own anchor', async () => {
    const page = await get('/new-website/platform');
    for (const id of ['search-keys', 'ai', 'images']) expect(page).toContain(`id="${id}"`);
    expect(page).toContain('action="/new-website/platform/search-keys"');
    const added = await app.inject({
      method: 'POST', url: '/new-website/platform/search-keys', payload: 'keys=serper-key-1111', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(String(added.headers.location)).toMatch(/^\/new-website\/platform\?ok=1%20key%20added\.#search-keys$/);
    expect(await get('/new-website/platform')).toContain('Not tried yet');
  });
});
