import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, getNewWebsite, listKeywordPlans, saveKeywordPlan } from '../src/newsite/repo.js';
import { registerSocialRoutes } from '../src/newsite/social-routes.js';
import { shareStepPage } from '../src/newsite/keywords-view.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { listChannels, saveBufferChannel, saveFacebookApiChannel, setWebsiteChannels, websiteChannels } from '../src/newsite/channels.js';
import { kickPictureMaker, pictureDir, resetPictureMakerState } from '../src/newsite/pictures.js';
import {
  checkFbText,
  checkPinText,
  createSocialPosts,
  getSocialPost,
  kickSocial,
  listPlanSocialPosts,
  listSocialPosts,
  onPinPicture,
  type BufferApi,
  type FacebookApi,
  type SocialDeps,
} from '../src/newsite/social.js';

const KEY = randomBytes(32);
const POST_URL = 'https://f.longlivo.com/recipes/strawberry-cake';

const GOOD_PIN = {
  headline: 'Fresh Strawberry Cake',
  cta: 'Save for Later',
  title: 'Strawberry Cake With Fresh Berries and Whipped Cream Layers',
  description:
    'A soft strawberry cake with fresh berries folded into the batter and a light whipped cream frosting. Easy to bake at home for birthdays, picnics and slow summer weekends.',
  alt: 'Slice of layered strawberry cake with whipped cream and fresh strawberries on a white plate',
};

describe('Sharing an article on its channels', () => {
  let settings: Settings;
  let seoId: number;
  let websiteId: number;
  let dataDir: string;
  let asked: { name: string; vars: Record<string, unknown> }[];
  let pins: Parameters<BufferApi['createPin']>[0][];
  let fbPosts: { message: string }[];
  let bufferFb: Parameters<BufferApi['createFacebookPost']>[0][];
  let comments: { postId: string; message: string }[];
  let bufferFull: boolean;
  let pinAnswer: string;
  let clock: number;

  const buffer = (): BufferApi => ({
    channels: async () => [{ id: 'ch-pin', name: 'longlivo', service: 'pinterest', boards: [{ serviceId: 'b1', name: 'Recipes' }, { serviceId: 'b2', name: 'Strawberry Desserts' }] }],
    createPin: async (input) => {
      if (bufferFull) throw new Error('Buffer rejected the post: You have reached the limit of 10 posts in your queue');
      pins.push(input);
      return 'buffer-post-1';
    },
    createFacebookPost: async (input) => {
      if (bufferFull) throw new Error('Buffer rejected the post: You have reached the limit of 10 posts in your queue');
      bufferFb.push(input);
      return 'buffer-fb-1';
    },
  });
  const facebook = (): FacebookApi => ({
    publishPhoto: async ({ message }) => {
      fbPosts.push({ message });
      return { postId: 'page_123' };
    },
    commentOnPost: async ({ postId, message }) => {
      comments.push({ postId, message });
      return { commentId: 'c1' };
    },
  });
  const site = (async (url: string | URL) => {
    if (String(url).endsWith('/api/v1/media')) return new Response(JSON.stringify({ media: { id: 7, url: 'https://f.longlivo.com/media/pin.webp' } }), { status: 201 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const deps = (): SocialDeps => ({
    settings,
    encryptionKey: KEY,
    dataDir,
    fetchImpl: site,
    buffer,
    facebook,
    now: () => clock,
    wakeIn: () => {},
    ask: async (name, vars) => {
      asked.push({ name, vars });
      if (name === 'newsite-pin-text') return pinAnswer;
      if (name === 'newsite-pick-board') return '{"board": "Strawberry Desserts"}';
      return JSON.stringify({ text: 'This cake gets its pink crumb from real berries folded right into the batter. Soft, light and easy. Full recipe in the first comment.' });
    },
  });

  /** A made picture: a row and its file. */
  const made = (slot: string) => {
    run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, file) VALUES (?, ?, 0, ?, 'alt', 'done', ?)`, seoId, slot, `prompt ${slot}`, `${slot}.png`);
    mkdirSync(pictureDir(seoId, dataDir), { recursive: true });
    writeFileSync(join(pictureDir(seoId, dataDir), `${slot}.png`), 'img');
  };

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('buffer_hold_hours', '12');
    websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    const planId = saveKeywordPlan(websiteId, 'strawberry cake', [], 'recipe');
    queuePlanSeo(planId, 'strawberry cake', [], 'recipe');
    seoId = listPlanSeo(planId)[0]!.id;
    run(
      `UPDATE keyword_seo SET status = 'done', title = 'Strawberry Cake', description = 'D', focus_keyword = 'strawberry cake',
         article_status = 'done', article_md = '## Why\n\nText.', images_status = 'done', images_json = ?,
         post_status = 'published', post_id = 77, post_url = ? WHERE id = ?`,
      JSON.stringify({ theme: {}, images: [{ slot: 'feature', prompt: 'FEATURE SCENE', alt: 'a' }, { slot: 'closeup', prompt: 'CLOSEUP DETAIL', alt: 'b' }] }),
      POST_URL,
      seoId,
    );
    dataDir = mkdtempSync(join(tmpdir(), 'social-'));
    asked = [];
    pins = [];
    fbPosts = [];
    bufferFb = [];
    comments = [];
    bufferFull = false;
    pinAnswer = JSON.stringify(GOOD_PIN);
    clock = 1_000_000;
    resetPictureMakerState();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const pinChannel = () =>
    saveBufferChannel(
      { platform: 'pinterest', name: 'longlivo', bufferToken: 'tok', bufferChannelId: 'ch-pin', paidBuffer: false, postImage: true, postReel: false, multiWebsite: false },
      KEY,
    );
  const fbChannel = (postImage = true) =>
    saveFacebookApiChannel({ name: 'Easy Cakes', fbToken: 'fbtok', pageId: 'p1', postImage, postReel: false, multiWebsite: false }, KEY);
  const fbBufferChannel = (paidBuffer: boolean) =>
    saveBufferChannel(
      { platform: 'facebook', name: 'Easy Cakes', bufferToken: 'tok', bufferChannelId: 'ch-fb', paidBuffer, postImage: true, postReel: false, multiWebsite: false },
      KEY,
    );

  it('makes one post per channel the website shares on, once', () => {
    setWebsiteChannels(websiteId, [pinChannel(), fbChannel()]);
    expect(createSocialPosts(seoId)).toBe(2);
    expect(createSocialPosts(seoId)).toBe(0); // publishing again adds nothing
    expect(listSocialPosts().map((p) => p.kind).sort()).toEqual(['fb_image', 'pin']);
  });

  it('a pin: its words, then its own 3:4 picture from the next template, then Buffer with the article as its link', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    createSocialPosts(seoId);
    await kickSocial(deps());

    // Words written, picture queued from template 1 with the headline and domain on it.
    const [item] = listSocialPosts();
    expect(item).toMatchObject({ status: 'picture', template: 1, title: GOOD_PIN.title, text: GOOD_PIN.description });
    const pic = get<{ id: number; slot: string; prompt: string; status: string }>('SELECT * FROM newsite_pictures WHERE id = ?', item!.picture_id)!;
    expect(pic.slot).toBe(`pin-${item!.id}`);
    expect(pic.prompt).toContain('3:4');
    expect(pic.prompt).toContain('"Fresh Strawberry Cake"');
    expect(pic.prompt).toContain('FEATURE SCENE');
    expect(pic.prompt).toContain('f.longlivo.com');

    // The picture maker makes it in 3:4 and hands it back.
    const shapes: string[] = [];
    await kickPictureMaker({
      settings, dataDir, now: () => clock, sleep: async () => {},
      make: async (_p: string, _proj: string, shape: string) => { shapes.push(shape); return { data: Buffer.from('pin'), contentType: 'image/png' }; },
      afterPin: (id, ok) => onPinPicture(id, ok, deps()),
    });
    expect(shapes).toEqual(['PORTRAIT_3_4']);
    await kickSocial(deps()); // the poster picked the pin up when its picture came back

    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      channelId: 'ch-pin',
      title: GOOD_PIN.title,
      text: GOOD_PIN.description,
      linkUrl: POST_URL,
      imageUrl: 'https://f.longlivo.com/media/pin.webp',
      boardServiceId: 'b2', // the AI picked "Strawberry Desserts" for this keyword
    });
    expect(pins[0]!.text).not.toContain('http');
    expect(getSocialPost(item!.id)).toMatchObject({ status: 'sent', external_id: 'buffer-post-1', board_name: 'Strawberry Desserts' });
  });

  it('rotates the pin templates one by one', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    // Four more posted articles in the plan: five pins on the same channel.
    const planId = listPlanSeo(get<{ plan_id: number }>('SELECT plan_id FROM keyword_seo WHERE id = ?', seoId)!.plan_id)[0]!.plan_id;
    for (let i = 1; i <= 4; i++) {
      run(
        `INSERT INTO keyword_seo (plan_id, keyword, role, position, page, status, title, description, focus_keyword, article_status, article_md,
           images_status, images_json, post_status, post_id, post_url)
         SELECT plan_id, keyword || ' ${i}', 'sub', ${i}, page, status, title, description, focus_keyword, article_status, article_md,
           images_status, images_json, post_status, post_id, post_url FROM keyword_seo WHERE id = ?`,
        seoId,
      );
    }
    for (const r of listPlanSeo(planId)) createSocialPosts(r.id);
    await kickSocial(deps());
    expect(listSocialPosts().reverse().map((p) => p.template)).toEqual([1, 2, 3, 4, 1]);
  });

  it('sends a pin text with a link back to the AI to fix', async () => {
    expect(checkPinText({ ...GOOD_PIN, description: GOOD_PIN.description + ' Get it at f.longlivo.com today.' }, 'f.longlivo.com').join(' ')).toMatch(/link or web address/);
    expect(checkFbText('Soft strawberry cake with real berries in every bite. Read it here: https://f.longlivo.com/x and enjoy the cake.', 'f.longlivo.com').join(' ')).toMatch(/link or web address/);

    setWebsiteChannels(websiteId, [pinChannel()]);
    createSocialPosts(seoId);
    let calls = 0;
    const d = deps();
    d.ask = async (name, vars) => {
      if (name !== 'newsite-pin-text') return '{}';
      calls += 1;
      if (calls === 1) return JSON.stringify({ ...GOOD_PIN, description: GOOD_PIN.description + ' See www.longlivo.com' });
      expect(String(vars.problemsJson)).toMatch(/link or web address[\s\S]*Your previous answer/);
      return JSON.stringify(GOOD_PIN);
    };
    await kickSocial(d);
    expect(calls).toBe(2);
    expect(listSocialPosts()[0]).toMatchObject({ status: 'picture', text: GOOD_PIN.description });
  });

  it('waits when the Buffer channel is full, and posts once it has room', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    createSocialPosts(seoId);
    await kickSocial(deps());
    const id = listSocialPosts()[0]!.id;
    bufferFull = true;
    await kickPictureMaker({
      settings, dataDir, now: () => clock, sleep: async () => {},
      make: async () => ({ data: Buffer.from('pin'), contentType: 'image/png' }),
      afterPin: (pid, ok) => onPinPicture(pid, ok, deps()),
    });
    await kickSocial(deps());
    expect(getSocialPost(id)).toMatchObject({ status: 'waiting', retry_at: clock + 12 * 3_600_000 });
    expect(getSocialPost(id)!.error).toMatch(/Tries again in 12 hours/);

    // Not yet due: nothing happens. Due, with room: it goes out.
    bufferFull = false;
    await kickSocial(deps());
    expect(pins).toHaveLength(0);
    clock += 12 * 3_600_000;
    await kickSocial(deps());
    expect(pins).toHaveLength(1);
    expect(getSocialPost(id)).toMatchObject({ status: 'sent' });
  });

  it('a Facebook image post: the feature picture and the words, the link only in the first comment', async () => {
    made('feature');
    setWebsiteChannels(websiteId, [fbChannel()]);
    createSocialPosts(seoId);
    await kickSocial(deps());
    expect(fbPosts).toHaveLength(1);
    expect(fbPosts[0]!.message).not.toMatch(/http|longlivo/);
    expect(comments).toEqual([{ postId: 'page_123', message: POST_URL }]);
    expect(listSocialPosts()[0]).toMatchObject({ status: 'sent', external_id: 'page_123', comment_id: 'c1' });
  });

  it('a Facebook image post through Buffer on a paid plan: the link only as Buffer’s first comment', async () => {
    made('feature');
    setWebsiteChannels(websiteId, [fbBufferChannel(true)]);
    createSocialPosts(seoId);
    await kickSocial(deps());
    expect(fbPosts).toHaveLength(0); // not through the Facebook API
    expect(bufferFb).toHaveLength(1);
    expect(bufferFb[0]).toMatchObject({ channelId: 'ch-fb', firstComment: POST_URL, imageUrl: 'https://f.longlivo.com/media/pin.webp' });
    expect(bufferFb[0]!.text).not.toMatch(/http|longlivo/);
    expect(listSocialPosts()[0]).toMatchObject({ status: 'sent', external_id: 'buffer-fb-1', error: '' });
  });

  it('a Facebook image post through Buffer on the free plan goes out with no link at all', async () => {
    made('feature');
    setWebsiteChannels(websiteId, [fbBufferChannel(false)]);
    createSocialPosts(seoId);
    await kickSocial(deps());
    expect(bufferFb[0]!.firstComment).toBe('');
    expect(bufferFb[0]!.text).not.toMatch(/http|longlivo/);
    expect(listSocialPosts()[0]!.error).toMatch(/without the link/);
  });

  it('makes no image post for a page set to post reels only', () => {
    setWebsiteChannels(websiteId, [fbChannel(false)]);
    expect(createSocialPosts(seoId)).toBe(0);
  });

  describe('the Share step of a keyword plan', () => {
    const page = () => {
      const plan = listKeywordPlans().find((p) => p.id === listPlanSeo(planIdOf())[0]!.plan_id)!;
      const site = getNewWebsite(websiteId)!;
      return shareStepPage(site, plan, listPlanSeo(plan.id), websiteChannels(websiteId), listPlanSocialPosts(plan.id), listChannels()).value;
    };
    const planIdOf = () => get<{ plan_id: number }>('SELECT plan_id FROM keyword_seo WHERE id = ?', seoId)!.plan_id;
    const app = async () => {
      const a = Fastify();
      await a.register(formbody);
      registerSocialRoutes(a, { ...deps(), readFlash: () => null, autoStart: false });
      return a;
    };

    it('says when the website shares on no channel, with where to pick or add one', () => {
      const out = page();
      expect(out).toContain('Long Livo shares on no channel yet.');
      expect(out).toContain(`/new-website/${websiteId}/edit?section=4`);
      expect(out).toContain('href="/new-website/channels"');
      expect(out).toContain('8. Share');
    });

    it('offers Share now for a published article not on its channels yet, and shares it', async () => {
      setWebsiteChannels(websiteId, [pinChannel(), fbChannel()]);
      expect(page()).toContain('Share now');
      expect(page()).toContain('Share all published (1)');
      const a = await app();
      const res = await a.inject({ method: 'POST', url: `/new-website/keywords/share/${seoId}` });
      expect(res.headers.location).toMatch(/share\?ok=.*2%20channels/);
      expect(listPlanSocialPosts(planIdOf())).toHaveLength(2);
      // Already on every channel: nothing more to share.
      expect(page()).not.toContain('Share now');
      const again = await a.inject({ method: 'POST', url: `/new-website/keywords/plan/${planIdOf()}/share` });
      expect(again.headers.location).toMatch(/already%20shared/);
    });

    it('waits for the article to be published', async () => {
      setWebsiteChannels(websiteId, [pinChannel()]);
      run(`UPDATE keyword_seo SET post_status = '', post_url = '' WHERE id = ?`, seoId);
      // Not published: hidden from the Share step, with one line saying it comes later.
      expect(page()).not.toContain('strawberry cake</b>');
      expect(page()).toContain('1 more keyword appears here once they are published.');
      const res = await (await app()).inject({ method: 'POST', url: `/new-website/keywords/share/${seoId}` });
      expect(res.headers.location).toMatch(/error=/);
      expect(listSocialPosts()).toHaveLength(0);
    });

    it('shows each post with its status, and puts a failed one back to work', async () => {
      setWebsiteChannels(websiteId, [fbChannel()]);
      made('feature');
      createSocialPosts(seoId);
      const [post] = listSocialPosts();
      run(`UPDATE newsite_social_posts SET status = 'failed', error = 'Facebook said no.' WHERE id = ?`, post!.id);
      const out = page();
      expect(out).toContain('Easy Cakes · Facebook through the API');
      expect(out).toContain('Facebook said no.');
      expect(out).toContain(`/new-website/keywords/share/post/${post!.id}/retry`);
      const res = await (await app()).inject({ method: 'POST', url: `/new-website/keywords/share/post/${post!.id}/retry` });
      expect(res.headers.location).toMatch(/share\?ok=/);
      expect(getSocialPost(post!.id)!.status).not.toBe('failed');
    });
  });
});
