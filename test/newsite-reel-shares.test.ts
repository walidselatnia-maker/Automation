import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { saveBufferChannel, saveFacebookApiChannel, setWebsiteChannels } from '../src/newsite/channels.js';
import { createReels, kickReels, reelDir, type ReelDeps } from '../src/newsite/reels.js';
import {
  createReelShares,
  getReelShare,
  kickReelShares,
  listPlanReelShares,
  shareReelOn,
  type ReelBufferApi,
  type ReelFacebookApi,
  type ReelShareDeps,
} from '../src/newsite/reel-shares.js';
import { registerSocialRoutes } from '../src/newsite/social-routes.js';
import { checkMediaToken } from '../src/core/media-links.js';
import { registerMedia } from '../src/web/media.js';

const KEY = randomBytes(32);
const PROMPTS = resolve('./prompts');
const POST_URL = 'https://f.longlivo.com/recipes/strawberry-cake';

const GOOD_PIN = {
  headline: 'Fresh Strawberry Cake',
  cta: 'Save for Later',
  title: 'Strawberry Cake With Fresh Berries and Whipped Cream Layers',
  description:
    'A soft strawberry cake with fresh berries folded into the batter and a light whipped cream frosting. Easy to bake at home for birthdays, picnics and slow summer weekends.',
  alt: 'Slice of layered strawberry cake with whipped cream and fresh strawberries on a white plate',
};
const GOOD_FB = {
  text: 'Watch real berries go right into this batter, then that first pink slice. Soft, light and easy. Full recipe in the first comment.',
  alt: 'A tall slice of strawberry cake with whipped cream on a white plate',
};

describe('sharing reels on the website channels', () => {
  let settings: Settings;
  let dataDir: string;
  let seoId: number;
  let planId: number;
  let websiteId: number;
  let asked: { name: string; vars: Record<string, unknown> }[];
  let videoPosts: Parameters<ReelBufferApi['createVideoPost']>[0][];
  let reelsPosted: { pageId: string; description: string; bytes: number }[];
  let comments: { postId: string; message: string }[];
  let bufferFull: boolean;
  let clock: number;

  const buffer = (): ReelBufferApi => ({
    channels: async () => [
      { id: 'ch-pin', name: 'longlivo', service: 'pinterest', boards: [{ serviceId: 'b1', name: 'Recipes' }, { serviceId: 'b2', name: 'Strawberry Desserts' }] },
      { id: 'ch-fb', name: 'Easy Cakes', service: 'facebook', boards: [] },
    ],
    createVideoPost: async (input) => {
      if (bufferFull) throw new Error('Buffer rejected the reel: You have reached the limit of 10 posts in your queue');
      videoPosts.push(input);
      return `buffer-video-${videoPosts.length}`;
    },
  });
  const facebook = (): ReelFacebookApi => ({
    publishReel: async ({ pageId, description, video }) => {
      reelsPosted.push({ pageId, description, bytes: video.length });
      return { videoId: 'vid_1', permalink: 'https://www.facebook.com/reel/vid_1' };
    },
    commentOnPost: async ({ postId, message }) => {
      comments.push({ postId, message });
      return { commentId: 'c1' };
    },
  });
  const ask = async (name: string, vars: Record<string, unknown>): Promise<string> => {
    asked.push({ name, vars });
    if (name === 'newsite-pick-board') return '{"board": "Strawberry Desserts"}';
    return JSON.stringify(vars.label === 'Pinterest' ? GOOD_PIN : GOOD_FB);
  };
  const deps = (): ReelShareDeps => ({ settings, encryptionKey: KEY, dataDir, ask, buffer, facebook, now: () => clock, wakeIn: () => {} });

  /** A made reel for the article on this platform, its video on disk. */
  const madeReel = (platform: string): number => {
    const id = Number(run(`INSERT INTO newsite_reels (seo_id, platform, status, file) VALUES (?, ?, 'done', '')`, seoId, platform).lastInsertRowid);
    run('UPDATE newsite_reels SET file = ? WHERE id = ?', `reel-${id}.mp4`, id);
    mkdirSync(reelDir(dataDir), { recursive: true });
    writeFileSync(join(reelDir(dataDir), `reel-${id}.mp4`), Buffer.from('mp4-video-bytes'));
    return id;
  };
  const fbApiPage = (postReel: boolean) =>
    saveFacebookApiChannel({ name: 'Easy Cakes', fbToken: 'fb-tok', pageId: 'page-1', postImage: true, postReel, multiWebsite: false }, KEY);
  const pinChannel = () =>
    saveBufferChannel({ platform: 'pinterest', name: 'longlivo', bufferToken: 'tok', bufferChannelId: 'ch-pin', paidBuffer: false, postImage: true, postReel: false, multiWebsite: false }, KEY);
  const fbBufferPage = (paid: boolean) =>
    saveBufferChannel({ platform: 'facebook', name: 'Easy Cakes', bufferToken: 'tok', bufferChannelId: 'ch-fb', paidBuffer: paid, postImage: true, postReel: true, multiWebsite: false }, KEY);

  beforeEach(() => {
    configurePrompts(PROMPTS);
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('buffer_hold_hours', '12');
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
    run(
      `UPDATE keyword_seo SET status = 'done', title = 'Strawberry Cake', description = 'D', focus_keyword = 'strawberry cake',
         article_status = 'done', article_md = '## Why this cake\n\nText.\n\n## How to bake it\n\nMore.',
         post_status = 'published', post_id = 77, post_url = ? WHERE id = ?`,
      POST_URL,
      seoId,
    );
    dataDir = mkdtempSync(join(tmpdir(), 'reel-shares-'));
    asked = [];
    videoPosts = [];
    reelsPosted = [];
    comments = [];
    bufferFull = false;
    clock = 1_000_000;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('posts a Facebook reel through the API with its own words, and the article link as the first comment', async () => {
    setWebsiteChannels(websiteId, [fbApiPage(true)]);
    const reelId = madeReel('facebook');
    expect(createReelShares(reelId)).toBe(1);
    expect(createReelShares(reelId)).toBe(0); // never twice
    await kickReelShares(deps());

    expect(reelsPosted).toEqual([{ pageId: 'page-1', description: GOOD_FB.text, bytes: 15 }]);
    expect(comments).toEqual([{ postId: 'vid_1', message: POST_URL }]);
    const [share] = listPlanReelShares(planId);
    expect(share).toMatchObject({ status: 'sent', external_id: 'vid_1', comment_id: 'c1', error: '' });
    // Written fresh for the video, by the channel's rules, with no link in the words.
    const write = asked.find((a) => a.name === 'newsite-social-post')!;
    expect(String(write.vars.platformRules)).toContain('This post is a reel');
    expect(share!.text).not.toContain('http');
  });

  it('leaves a Facebook page that is not set to post reels alone, unless its Share button is pressed', async () => {
    const page = fbApiPage(false);
    setWebsiteChannels(websiteId, [page]);
    const reelId = madeReel('facebook');
    expect(createReelShares(reelId)).toBe(0);
    expect(shareReelOn(reelId, page)).toBe(1);
    await kickReelShares(deps());
    expect(reelsPosted).toHaveLength(1);
  });

  it('queues a Pinterest video pin in Buffer: the video from this platform, its board and the article as the pin link', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    const reelId = madeReel('pinterest');
    expect(createReelShares(reelId)).toBe(1);
    await kickReelShares(deps());

    expect(videoPosts).toHaveLength(1);
    const post = videoPosts[0]!;
    expect(post.channelId).toBe('ch-pin');
    expect(post.text).toBe(GOOD_PIN.description);
    expect(post.metadata).toBe(`pinterest: { title: ${JSON.stringify(GOOD_PIN.title)} url: ${JSON.stringify(POST_URL)} boardServiceId: "b2" }`);
    // The video link is this platform's own signed link to that reel.
    const m = /^https:\/\/dash\.example\.com\/media\/newsite-reel\/(\d+)\/(\d+)\/([A-Za-z0-9_-]+)\.mp4$/.exec(post.videoUrl)!;
    expect(Number(m[1])).toBe(reelId);
    expect(checkMediaToken({ kind: 'newsite-reel', id: reelId, expiresAt: Number(m[2]), signature: m[3]! }, KEY, clock).ok).toBe(true);
    expect(listPlanReelShares(planId)[0]).toMatchObject({ status: 'sent', external_id: 'buffer-video-1', board_name: 'Strawberry Desserts' });
  });

  it('sends a Facebook reel through Buffer as a reel, with the link as the first comment only on a paid plan', async () => {
    setWebsiteChannels(websiteId, [fbBufferPage(true)]);
    await kickReelShares(deps());
    const reelId = madeReel('facebook');
    createReelShares(reelId);
    await kickReelShares(deps());
    expect(videoPosts[0]!.metadata).toBe(`facebook: { type: reel firstComment: ${JSON.stringify(POST_URL)} }`);

    run('UPDATE newsite_channels SET paid_buffer = 0');
    run('DELETE FROM newsite_reel_shares');
    createReelShares(reelId);
    await kickReelShares(deps());
    expect(videoPosts[1]!.metadata).toBe('facebook: { type: reel }');
    expect(listPlanReelShares(planId)[0]!.error).toContain('free plan');
  });

  it('waits for room when the Buffer queue is full, and tries again later', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    const reelId = madeReel('pinterest');
    createReelShares(reelId);
    bufferFull = true;
    await kickReelShares(deps());
    const [waiting] = listPlanReelShares(planId);
    expect(waiting).toMatchObject({ status: 'waiting', retry_at: clock + 12 * 3_600_000 });

    bufferFull = false;
    clock += 12 * 3_600_000;
    await kickReelShares(deps());
    expect(getReelShare(waiting!.id)!.status).toBe('sent');
  });

  it('a failed share says why, and the card button puts it back to work', async () => {
    const page = fbApiPage(true);
    setWebsiteChannels(websiteId, [page]);
    const reelId = madeReel('facebook');
    createReelShares(reelId);
    await kickReelShares({ ...deps(), facebook: () => ({ ...facebook(), publishReel: async () => { throw new Error('(#200) pages_manage_posts is needed'); } }) });
    expect(listPlanReelShares(planId)[0]).toMatchObject({ status: 'failed', error: '(#200) pages_manage_posts is needed' });

    expect(shareReelOn(reelId, page)).toBe(1);
    await kickReelShares(deps());
    expect(listPlanReelShares(planId)[0]!.status).toBe('sent');
  });

  it('shares a reel by itself as soon as its video is made', async () => {
    setWebsiteChannels(websiteId, [fbApiPage(true)]);
    for (const slot of ['feature', 'closeup']) {
      run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, file) VALUES (?, ?, 1, 'p', 'a', 'done', ?)`, seoId, slot, `${slot}.png`);
    }
    const goodScript = (rules: string): string => {
      const closing = /closing line, word for word: "([^"]+)"/i.exec(rules)![1]!;
      const marks = rules.match(/^- (\d+-\d+s):/gm)!.map((m) => m.slice(2, -1));
      const hook = 'This cake needs no oven, watch this';
      const shots = marks.map((m, i) =>
        `${m}: ${i === 0 ? `The finished cake, a hand cuts a slice. The voice says "${hook}".` : i === marks.length - 1 ? `The slice lifted. The voice says "${closing}".` : 'Real hands do the next step at natural speed, phone camera, close and handheld, warm kitchen light from the left side of the frame.'}`,
      );
      return JSON.stringify({ hook_line: hook, closing_line: closing, prompt: `A 10-second vertical reel of a strawberry cake.\n${shots.join('\n')}\nReal cooking sound, no music, no on-screen text.` });
    };
    const shareDeps = deps();
    const reelDeps: ReelDeps = {
      settings, encryptionKey: KEY, dataDir, sleep: async () => {}, download: async () => Buffer.from('mp4'),
      ask: async (name, vars) => (name === 'newsite-reel-prompt' ? goodScript(String(vars.reelRules)) : ask(name, vars)),
      flow: { submitVideo: async () => 'job-1', poll: async () => ({ status: 'COMPLETED', image_url: 'https://flow/v.mp4' }) },
      onDone: (id) => {
        createReelShares(id);
      },
    };
    expect(createReels(seoId)).toBe(1);
    await kickReels(reelDeps);
    await kickReelShares(shareDeps);
    expect(reelsPosted).toHaveLength(1);
  });

  it('the media door serves a made reel by its signed link, and nothing without one', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    const reelId = madeReel('pinterest');
    createReelShares(reelId);
    await kickReelShares({ ...deps(), now: () => Date.now() });
    const app = Fastify();
    registerMedia(app, { secret: KEY, clipsDir: dataDir, dataDir });
    const path = new URL(videoPosts[0]!.videoUrl).pathname;
    const ok = await app.inject({ method: 'GET', url: path });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('video/mp4');
    expect(ok.body).toBe('mp4-video-bytes');
    const part = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=0-2' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('mp4');
    const forged = await app.inject({ method: 'GET', url: path.replace(`/${reelId}/`, `/${reelId + 1}/`) });
    expect(forged.statusCode).toBe(404);
    await app.close();
  });

  it('the reel card on a channel page offers Share, then shows where it stands', async () => {
    setWebsiteChannels(websiteId, [fbApiPage(false)]);
    const reelId = madeReel('facebook');
    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, {
      settings, encryptionKey: KEY, dataDir, ask, autoStart: false, readFlash: () => null,
      reelShares: { buffer, facebook, now: () => clock, wakeIn: () => {} },
    });
    const channelId = Number((await app.inject({ method: 'GET', url: `/new-website/sharing/site/${websiteId}` })).body.match(/\/channel\/(\d+)/)![1]);
    const page = (await app.inject({ method: 'GET', url: `/new-website/sharing/site/${websiteId}/channel/${channelId}?tab=reels` })).body;
    expect(page).toContain(`action="/new-website/reels/${reelId}/share"`);
    expect(page).toContain('Share on Facebook');

    const res = await app.inject({ method: 'POST', url: `/new-website/reels/${reelId}/share`, payload: `channel=${channelId}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(303);
    await kickReelShares(deps());
    expect(reelsPosted).toHaveLength(1);
    const after = (await app.inject({ method: 'GET', url: `/new-website/sharing/site/${websiteId}/channel/${channelId}?tab=reels` })).body;
    expect(after).toContain('Shared on Facebook');
    expect(after).toContain('https://www.facebook.com/reel/vid_1');
    await app.close();
  });
});
