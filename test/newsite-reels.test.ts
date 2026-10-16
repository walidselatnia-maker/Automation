import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { saveBufferChannel, setWebsiteChannels } from '../src/newsite/channels.js';
import { createReels, getReel, kickReels, listPlanReels, reelDir, type ReelDeps } from '../src/newsite/reels.js';
import { registerSocialRoutes } from '../src/newsite/social-routes.js';

const KEY = randomBytes(32);
const PROMPTS = resolve('./prompts');

describe('reels: one Flow video per article and platform, from one prompt', () => {
  let settings: Settings;
  let dataDir: string;
  let seoId: number;
  let planId: number;
  let websiteId: number;
  let submitted: { prompt: string; referenceUrls: string[] }[];
  let jobStatus: string;

  const deps = (): ReelDeps => ({
    settings,
    encryptionKey: KEY,
    dataDir,
    sleep: async () => {},
    download: async () => Buffer.from('mp4'),
    flow: {
      submitVideo: async (input) => {
        submitted.push(input);
        return `job-${submitted.length}`;
      },
      poll: async () => (jobStatus === 'COMPLETED' ? { status: 'COMPLETED', image_url: 'https://flow/v.mp4' } : { status: jobStatus, error: 'policy' }),
    },
  });
  const channel = (platform: string, id: string) =>
    saveBufferChannel(
      { platform, name: `longlivo ${platform}`, bufferToken: 'tok', bufferChannelId: id, paidBuffer: false, postImage: true, postReel: true, multiWebsite: false },
      KEY,
    );

  beforeEach(() => {
    configurePrompts(PROMPTS);
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('public_base_url', 'https://dash.example.com');
    websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    planId = saveKeywordPlan(websiteId, 'strawberry cake', [], 'recipe');
    queuePlanSeo(planId, 'strawberry cake', [], 'recipe');
    seoId = listPlanSeo(planId)[0]!.id;
    run(`UPDATE keyword_seo SET status = 'done', title = 'Strawberry Cake', post_status = 'published', post_url = 'https://f.longlivo.com/x' WHERE id = ?`, seoId);
    for (const slot of ['feature', 'closeup']) {
      run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, file) VALUES (?, ?, 1, 'p', 'a', 'done', ?)`, seoId, slot, `${slot}.png`);
    }
    dataDir = mkdtempSync(join(tmpdir(), 'reels-'));
    submitted = [];
    jobStatus = 'COMPLETED';
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('makes one reel per platform the website shares on, each from its own prompt and the article pictures', async () => {
    setWebsiteChannels(websiteId, [channel('pinterest', 'p1'), channel('facebook', 'f1'), channel('threads', 't1')]);
    expect(createReels(seoId)).toBe(2); // threads gets no reel
    expect(createReels(seoId)).toBe(0); // never twice
    await kickReels(deps());
    const reels = listPlanReels(planId);
    expect(reels.map((r) => [r.platform, r.status])).toEqual([['facebook', 'done'], ['pinterest', 'done']]);
    expect(submitted).toHaveLength(2);
    const prompts = submitted.map((x) => x.prompt).join(' | ');
    expect(prompts).toContain('Facebook Reel about: Strawberry Cake');
    expect(prompts).toContain('Full recipe in the comments.');
    expect(prompts).toContain('Pinterest video pin about: Strawberry Cake');
    expect(submitted[0]!.referenceUrls).toHaveLength(2);
    expect(submitted[0]!.referenceUrls[0]).toMatch(/^https:\/\/dash\.example\.com\/media\/picture\//);
    expect(existsSync(join(reelDir(dataDir), reels[0]!.file))).toBe(true);
  });

  it('says why when Flow refuses, and Make again starts it over', async () => {
    setWebsiteChannels(websiteId, [channel('instagram', 'i1')]);
    createReels(seoId);
    jobStatus = 'FAILED';
    await kickReels(deps());
    const [reel] = listPlanReels(planId);
    expect(reel).toMatchObject({ platform: 'instagram', status: 'failed' });
    expect(reel!.error).toMatch(/Flow could not make the video: policy/);

    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, { settings, encryptionKey: KEY, dataDir, ask: async () => '{}', readFlash: () => null, autoStart: false });
    const ch = (await import('../src/newsite/channels.js')).websiteChannels(websiteId)[0]!;
    const page = await app.inject({ url: `/new-website/sharing/site/${websiteId}/channel/${ch.id}?tab=reels` });
    expect(page.body).toContain('Reels <span class="n">1</span>');
    expect(page.body).toContain('Try again');
    expect((await app.inject({ method: 'POST', url: `/new-website/reels/${reel!.id}/remake` })).headers.location).toMatch(/Making%20the%20reel%20again/);
    expect(getReel(reel!.id)!.status).not.toBe('failed');
    await kickReels(deps()); // the route started the real maker: let it finish before the next test
  });

  it('needs the public address so Flow can fetch the pictures', async () => {
    settings.set('public_base_url', ' ');
    setWebsiteChannels(websiteId, [channel('facebook', 'f1')]);
    createReels(seoId);
    await kickReels(deps());
    expect(listPlanReels(planId)[0]!.error).toMatch(/no public address/);
    expect(submitted).toHaveLength(0);
  });
});
