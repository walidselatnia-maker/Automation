import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { setModelOverride } from '../src/db/repos.js';
import { GEMINI_LAST_ERROR, GEMINI_LAST_OK, GEMINI_MODEL } from '../src/llm/gemini.js';
import { invalidatePromptCache, modelFor } from '../src/pipeline/prompts.js';
import { addGoogleAccount } from '../src/newsite/google-accounts.js';
import {
  GEMINI_STAGES,
  geminiAccount,
  geminiSection,
  geminiStages,
  geminiState,
  registerGeminiRoutes,
  setGeminiStages,
} from '../src/newsite/gemini.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
const BASE = 'http://imagegen.test:8100';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Gemini on Platform settings', () => {
  let settings: Settings;
  let calls: { path: string; body?: Record<string, unknown> }[];
  let job: Record<string, unknown>;
  let serviceUp: boolean;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(BASE, '');
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!serviceUp) throw new Error('fetch failed');
    if (path === '/v1/gemini/jobs') return json({ id: 'job-9', status: 'queued', result: null, error: null }, 202);
    if (path === '/v1/gemini/jobs/job-9') return json(job);
    if (path === '/v1/gemini/status') return json({ extension_connected: false, queued: 0, running: 0, last_success_at: null, last_error: null });
    return json({}, 200); // the rest of Platform settings' own checks
  }) as unknown as typeof fetch;

  const app = async (): Promise<FastifyInstance> => {
    const a = Fastify();
    await a.register(formbody);
    registerGeminiRoutes(a, { settings, fetchImpl });
    return a;
  };

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    run('DELETE FROM google_accounts');
    invalidatePromptCache();
    settings = new Settings(KEY);
    settings.set('image_base_url', BASE);
    process.env.IMAGE_API_KEY = 'test-key';
    calls = [];
    serviceUp = true;
    job = { id: 'job-9', status: 'running', result: null, error: null };
  });

  afterEach(() => {
    delete process.env.IMAGE_API_KEY;
    invalidatePromptCache();
    closeDatabase();
  });

  it('offers the Prompts page stages, without the picture templates', () => {
    expect(GEMINI_STAGES.map((s) => s.title)).toEqual(['Keywords', 'SEO', 'Article', 'Pictures', 'Publishing', 'Social posts', 'Reels']);
    expect(GEMINI_STAGES.flatMap((s) => s.prompts)).not.toContain('newsite-fb-1.template');
    expect(GEMINI_STAGES.find((s) => s.title === 'Social posts')!.prompts).toEqual(['newsite-social-post', 'newsite-pick-board']);
  });

  it('is off for every step until one is ticked, so nothing changes on its own', () => {
    expect(geminiStages()).toEqual([]);
    expect(modelFor('newsite-social-post')).toBe('gpt-oss:120b');
  });

  it('switches whole steps to Gemini and back, leaving other model choices alone', () => {
    setModelOverride('seo-metadata', 'gemma4:31b');
    invalidatePromptCache();
    setGeminiStages(['Social posts', 'Reels']);
    expect(geminiStages()).toEqual(['Social posts', 'Reels']);
    expect(modelFor('newsite-pick-board')).toBe(GEMINI_MODEL);
    expect(modelFor('newsite-reel-story')).toBe(GEMINI_MODEL);
    expect(modelFor('seo-metadata')).toBe('gemma4:31b');

    setGeminiStages(['Reels']);
    expect(geminiStages()).toEqual(['Reels']);
    expect(modelFor('newsite-social-post')).toBe('gpt-oss:120b');
    expect(modelFor('seo-metadata')).toBe('gemma4:31b');
  });

  it('saves the ticked steps from the form and ignores made-up ones', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/new-website/gemini/steps', payload: 'stage=SEO&stage=Nonsense', headers: FORM });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/new-website\/platform\?ok=.*#gemini$/);
    expect(geminiStages()).toEqual(['SEO']);
    const off = await (await app()).inject({ method: 'POST', url: '/new-website/gemini/steps', payload: '', headers: FORM });
    expect(decodeURIComponent(off.headers.location as string)).toMatch(/AI keys write every step/);
    expect(geminiStages()).toEqual([]);
  });

  it("asks as the browser's own account, or as the first listed one when there are several", () => {
    expect(geminiAccount()).toBe('');
    addGoogleAccount('one@gmail.com', '');
    expect(geminiAccount()).toBe('');
    addGoogleAccount('two@gmail.com', '');
    expect(geminiAccount()).toBe('one@gmail.com');
  });

  it('says plainly how Gemini is doing', async () => {
    expect((await geminiState(settings, fetchImpl)).label).toBe('Not tried yet');

    settings.set(GEMINI_LAST_OK, '2026-11-02T08:00:00.000Z');
    expect(await geminiState(settings, fetchImpl)).toMatchObject({ kind: 'ok', label: 'Working' });

    settings.set(GEMINI_LAST_ERROR, '2026-11-02T09:00:00.000Z NOT_SIGNED_IN: no account');
    const out = await geminiState(settings, fetchImpl);
    expect(out).toMatchObject({ kind: 'bad', label: 'Sign-in needed' });
    expect(out.detail).toMatch(/Browser page/);

    serviceUp = false;
    expect(await geminiState(settings, fetchImpl)).toMatchObject({ kind: 'bad', label: 'Not answering' });

    delete process.env.IMAGE_API_KEY;
    expect(await geminiState(settings, fetchImpl)).toMatchObject({ kind: 'bad', label: 'Not available' });
  });

  it('draws the steps as ticks and a box to try it', () => {
    const out = geminiSection({ kind: 'idle', label: 'Not tried yet', detail: 'Send a test message below.' }, ['SEO'], 'one@gmail.com').value;
    expect(out).toContain('id="gemini"');
    expect(out).toMatch(/name="stage" value="SEO" checked/);
    expect(out).toMatch(/name="stage" value="Reels" >/);
    expect(out).toContain('action="/new-website/gemini/steps"');
    expect(out).toContain('id="gm-form"');
    expect(out).toContain('one@gmail.com');
  });

  it('sends a test message and hands back the reply, pictures as data only', async () => {
    addGoogleAccount('one@gmail.com', '');
    addGoogleAccount('two@gmail.com', '');
    const a = await app();
    const sent = await a.inject({ method: 'POST', url: '/new-website/gemini/ask', payload: { prompt: 'Hi', files: [{ name: 'a.png', mime: 'image/png', base64: 'AAAA' }, { bad: 1 }] } });
    expect(sent.json()).toEqual({ id: 'job-9' });
    expect(calls.find((c) => c.path === '/v1/gemini/jobs')!.body).toMatchObject({
      prompt: 'Hi', account: 'one@gmail.com', temporary: true, images: true, files: [{ name: 'a.png', mime: 'image/png', base64: 'AAAA' }],
    });

    expect((await a.inject({ url: '/new-website/gemini/ask/job-9' })).json()).toEqual({ status: 'running' });

    job = {
      id: 'job-9', status: 'done', error: null,
      result: { conversation_id: null, text: 'Hello', markdown: 'Hello', code_blocks: [{ language: 'python', code: 'print(1)' }], links: [], images: [{ url: 'blob:x', alt: 'cake', mime: 'image/png', data_base64: 'iVBO' }, { url: 'blob:y', alt: 'no data' }] },
    };
    const done = (await a.inject({ url: '/new-website/gemini/ask/job-9' })).json();
    expect(done).toEqual({ status: 'done', reply: { text: 'Hello', markdown: 'Hello', code_blocks: [{ language: 'python', code: 'print(1)' }], images: [{ alt: 'cake', mime: 'image/png', data_base64: 'iVBO' }] } });
    expect(settings.get(GEMINI_LAST_OK)).not.toBe('');
  });

  it('explains a failure in plain words and remembers it', async () => {
    job = { id: 'job-9', status: 'failed', result: null, error: 'NOT_SIGNED_IN: Gemini is open but no Google account is signed in.' };
    const out = (await (await app()).inject({ url: '/new-website/gemini/ask/job-9' })).json();
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/Open the Browser page/);
    expect(settings.get(GEMINI_LAST_ERROR)).toMatch(/NOT_SIGNED_IN/);
  });

  it('refuses an empty message and says when the image service is down', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/new-website/gemini/ask', payload: { prompt: ' ' } })).statusCode).toBe(400);
    serviceUp = false;
    const down = await a.inject({ method: 'POST', url: '/new-website/gemini/ask', payload: { prompt: 'Hi' } });
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toMatch(/image service/);
  });

  it('sits on the Platform settings page', async () => {
    const a = Fastify();
    await a.register(formbody);
    registerNewWebsiteRoutes(a, { encryptionKey: KEY, settings, fetchImpl, autoSeo: false, autoPictures: false });
    const page = await a.inject({ url: '/new-website/platform' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="gemini"');
    expect(page.body).toContain('Choose which steps Gemini writes');
    vi.restoreAllMocks();
  });
});
