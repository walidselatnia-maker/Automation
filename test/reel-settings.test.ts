import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel,
  getReel,
  insertFbToken,
  insertKeyword,
  listFbPages,
  listScenes,
  replaceScenes,
  setReelStage,
  updateReel,
  updateScene,
  upsertFbPage,
  upsertSite,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Setup → Reels shapes every reel; the reel page shows its storyboard and
 * lets one failed scene be filmed again without touching the others.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

describe('reel settings and the storyboard', () => {
  let app: FastifyInstance;
  let cookie: string;
  let settings: Settings;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    settings = new Settings(KEY);
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
    await app.close();
    closeDatabase();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, fields: Record<string, string | string[]>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      for (const one of Array.isArray(value) ? value : [value]) params.append(key, one);
    }
    return app.inject({
      method: 'POST',
      url,
      payload: params.toString(),
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });
  };

  const seedReel = () => {
    const siteId = upsertSite(
      { name: 'a', domain: 'a.com', status: 'active', pin_username: '', project_id: '',
        daily_target: 1, interval_minutes: 60 },
      KEY,
    );
    const keywordId = insertKeyword({ seed_keyword: 'soup' });
    const pageId = upsertFbPage({ pageId: '1', name: 'Page', tokenId: insertFbToken('App', 'tok', KEY) });
    const reelId = createReel({ runId: null, siteId, keywordId, fbPageId: pageId, prompt: '',
      caption: 'c', references: [], stage: 'filming' });
    setReelStage(reelId, 'filming', { format: 'reveal' });
    replaceScenes(reelId, [
      { seconds: 10, presenter: false, sources: ['feature'], imagePrompt: '', motionPrompt: 'a pour', line: 'hi' },
      { seconds: 10, presenter: false, sources: ['pin'], imagePrompt: '', motionPrompt: 'steam', line: '' },
    ]);
    const [first, second] = listScenes(reelId);
    updateScene(first!.id, { status: 'failed', error: 'no credits' });
    updateScene(second!.id, { status: 'done', clipPath: '/tmp/none.mp4' });
    return { reelId, failedSceneId: first!.id };
  };

  it('shows the reel style page under Setup, with every shape on by default', async () => {
    const body = (await get('/settings/reels')).body;
    expect(body).toMatch(/name="reel_mode" value="single"\s+checked/);
    expect(body).toContain('name="reel_length_seconds"');
    expect((body.match(/name="reel_formats" value="[a-z-]+"\s+checked/g) ?? []).length).toBe(13);
  });

  it('saves the shapes that are ticked, and refuses none', async () => {
    await post('/settings/reels', {
      reel_mode: 'scenes', reel_single_references: ['feature', 'topShot'],
      reel_length_seconds: '45', reel_formats: ['reveal', 'myth'], reel_cta_text: 'Recipe below',
    });
    expect(settings.get('reel_mode')).toBe('scenes');
    expect(JSON.parse(settings.get('reel_single_references'))).toEqual(['feature', 'topShot']);
    expect(JSON.parse(settings.get('reel_formats'))).toEqual(['reveal', 'myth']);
    expect(settings.getNumber('reel_length_seconds')).toBe(45);
    expect(settings.get('reel_cta_text')).toBe('Recipe below');

    const refused = await post('/settings/reels', {
      reel_mode: 'scenes', reel_single_references: 'feature', reel_length_seconds: '45', reel_cta_text: 'x',
    });
    expect(String(refused.headers.location)).toMatch(/error=/);

    const tooMany = await post('/settings/reels', {
      reel_mode: 'single', reel_single_references: ['feature', 'topShot', 'textureMacro', 'beforeAfter'],
      reel_length_seconds: '30', reel_formats: ['reveal'], reel_cta_text: 'x',
    });
    expect(decodeURIComponent(String(tooMany.headers.location))).toMatch(/at most 3/);
  });

  it('renders the storyboard: one card per scene with its state and a retry on the failed one', async () => {
    const { reelId } = seedReel();
    const body = (await get(`/reels/${reelId}`)).body;
    expect(body).toContain('Scene 1');
    expect(body).toContain('Scene 2');
    expect(body).toContain('no credits');
    expect(body).toContain('Retry this scene');
    expect(body).toContain('Reveal');
  });

  it('offers Publish on the reel page once it is ready', async () => {
    const { reelId } = seedReel();
    setReelStage(reelId, 'done', { outputPath: '/tmp/none.mp4' });
    updateReel(reelId, { status: 'ready' });
    const body = (await get(`/reels/${reelId}`)).body;
    expect(body).toContain(`action="/reels/${reelId}/publish"`);
  });

  it('lets a ready reel with no page be published to a page picked on the spot', async () => {
    const { reelId } = seedReel();
    updateReel(reelId, { status: 'ready', fbPageId: null });
    setReelStage(reelId, 'done', { outputPath: '/tmp/none.mp4' });

    const body = (await get('/reels')).body;
    expect(body).toContain('name="page_id"');
    expect(body).toContain('>Page</option>');

    expect(getReel(reelId)!.fb_page_id).toBeNull();
    // The publish itself reaches for Facebook and fails here; what matters is
    // the page was remembered on the reel.
    await post(`/reels/${reelId}/publish`, { page_id: String(listFbPages()[0]!.id) });
    expect(getReel(reelId)!.fb_page_id).toBe(listFbPages()[0]!.id);
  });

  it('retries one scene without touching the others', async () => {
    const { reelId, failedSceneId } = seedReel();
    const response = await post(`/reels/${reelId}/scenes/${failedSceneId}/retry`, {});
    expect(response.statusCode).toBe(303);
    expect(listScenes(reelId).map((s) => s.status)).toEqual(['pending', 'done']);
    expect(getReel(reelId)).toMatchObject({ status: 'generating', stage: 'filming' });
  });

  it('retries a failed studio reel at the stage it was in, not as a one-shot video', async () => {
    const { reelId } = seedReel();
    updateReel(reelId, { status: 'failed', error: 'no credits' });

    const response = await post(`/reels/${reelId}/retry`, {});
    expect(response.statusCode).toBe(303);
    expect(String(response.headers.location)).not.toMatch(/error=/);
    expect(getReel(reelId)).toMatchObject({ status: 'generating', stage: 'filming', error: null });
    expect(listScenes(reelId).map((s) => s.status)).toEqual(['pending', 'done']);
  });

  it('lists Reels and Presenters as Setup tabs', async () => {
    const body = (await get('/settings')).body;
    expect(body).toContain('href="/settings/reels"');
    expect(body).toContain('href="/settings/presenters"');
  });
});
