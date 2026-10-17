import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { saveBufferChannel, saveFacebookApiChannel, setWebsiteChannels } from '../src/newsite/channels.js';
import { createReels, kickReels, onReelMade, reelDir, type ReelDeps } from '../src/newsite/reels.js';
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
import { refreshPostLinks } from '../src/newsite/post-links.js';
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

const GOOD_IG = {
  text: 'Real berries go right into the batter, and that first pink slice says it all. Save this for your next bake. #strawberrycake #baking #summerdessert',
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
      { id: 'ch-ig', name: 'longlivo.ig', service: 'instagram', boards: [] },
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
    return JSON.stringify(vars.label === 'Pinterest' ? GOOD_PIN : vars.label === 'Instagram' ? GOOD_IG : GOOD_FB);
  };
  const deps = (): ReelShareDeps => ({ settings, encryptionKey: KEY, dataDir, ask, buffer, facebook, now: () => clock, wakeIn: () => {} });

  /** The article's one made reel, its video on disk. */
  const madeReel = (): number => {
    const id = Number(run(`INSERT INTO newsite_reels (seo_id, platform, status, file) VALUES (?, 'all', 'done', '')`, seoId).lastInsertRowid);
    run('UPDATE newsite_reels SET file = ? WHERE id = ?', `reel-${id}.mp4`, id);
    mkdirSync(reelDir(dataDir), { recursive: true });
    writeFileSync(join(reelDir(dataDir), `reel-${id}.mp4`), Buffer.from('mp4-video-bytes'));
    return id;
  };
  const fbApiPage = (postReel: boolean) =>
    saveFacebookApiChannel({ name: 'Easy Cakes', fbToken: 'fb-tok', pageId: 'page-1', postImage: true, postReel, multiWebsite: false }, KEY);
  const pinChannel = (postReel = true) =>
    saveBufferChannel({ platform: 'pinterest', name: 'longlivo', bufferToken: 'tok', bufferChannelId: 'ch-pin', paidBuffer: false, postImage: true, postReel, multiWebsite: false }, KEY);
  const igChannel = () =>
    saveBufferChannel({ platform: 'instagram', name: 'longlivo.ig', bufferToken: 'tok', bufferChannelId: 'ch-ig', paidBuffer: false, postImage: true, postReel: true, multiWebsite: false }, KEY);
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
    onReelMade(null);
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('posts a Facebook reel through the API with its own words, and the article link as the first comment', async () => {
    setWebsiteChannels(websiteId, [fbApiPage(true)]);
    const reelId = madeReel();
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

  it('sends the SAME video to Facebook, Instagram and Pinterest, each with its own words and status, never making it again', async () => {
    setWebsiteChannels(websiteId, [fbApiPage(true), igChannel(), pinChannel()]);
    const reelId = madeReel();
    expect(createReelShares(reelId)).toBe(3);
    await kickReelShares(deps());

    expect(reelsPosted).toHaveLength(1); // Facebook, through its API
    expect(videoPosts.map((p) => p.channelId).sort()).toEqual(['ch-ig', 'ch-pin']);
    // One video: both Buffer posts fetch the same reel.
    expect(new Set(videoPosts.map((p) => new URL(p.videoUrl).pathname.split('/')[3]))).toEqual(new Set([String(reelId)]));
    expect(videoPosts.find((p) => p.channelId === 'ch-ig')!.metadata).toBe('instagram: { type: reel shouldShareToFeed: true }');
    const shares = listPlanReelShares(planId);
    expect(shares.map((x) => x.status)).toEqual(['sent', 'sent', 'sent']);
    // Words written once per channel, by its own platform's rules.
    expect(asked.filter((a) => a.name === 'newsite-social-post').map((a) => a.vars.label).sort()).toEqual(['Facebook', 'Instagram', 'Pinterest']);
    expect(get('SELECT COUNT(*) AS n FROM newsite_reels')).toEqual({ n: 1 });
  });

  it('leaves a channel that is not set to post reels alone, unless it is picked for the reel', async () => {
    const page = fbApiPage(false);
    setWebsiteChannels(websiteId, [page]);
    const reelId = madeReel();
    expect(createReelShares(reelId)).toBe(0);
    expect(shareReelOn(reelId, page)).toBe(1);
    await kickReelShares(deps());
    expect(reelsPosted).toHaveLength(1);
  });

  it('queues a Pinterest video pin in Buffer: the video from this platform, its board and the article as the pin link', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    const reelId = madeReel();
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
    const reelId = madeReel();
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
    const reelId = madeReel();
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
    const reelId = madeReel();
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
    const reelId = madeReel();
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

  it('the Reels page shows each reel once, with the channels to tick; a channel page shows only where it stands', async () => {
    const page1 = fbApiPage(false);
    const pin = pinChannel(false);
    setWebsiteChannels(websiteId, [page1, pin]);
    const reelId = madeReel();
    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, {
      settings, encryptionKey: KEY, dataDir, ask, autoStart: false, readFlash: () => null,
      reelShares: { buffer, facebook, now: () => clock, wakeIn: () => {} },
    });
    const sharing = (await app.inject({ url: '/new-website/sharing' })).body;
    expect(sharing).toContain('href="/new-website/sharing/reels"'); // its own card beside the websites

    const reels = (await app.inject({ url: '/new-website/sharing/reels' })).body;
    expect(reels.match(/id="reel-\d+"/g)).toHaveLength(1);
    expect(reels).toContain(`action="/new-website/reels/${reelId}/share"`);
    expect(reels).toContain(`name="channel" value="${page1}"`);
    expect(reels).toContain(`name="channel" value="${pin}"`);
    expect(reels).toContain('Send to the ticked channels');

    const res = await app.inject({
      method: 'POST', url: `/new-website/reels/${reelId}/share`,
      payload: `channel=${page1}&channel=${pin}`, headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://dash.example.com/new-website/sharing/reels' },
    });
    expect(res.headers.location).toMatch(/^\/new-website\/sharing\/reels\?ok=Sending\+the\+reel\+to\+2\+channels/);
    await kickReelShares(deps());
    expect(reelsPosted).toHaveLength(1);
    expect(videoPosts).toHaveLength(1);

    const after = (await app.inject({ url: '/new-website/sharing/reels' })).body;
    expect(after).toContain('href="https://www.facebook.com/reel/vid_1"');
    expect(after).toContain('Open the reel on Easy Cakes (Facebook)');
    expect(after).toContain('href="https://www.facebook.com/page-1"'); // the page itself
    expect(after).toContain('Facebook · Easy Cakes: Sent');
    expect(after).toContain('Queued in Buffer');
    expect(after).toContain('The link appears once Buffer has posted it.');
    expect(after).toContain(`href="${POST_URL}"`); // the article itself
    expect(after).toContain('class="acc rl'); // a full-width card that opens and closes

    // Once Buffer has sent the pin, its address becomes the link.
    const found = await refreshPostLinks({
      encryptionKey: KEY,
      buffer: () => ({ getPost: async (id) => ({ status: 'sent', externalLink: `https://www.pinterest.com/pin/${id}/`, error: '' }) }),
    });
    expect(found).toBe(1);
    const linked = (await app.inject({ url: '/new-website/sharing/reels' })).body;
    expect(linked).toContain('href="https://www.pinterest.com/pin/buffer-video-1/"');
    expect(linked).toContain('Open the reel on longlivo (Pinterest)');
    expect(after).not.toContain('Send to the ticked channels'); // nothing left to send

    const channel = (await app.inject({ url: `/new-website/sharing/site/${websiteId}/channel/${page1}?tab=reels` })).body;
    expect(channel).toContain('Posted');
    expect(channel).toContain('href="/new-website/sharing/reels?website=');
    expect(channel).not.toContain('/remake'); // no making here
    await app.close();
  });

  it('a Facebook reel sent before links were kept still links to the reel on its page', async () => {
    setWebsiteChannels(websiteId, [fbApiPage(true)]);
    createReelShares(madeReel());
    await kickReelShares(deps());
    run(`UPDATE newsite_reel_shares SET post_link = ''`); // as the older shares were saved
    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, { settings, encryptionKey: KEY, dataDir, ask, autoStart: false, readFlash: () => null });
    const page = (await app.inject({ url: '/new-website/sharing/reels' })).body;
    expect(page).toContain('href="https://www.facebook.com/reel/vid_1"');
    expect(page).toContain('Open the reel on Easy Cakes (Facebook)');
    await app.close();

    expect(await refreshPostLinks({ encryptionKey: KEY, buffer: () => { throw new Error('no Buffer here'); } })).toBe(1);
    expect(listPlanReelShares(planId)[0]!.post_link).toBe('https://www.facebook.com/reel/vid_1');
  });

  it('a channel set to post reels later still gets the recent reels it missed, but not old ones or failed ones', async () => {
    const page1 = fbApiPage(true);
    setWebsiteChannels(websiteId, [page1]);
    const reelId = madeReel();
    createReelShares(reelId);
    await kickReelShares(deps());
    expect(reelsPosted).toHaveLength(1); // only the page there when it was made

    const pin = pinChannel(true);
    const ig = igChannel();
    setWebsiteChannels(websiteId, [page1, pin, ig]);
    run(`UPDATE newsite_reels SET done_at = datetime('now', '-30 days') WHERE id = ?`, reelId);
    await kickReelShares(deps());
    expect(listPlanReelShares(planId)).toHaveLength(1); // too old to catch up on

    run(`UPDATE newsite_reels SET done_at = datetime('now', '-2 days') WHERE id = ?`, reelId);
    await kickReelShares(deps());
    expect(listPlanReelShares(planId).map((x) => x.channel_id).sort()).toEqual([page1, pin, ig].sort());
    expect(videoPosts).toHaveLength(2);
    expect(reelsPosted).toHaveLength(1); // never twice on the page

    run(`UPDATE newsite_reel_shares SET status = 'failed' WHERE channel_id = ?`, pin);
    await kickReelShares(deps());
    expect(listPlanReelShares(planId).find((x) => x.channel_id === pin)!.status).toBe('failed');
  });

  it('marks a share failed when Buffer says it could not post it', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    createReelShares(madeReel());
    await kickReelShares(deps());
    await refreshPostLinks({ encryptionKey: KEY, buffer: () => ({ getPost: async () => ({ status: 'error', externalLink: '', error: 'Video too short' }) }) });
    expect(listPlanReelShares(planId)[0]).toMatchObject({ status: 'failed', error: 'Buffer could not post it: Video too short' });
  });

  it('the Reels page makes a reel for a published article that has none', async () => {
    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, { settings, encryptionKey: KEY, dataDir, ask, autoStart: false, readFlash: () => null });
    const page = (await app.inject({ url: '/new-website/sharing/reels' })).body;
    expect(page).toContain(`action="/new-website/reels/make/${seoId}"`);
    const res = await app.inject({ method: 'POST', url: `/new-website/reels/make/${seoId}` });
    expect(res.statusCode).toBe(303);
    expect(get('SELECT platform, status FROM newsite_reels WHERE seo_id = ?', seoId)).toMatchObject({ platform: 'all' });
    onReelMade(null);
    await kickReels({ settings, encryptionKey: KEY, dataDir }); // the route started the maker: let it stop before the database closes
    await app.close();
  });
});
