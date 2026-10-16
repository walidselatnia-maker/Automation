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
import { createReels, getReel, kickReels, listPlanReels, reelDir, reelRules, type ReelDeps } from '../src/newsite/reels.js';
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

  let asked: { name: string; vars: Record<string, unknown> }[];
  /** A script that meets the rules it was given: every time mark, the hook and the closing line. */
  const goodScript = (rules: string, hook = 'This cake needs no oven, watch this'): string => {
    const closing = /closing line, word for word: "([^"]+)"/i.exec(rules)![1]!;
    const marks = rules.match(/^- (\d+-\d+s):/gm)!.map((m) => m.slice(2, -1));
    const shots = marks.map((m, i) =>
      `${m}: ${i === 0 ? `The finished strawberry cake in full, a hand cuts the first slice. A warm voice says "${hook}".` : i === marks.length - 1 ? `The slice lifted toward the lens. The voice says "${closing}".` : 'Real hands do the next step of the recipe at natural speed, phone camera, close and handheld, warm kitchen light from the left.'}`,
    );
    return JSON.stringify({ hook_line: hook, closing_line: closing, prompt: `A 10-second vertical reel of a strawberry cake.\n${shots.join('\n')}\nReal cooking sound, no music, no on-screen text.` });
  };
  const deps = (): ReelDeps => ({
    settings,
    encryptionKey: KEY,
    dataDir,
    ask: async (name, vars) => {
      asked.push({ name, vars });
      return goodScript(String(vars.reelRules));
    },
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
    asked = [];
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
    // The AI wrote each prompt from the article, by that platform's reel rules.
    const writes = asked.filter((a) => a.name === 'newsite-reel-prompt');
    expect(writes.map((w) => w.vars.label).sort()).toEqual(['Facebook', 'Pinterest']);
    expect(String(writes[0]!.vars.reelRules)).toContain('0-2s: THE HOOK');
    expect(String(writes[0]!.vars.references)).toMatch(/^1\. The finished result/);
    const prompts = submitted.map((x) => x.prompt).join(' | ');
    expect(prompts).toContain('"Full recipe in the comments."');
    expect(prompts).toContain('"Save this for later."');
    expect(reels.find((r) => r.platform === 'facebook')!.hook).toBe('This cake needs no oven, watch this');
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

  it('sends a weak script back with what to fix, before anything is spent on Flow', async () => {
    setWebsiteChannels(websiteId, [channel('instagram', 'i1')]);
    createReels(seoId);
    let round = 0;
    await kickReels({
      ...deps(),
      ask: async (name, vars) => {
        asked.push({ name, vars });
        round += 1;
        // First a hook far too long and no closing line, then right.
        return round === 1
          ? JSON.stringify({ hook_line: 'Hi guys, today I am going to show you my favourite strawberry cake', closing_line: '', prompt: 'A cake.' })
          : goodScript(String(vars.reelRules), 'No oven. Three ingredients. Watch.');
      },
    });
    const problems = String(asked[1]!.vars.problemsJson);
    expect(problems).toMatch(/hook_line has 13 words; at most 7/);
    expect(problems).toMatch(/closing_line must be exactly: "Save this and follow for more."/);
    expect(problems).toMatch(/missing: 0-2s, 2-4s, 4-6s, 6-8s, 8-10s/);
    expect(submitted).toHaveLength(1);
    expect(listPlanReels(planId)[0]).toMatchObject({ status: 'done', hook: 'No oven. Three ingredients. Watch.' });
  });

  it('lets the reel rules be changed on the dashboard, checked, and put back to the defaults', async () => {
    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, { settings, encryptionKey: KEY, dataDir, ask: async () => '{}', readFlash: () => null, autoStart: false });
    const form = (body: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/new-website/sharing/reel-rules/facebook', payload: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const page = await app.inject({ url: '/new-website/sharing/reel-rules/facebook' });
    expect(page.body).toContain('Facebook reel rules');
    expect(page.body).toContain('0-2s: THE HOOK');
    expect((await form({ text: 'Just make it nice.' })).body).toContain('Keep at least one time mark line');
    const own = '- 0-2s: the finished craft project in full.\n- 2-10s: the steps.\nThe hook line: at most 6 words. The closing line, word for word: "Save it."';
    expect((await form({ text: own, back: '/new-website/sharing/site/1' })).headers.location).toMatch(/^\/new-website\/sharing\/site\/1\?ok=Facebook%20reel%20rules%20saved/);
    expect(reelRules('facebook', settings)).toBe(own);
    await form({ text: own, reset: '1' });
    expect(reelRules('facebook', settings)).toContain('Full recipe in the comments.');
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
