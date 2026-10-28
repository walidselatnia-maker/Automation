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
import { articleText, checkReelScript, createReels, getReel, kickReels, listPlanReels, onReelMade, reelDir, reelRules, withDomain, type ReelDeps } from '../src/newsite/reels.js';
import { registerSocialRoutes } from '../src/newsite/social-routes.js';

const KEY = randomBytes(32);
const PROMPTS = resolve('./prompts');

describe('reels: one Flow video per article, from one prompt', () => {
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
    // Every shot as full as the rules ask: its layers, camera, light, mood, action at fast real-life speed, and sound.
    const look =
      ' Foreground: a blurred linen napkin edge; midground: the cake on a white plate, sharp; background: a sunny kitchen counter. 50mm lens, eye level, close-up, shallow depth of field. Soft window light from the left, warm and golden, gentle shadows on the right. Bright, cosy mood. Every hand moves at fast real-life speed with quick, snappy motion. Sound: a knife on the plate.';
    const shots = marks.map((m, i) =>
      `${m}: ${i === 0 ? `The finished strawberry cake in full, a hand cuts the first slice. A warm voice says "${hook}".` : i === marks.length - 1 ? `The slice lifted toward the lens. The voice says "${closing}".` : 'Real hands do the next step of the recipe, phone camera, close and handheld.'}${look}`,
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
    onReelMade(null);
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('makes ONE reel per article, whatever platforms it goes to, from one prompt and the article pictures', async () => {
    setWebsiteChannels(websiteId, [channel('pinterest', 'p1'), channel('facebook', 'f1'), channel('threads', 't1')]);
    expect(createReels(seoId)).toBe(1);
    expect(createReels(seoId)).toBe(0); // never twice
    await kickReels(deps());
    const reels = listPlanReels(planId);
    expect(reels.map((r) => [r.platform, r.status])).toEqual([['all', 'done']]);
    expect(submitted).toHaveLength(1);
    // The AI wrote the prompt from the article, by the one set of reel rules, knowing where it goes.
    const writes = asked.filter((a) => a.name === 'newsite-reel-prompt');
    expect(writes.map((w) => w.vars.label)).toEqual(['Facebook, Threads and Pinterest']);
    expect(String(writes[0]!.vars.reelRules)).toContain('0-2s: THE HOOK');
    expect(String(writes[0]!.vars.references)).toMatch(/^1\. The finished result/);
    expect(submitted[0]!.prompt).toContain('"Full guide on f.longlivo.com."');
    expect(reels[0]!.hook).toBe('This cake needs no oven, watch this');
    expect(submitted[0]!.referenceUrls).toHaveLength(2);
    expect(submitted[0]!.referenceUrls[0]).toMatch(/^https:\/\/dash\.example\.com\/media\/picture\//);
    expect(existsSync(join(reelDir(dataDir), reels[0]!.file))).toBe(true);
  });

  it('makes no reel by itself for a website with no channel that takes reels, but the Reels page can', () => {
    setWebsiteChannels(websiteId, [channel('linkedin', 'l1')]);
    expect(createReels(seoId)).toBe(0);
    expect(createReels(seoId, true)).toBe(1);
  });

  it('says why when Flow refuses, and Make again starts it over, on the Reels page', async () => {
    setWebsiteChannels(websiteId, [channel('facebook', 'f1')]);
    createReels(seoId);
    jobStatus = 'FAILED';
    await kickReels(deps());
    const [reel] = listPlanReels(planId);
    expect(reel).toMatchObject({ status: 'failed' });
    expect(reel!.error).toMatch(/Flow could not make the video: policy/);

    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, { settings, encryptionKey: KEY, dataDir, ask: async () => '{}', readFlash: () => null, autoStart: false });
    const page = await app.inject({ url: '/new-website/sharing/reels' });
    expect(page.body).toContain(`id="reel-${reel!.id}"`);
    expect(page.body).toContain('Flow could not make the video');
    expect(page.body).toContain('Try again');
    expect((await app.inject({ method: 'POST', url: `/new-website/reels/${reel!.id}/remake` })).headers.location).toMatch(/Making%20the%20reel%20again/);
    expect(getReel(reel!.id)!.status).not.toBe('failed');
    await kickReels(deps()); // the route started the real maker: let it finish before the next test
  });

  it('sends a weak script back with what to fix, before anything is spent on Flow', async () => {
    setWebsiteChannels(websiteId, [channel('facebook', 'f1')]);
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
    expect(problems).toMatch(/hook_line has 13 words; at most 9/);
    expect(problems).toMatch(/closing_line must be exactly: "Full guide on f\.longlivo\.com\."/);
    expect(problems).toMatch(/missing: 0-2s, 2-4s, 4-6s, 6-8s, 8-10s/);
    expect(submitted).toHaveLength(1);
    expect(listPlanReels(planId)[0]).toMatchObject({ status: 'done', hook: 'No oven. Three ingredients. Watch.' });
  });

  it('lets the one set of reel rules be changed on the dashboard, checked, and put back to the defaults', async () => {
    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, { settings, encryptionKey: KEY, dataDir, ask: async () => '{}', readFlash: () => null, autoStart: false });
    const form = (body: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/new-website/sharing/reel-rules', payload: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await app.inject({ url: '/new-website/sharing/reel-rules/facebook' })).headers.location).toBe('/new-website/sharing/reel-rules');
    const page = await app.inject({ url: '/new-website/sharing/reel-rules' });
    expect(page.body).toContain('Reel rules');
    expect(page.body).toContain('0-2s: THE HOOK');
    expect((await form({ text: 'Just make it nice.' })).body).toContain('Keep at least one time mark line');
    const own = '- 0-2s: the finished craft project in full.\n- 2-10s: the steps.\nThe hook line: at most 6 words. The closing line, word for word: "Save it."';
    expect((await form({ text: own, back: '/new-website/sharing/reels' })).headers.location).toMatch(/^\/new-website\/sharing\/reels\?ok=Reel%20rules%20saved/);
    expect(reelRules(settings)).toBe(own);
    await form({ text: own, reset: '1' });
    expect(reelRules(settings)).toContain('Full guide on {domain}.');
  });

  it('fills in {domain} in the reel rules with the website’s address, and lets the reel name it in its call to action', async () => {
    settings.set('newsite_reel_rules', [
      '- 0-3s: the finished cake in full.',
      '- 3-10s: the steps, and the call to action.',
      'The hook line: at most 9 words. The closing line, word for word: "Full guide on {domain}."',
    ].join('\n'));
    setWebsiteChannels(websiteId, [channel('facebook', 'f1')]);
    createReels(seoId);
    await kickReels(deps());
    const write = asked.find((a) => a.name === 'newsite-reel-prompt')!;
    expect(String(write.vars.reelRules)).toContain('"Full guide on f.longlivo.com."');
    expect(String(write.vars.reelRules)).not.toContain('{domain}');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.prompt).toContain('"Full guide on f.longlivo.com."');
    expect(listPlanReels(planId)[0]).toMatchObject({ status: 'done', closing: 'Full guide on f.longlivo.com.' });
  });

  it('default reel rules are an exact timeline in seconds, from 0 to 10, ending on a call to action naming the website', () => {
    const rules = reelRules(settings);
    const marks = [...rules.matchAll(/^- (\d+)-(\d+)s:/gm)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(marks[0]![0]).toBe(0);
    expect(marks.at(-1)![1]).toBe(10);
    marks.slice(1).forEach(([from], i) => expect(from).toBe(marks[i]![1])); // no gap, no overlap
    expect(rules).toMatch(/^- 8-10s: THE CALL TO ACTION/m);
    expect(rules).toContain('The closing line, word for word: "Full guide on {domain}."');
  });

  it('keeps reel rules saved on the dashboard over the default file', () => {
    settings.set('newsite_reel_rules', '- 0-10s: mine.\nThe hook line: at most 5 words.');
    expect(reelRules(settings)).toBe('- 0-10s: mine.\nThe hook line: at most 5 words.');
  });

  it('allows the website’s own address in a reel prompt, and no other web address', () => {
    expect(withDomain('Visit {domain} or {domain}', 'g.example.com')).toBe('Visit g.example.com or g.example.com');
    const rules = '- 0-10s: all.\nThe hook line: at most 9 words.';
    const script = (end: string) => ({ hook_line: 'No oven needed', closing_line: '', prompt: `0-10s: "No oven needed". ${'Real hands at work, close and handheld. '.repeat(12)}${end}` });
    expect(checkReelScript(script('More on g.example.com.'), rules, 'g.example.com')).toEqual([]);
    expect(checkReelScript(script('More on other.com.'), rules, 'g.example.com')).toContain('The prompt must have no link or web address.');
  });

  it('sends back a thin shot, and a shot that does not say its fast real-life speed when the rules ask for it', () => {
    const rules = '- 0-2s: hook.\n- 2-4s: next.\nMove at fast real-life speed.\nThe hook line: at most 9 words.';
    const full = 'Foreground, midground and background, 35mm lens, low angle, close-up, shallow depth of field, window light from the left, warm and soft, cheerful mood. '.repeat(2);
    const prompt = (second: string) => `0-2s: "Watch this dog fly". ${full}The dog runs at fast real-life speed.\n2-4s: ${second}`;
    expect(checkReelScript({ hook_line: 'Watch this dog fly', closing_line: '', prompt: prompt(`${full}Paws move at fast real-life speed. Never slow motion.`) }, rules)).toEqual([]);
    expect(checkReelScript({ hook_line: 'Watch this dog fly', closing_line: '', prompt: prompt('A dog sits.') }, rules).join(' ')).toMatch(/too thin: 2-4s/);
    expect(checkReelScript({ hook_line: 'Watch this dog fly', closing_line: '', prompt: prompt(`${full}The dog runs.`) }, rules).join(' ')).toMatch(/missing in: 2-4s/);
  });

  it('gives the prompt writer the article’s own words, without pictures, links or markup', () => {
    expect(articleText('## Pick the size\n![dog](x.png)\nA **small** dog needs [less room](https://x.com).')).toBe('Pick the size\n\nA small dog needs less room.');
    expect(articleText('word '.repeat(2000)).length).toBeLessThan(3010);
  });

  it('shows {domain} as a placeholder where the reel rules are edited', async () => {
    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, { settings, encryptionKey: KEY, dataDir, ask: async () => '{}', readFlash: () => null, autoStart: false });
    expect((await app.inject({ url: '/new-website/sharing/reel-rules' })).body).toContain('<code>{domain}</code>');
  });

  it('pauses every reel for an hour when Google flags unusual activity, and keeps the pause', async () => {
    setWebsiteChannels(websiteId, [channel('facebook', 'f1')]);
    createReels(seoId);
    // A reel from before (one per platform) waits behind it.
    run(`INSERT INTO newsite_reels (seo_id, platform) VALUES (?, 'pinterest')`, seoId);
    let now = 1_000_000;
    const flagged = { ...deps(), now: () => now };
    flagged.flow = { ...flagged.flow!, poll: async () => ({ status: 'FAILED', error: "RpcError: MZZa6b failed: ['PUBLIC_ERROR_UNUSUAL_ACTIVITY']" }) };
    await kickReels(flagged);
    const [first, second] = listPlanReels(planId);
    expect(first!.error).toMatch(/paused for 60 minutes/);
    expect(second!.status).toBe('pending'); // not sent: the pause holds it
    expect(submitted).toHaveLength(1);
    await kickReels(flagged); // still paused, even on a new start
    expect(submitted).toHaveLength(1);
    now += 61 * 60_000;
    await kickReels({ ...deps(), now: () => now });
    expect(submitted).toHaveLength(2);
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
