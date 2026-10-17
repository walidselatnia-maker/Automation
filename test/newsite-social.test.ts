import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { registerMedia } from '../src/web/media.js';
import { instagramFileOf, makeInstagramPicture } from '../src/newsite/instagram-picture.js';
import { createNewWebsite, getNewWebsite, listKeywordPlans, saveKeywordPlan } from '../src/newsite/repo.js';
import { registerSocialRoutes } from '../src/newsite/social-routes.js';
import { shareStepPage } from '../src/newsite/keywords-view.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { listChannels, saveBufferChannel, saveChannelRules, saveFacebookApiChannel, saveInstagramApiChannel, saveThreadsApiChannel, setWebsiteChannels, websiteChannels } from '../src/newsite/channels.js';
import { kickPictureMaker, resetPictureMakerState } from '../src/newsite/pictures.js';
import { addPinDesign, pickedPinDesigns, setPinDesignPicked } from '../src/newsite/pin-designs.js';
import { checkPlatformRules, listPlatformRules, loadPlatformRules, parseRules } from '../src/newsite/platform-rules.js';
import {
  bufferMetadata,
  checkFields,
  createSocialPosts,
  getSocialPost,
  kickSocial,
  listPlanSocialPosts,
  listSocialPosts,
  onPinPicture,
  postFields,
  remakeSocialPost,
  type BufferApi,
  type FacebookApi,
  type SocialDeps,
} from '../src/newsite/social.js';

const KEY = randomBytes(32);
const POST_URL = 'https://f.longlivo.com/recipes/strawberry-cake';
const PROMPTS = resolve('./prompts');

const GOOD_PIN = {
  headline: 'Fresh Strawberry Cake',
  cta: 'Save for Later',
  title: 'Strawberry Cake With Fresh Berries and Whipped Cream Layers',
  description:
    'A soft strawberry cake with fresh berries folded into the batter and a light whipped cream frosting. Easy to bake at home for birthdays, picnics and slow summer weekends.',
  alt: 'Slice of layered strawberry cake with whipped cream and fresh strawberries on a white plate',
};
const GOOD_IG = {
  text: 'Real berries go right into the batter, and that first pink slice says it all. Save this for your next bake. #strawberrycake #baking #summerdessert',
  alt: 'A tall slice of strawberry cake with whipped cream on a white plate',
};
const GOOD_FB = {
  text: 'This cake gets its pink crumb from real berries folded right into the batter. Soft, light and easy. Full recipe in the first comment.',
  alt: 'A tall slice of strawberry cake with whipped cream on a white plate',
};

type BufferPost = Parameters<BufferApi['createImagePost']>[0];

describe('Sharing an article on its channels', () => {
  let settings: Settings;
  let seoId: number;
  let websiteId: number;
  let dataDir: string;
  let asked: { name: string; vars: Record<string, unknown> }[];
  let bufferPosts: BufferPost[];
  let fbPosts: { message: string }[];
  let comments: { postId: string; message: string }[];
  let bufferFull: boolean;
  let bufferAnswer: 'ok' | 'no-id';
  let answers: Record<string, string>;
  let pictureStatus: number;
  let clock: number;

  const buffer = (): BufferApi => ({
    channels: async () => [
      { id: 'ch-pin', name: 'longlivo', service: 'pinterest', boards: [{ serviceId: 'b1', name: 'Recipes' }, { serviceId: 'b2', name: 'Strawberry Desserts' }] },
      { id: 'ch-fb', name: 'Easy Cakes', service: 'facebook', boards: [] },
      { id: 'ch-ig', name: 'longlivo.kitchen', service: 'instagram', boards: [] },
      { id: 'ch-threads', name: 'longlivo threads', service: 'threads', boards: [] },
    ],
    createImagePost: async (input) => {
      if (bufferFull) throw new Error('Buffer rejected the post: You have reached the limit of 10 posts in your queue');
      // The real client throws on an answer without a post id; this stands in for it.
      if (bufferAnswer === 'no-id') throw new Error('Buffer did not confirm the post (no post id in its answer), so it was not recorded as sent.');
      bufferPosts.push(input);
      return { id: `buffer-${bufferPosts.length}`, dueAt: '2026-10-14T09:30:00.000Z' };
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
  /** The platform's own picture link, as Buffer would fetch it. */
  const internet = (async (url: string | URL) => {
    if (String(url).includes('/media/picture/') || String(url).includes('/media/ig-picture/')) {
      return pictureStatus === 200
        ? new Response('img', { status: 200, headers: { 'content-type': 'image/png' } })
        : new Response('Not found', { status: pictureStatus, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const deps = (): SocialDeps => ({
    settings,
    encryptionKey: KEY,
    dataDir,
    fetchImpl: internet,
    buffer,
    facebook,
    now: () => clock,
    wakeIn: () => {},
    ask: async (name, vars) => {
      asked.push({ name, vars });
      if (name === 'newsite-pick-board') return '{"board": "Strawberry Desserts"}';
      return answers[String(vars.label)] ?? '{}';
    },
  });

  /** The picture maker makes the queued social pictures, and hands each back to its post. */
  const makeSocialPictures = async (): Promise<string[]> => {
    const shapes: string[] = [];
    await kickPictureMaker({
      settings, dataDir, now: () => clock, sleep: async () => {},
      make: async (_p: string, _proj: string, shape: string) => { shapes.push(shape); return { data: Buffer.from('pic'), contentType: 'image/png' }; },
      afterPin: (id, ok) => onPinPicture(id, ok, deps()),
    });
    await kickSocial(deps());
    return shapes;
  };

  /** Publish-time: the posts are made, then words, picture and sending. */
  const share = async (): Promise<void> => {
    createSocialPosts(seoId);
    await kickSocial(deps());
    await makeSocialPictures();
  };

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
    const planId = saveKeywordPlan(websiteId, 'strawberry cake', [], 'recipe');
    queuePlanSeo(planId, 'strawberry cake', [], 'recipe');
    seoId = listPlanSeo(planId)[0]!.id;
    run(
      `UPDATE keyword_seo SET status = 'done', title = 'Strawberry Cake', description = 'D', focus_keyword = 'strawberry cake',
         article_status = 'done', article_md = '## Why this cake\n\nText.\n\n## How to bake it\n\nMore.', images_status = 'done', images_json = ?,
         post_status = 'published', post_id = 77, post_url = ? WHERE id = ?`,
      JSON.stringify({ theme: {}, images: [{ slot: 'feature', prompt: 'FEATURE SCENE', alt: 'a' }, { slot: 'closeup', prompt: 'CLOSEUP DETAIL', alt: 'b' }] }),
      POST_URL,
      seoId,
    );
    dataDir = mkdtempSync(join(tmpdir(), 'social-'));
    asked = [];
    bufferPosts = [];
    fbPosts = [];
    comments = [];
    bufferFull = false;
    bufferAnswer = 'ok';
    pictureStatus = 200;
    answers = { Pinterest: JSON.stringify(GOOD_PIN), Facebook: JSON.stringify(GOOD_FB), Instagram: JSON.stringify(GOOD_IG) };
    clock = 1_000_000;
    resetPictureMakerState();
  });

  afterEach(() => {
    closeDatabase();
    configurePrompts(PROMPTS);
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

  /* -- Pinterest to Buffer ------------------------------------------------- */

  it('Pinterest: words from the article by the rules file, its own 3:4 picture, then Buffer with the right payload', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    createSocialPosts(seoId);
    await kickSocial(deps());

    // Words written from the article, with the rules file as the instructions.
    const ask = asked.find((a) => a.name === 'newsite-social-post')!;
    expect(ask.vars.platformRules).toContain('# Pinterest rules');
    expect(ask.vars.fields).toBe('headline, cta, title, description, alt');
    expect(ask.vars.articleOutline).toBe('- Why this cake\n- How to bake it');
    const [item] = listSocialPosts();
    expect(item).toMatchObject({ kind: 'pinterest', status: 'picture', template: 1, title: GOOD_PIN.title, text: GOOD_PIN.description, alt: GOOD_PIN.alt });
    expect(postFields(item!)).toEqual(GOOD_PIN);
    const pic = get<{ slot: string; prompt: string; shape: string }>('SELECT slot, prompt, shape FROM newsite_pictures WHERE id = ?', item!.picture_id)!;
    expect(pic).toMatchObject({ slot: `social-${item!.id}`, shape: 'PORTRAIT_3_4' });
    expect(pic.prompt).toContain('"Fresh Strawberry Cake"');
    expect(pic.prompt).toContain('FEATURE SCENE');
    expect(pic.prompt).toContain('f.longlivo.com');

    expect(await makeSocialPictures()).toEqual(['PORTRAIT_3_4']);

    expect(bufferPosts).toHaveLength(1);
    const sent = bufferPosts[0]!;
    expect(sent).toMatchObject({ channelId: 'ch-pin', text: GOOD_PIN.description, altText: GOOD_PIN.alt });
    expect(sent.imageUrl).toMatch(/^https:\/\/dash\.example\.com\/media\/picture\/\d+\/\d+\/[A-Za-z0-9_-]+\.png$/);
    // The pin's link is the article, in Pinterest's own field; the board is the AI's pick for this keyword.
    expect(sent.metadata).toBe(`pinterest: { title: ${JSON.stringify(GOOD_PIN.title)} url: ${JSON.stringify(POST_URL)} boardServiceId: "b2" }`);
    expect(sent.text).not.toMatch(/http|longlivo/);
    // Recorded only with Buffer's own confirmation: its post id and when it will post.
    expect(getSocialPost(item!.id)).toMatchObject({ status: 'sent', external_id: 'buffer-1', due_at: '2026-10-14T09:30:00.000Z', board_name: 'Strawberry Desserts', error: '' });
  });

  it('never records a post as sent when Buffer does not confirm it', async () => {
    bufferAnswer = 'no-id';
    setWebsiteChannels(websiteId, [pinChannel()]);
    await share();
    const [item] = listSocialPosts();
    expect(item).toMatchObject({ status: 'failed', external_id: '', due_at: '' });
    expect(item!.error).toMatch(/did not confirm/);
  });

  it('checks the picture link answers before Buffer is asked to fetch it', async () => {
    pictureStatus = 404;
    setWebsiteChannels(websiteId, [pinChannel()]);
    await share();
    expect(bufferPosts).toHaveLength(0);
    const [item] = listSocialPosts();
    expect(item!.status).toBe('failed');
    expect(item!.error).toMatch(/could not download the picture: https:\/\/dash\.example\.com answered HTTP 404/);
  });

  it('needs the platform’s public address: Buffer fetches the picture from it', async () => {
    settings.set('public_base_url', '');
    setWebsiteChannels(websiteId, [pinChannel()]);
    await share();
    expect(bufferPosts).toHaveLength(0);
    expect(listSocialPosts()[0]!.error).toMatch(/no public address yet.*Platform settings/);
  });

  it('waits when the Buffer channel is full, and posts once it has room', async () => {
    bufferFull = true;
    setWebsiteChannels(websiteId, [pinChannel()]);
    await share();
    const [item] = listSocialPosts();
    expect(item!.status).toBe('waiting');
    bufferFull = false;
    await kickSocial(deps());
    expect(bufferPosts).toHaveLength(0); // not due yet
    clock += 12 * 3_600_000;
    await kickSocial(deps());
    expect(getSocialPost(item!.id)).toMatchObject({ status: 'sent', external_id: 'buffer-1' });
  });

  it('sends words with a link back to the AI, with the exact problem', async () => {
    answers.Pinterest = JSON.stringify({ ...GOOD_PIN, description: `${GOOD_PIN.description} Get it at f.longlivo.com` });
    let round = 0;
    const d = deps();
    const ask = d.ask;
    d.ask = async (name, vars) => {
      if (name === 'newsite-social-post' && round++ === 1) answers.Pinterest = JSON.stringify(GOOD_PIN);
      return ask(name, vars);
    };
    setWebsiteChannels(websiteId, [pinChannel()]);
    createSocialPosts(seoId);
    await kickSocial(d);
    const second = asked.filter((a) => a.name === 'newsite-social-post')[1]!;
    expect(String(second.vars.problemsJson)).toMatch(/description has a link or web address/);
    expect(listSocialPosts()[0]!.text).toBe(GOOD_PIN.description);
  });

  it('rotates the picture templates one by one per channel', async () => {
    setWebsiteChannels(websiteId, [pinChannel()]);
    createSocialPosts(seoId);
    await kickSocial(deps());
    expect(listSocialPosts()[0]!.template).toBe(1);
    expect(remakeSocialPost(listSocialPosts()[0]!.id)).toBe(false); // its picture is being made
    run(`UPDATE newsite_social_posts SET status = 'failed'`);
    remakeSocialPost(listSocialPosts()[0]!.id);
    await kickSocial(deps());
    expect(listSocialPosts()[0]!.template).toBe(2);
  });

  it('makes pins only from the picked designs, an added design included, in turn', async () => {
    const added = addPinDesign('Design 5', 'A bright pin of {{scene}} with the headline "{{headline}}" and {{domain}}.');
    setPinDesignPicked(1, false);
    setPinDesignPicked(4, false);
    expect(setPinDesignPicked(2, false)).toBe(true);
    expect(setPinDesignPicked(3, false)).toBe(true);
    expect(setPinDesignPicked(added, false)).toBe(false); // the last picked one stays
    setPinDesignPicked(3, true);
    expect(pickedPinDesigns().map((d) => d.id)).toEqual([3, added]);

    setWebsiteChannels(websiteId, [pinChannel()]);
    const used: number[] = [];
    const prompts: string[] = [];
    for (let i = 0; i < 3; i++) {
      run('DELETE FROM newsite_social_posts');
      createSocialPosts(seoId);
      await kickSocial(deps());
      const post = listSocialPosts()[0]!;
      used.push(post.template);
      prompts.push(get<{ prompt: string }>('SELECT prompt FROM newsite_pictures WHERE id = ?', post.picture_id)!.prompt);
    }
    expect(used).toEqual([3, added, 3]);
    expect(prompts[1]).toContain(`the headline "${GOOD_PIN.headline}"`);
    expect(prompts[1]).toContain('f.longlivo.com');
    expect(prompts[0]).toContain('torn-paper banner'); // design 3
  });

  /* -- Facebook ------------------------------------------------------------ */

  it('Facebook through the API: its words, its own 3:4 picture, the link only in the first comment', async () => {
    setWebsiteChannels(websiteId, [fbChannel()]);
    createSocialPosts(seoId);
    await kickSocial(deps());
    const [item] = listSocialPosts();
    expect(item).toMatchObject({ kind: 'facebook', status: 'picture', text: GOOD_FB.text });
    expect(get<{ prompt: string }>('SELECT prompt FROM newsite_pictures WHERE id = ?', item!.picture_id)!.prompt).toMatch(/No words/);
    expect(await makeSocialPictures()).toEqual(['PORTRAIT_3_4']);
    expect(fbPosts).toEqual([{ message: GOOD_FB.text }]);
    expect(comments).toEqual([{ postId: 'page_123', message: POST_URL }]);
    expect(listSocialPosts()[0]).toMatchObject({ status: 'sent', external_id: 'page_123', comment_id: 'c1', post_link: 'https://www.facebook.com/page_123' });
  });

  it('Facebook through Buffer: the link only as Buffer’s first comment on a paid plan, none at all on the free plan', async () => {
    setWebsiteChannels(websiteId, [fbBufferChannel(true)]);
    await share();
    expect(fbPosts).toHaveLength(0);
    expect(bufferPosts[0]!.metadata).toBe(`facebook: { type: post firstComment: ${JSON.stringify(POST_URL)} }`);
    expect(bufferPosts[0]!.text).not.toMatch(/http|longlivo/);

    run('DELETE FROM newsite_social_posts');
    run(`UPDATE newsite_channels SET paid_buffer = 0`);
    bufferPosts = [];
    await share();
    expect(bufferPosts[0]!.metadata).toBe('facebook: { type: post }');
    expect(listSocialPosts()[0]!.error).toMatch(/without the link/);
  });

  it('Instagram through Buffer: its own words with no link, and a 4:5 JPEG copy of its picture, which the media door serves', async () => {
    const ig = saveBufferChannel(
      { platform: 'instagram', name: 'longlivo.kitchen', bufferToken: 'tok', bufferChannelId: 'ch-ig', paidBuffer: false, postImage: true, postReel: true, multiWebsite: false },
      KEY,
    );
    setWebsiteChannels(websiteId, [ig]);
    const copies: string[] = [];
    const igDeps = (): SocialDeps => ({
      ...deps(),
      now: () => Date.now(), // a real clock, so the media link has not expired when it is fetched
      instagramPicture: async (src, out) => {
        copies.push(out);
        writeFileSync(out, 'jpeg-4x5');
      },
    });
    createSocialPosts(seoId);
    await kickSocial(igDeps());
    await kickPictureMaker({
      settings, dataDir, now: () => clock, sleep: async () => {},
      make: async () => ({ data: Buffer.from('pic'), contentType: 'image/png' }),
      afterPin: (id, ok) => onPinPicture(id, ok, igDeps()),
    });
    await kickSocial(igDeps());

    expect(bufferPosts).toHaveLength(1);
    const sent = bufferPosts[0]!;
    expect(sent.channelId).toBe('ch-ig');
    expect(sent.text).toBe(GOOD_IG.text);
    expect(sent.text).not.toMatch(/http|longlivo\.com/);
    expect(sent.metadata).toBe('instagram: { type: post shouldShareToFeed: true }');
    expect(sent.imageUrl).toMatch(/^https:\/\/dash\.example\.com\/media\/ig-picture\/\d+\/\d+\/[A-Za-z0-9_-]+\.jpg$/);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/\.ig\.jpg$/);
    expect(listSocialPosts()[0]).toMatchObject({ kind: 'instagram', status: 'sent', external_id: 'buffer-1' });

    const app = Fastify();
    registerMedia(app, { secret: KEY, clipsDir: dataDir, dataDir });
    const path = new URL(sent.imageUrl).pathname;
    const res = await app.inject({ url: path });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body).toBe('jpeg-4x5');
    expect((await app.inject({ url: path.replace('/ig-picture/', '/picture/') })).statusCode).toBe(404); // signed for the copy only
    await app.close();
  });

  it('Instagram and Threads through their own APIs: the 4:5 copy by its link, the words, and the real post’s address', async () => {
    const ig = saveInstagramApiChannel({ name: 'easycakes', fbToken: 'fbtok', pageId: 'p1', igUserId: 'ig1', postImage: true, postReel: false, multiWebsite: false }, KEY);
    const th = saveThreadsApiChannel({ name: 'easycakes', token: 'old-th', userId: 'th1', expiresAt: Date.now() + 3 * 86_400_000, postImage: true, postReel: false, multiWebsite: false }, KEY);
    setWebsiteChannels(websiteId, [ig, th]);
    answers.Threads = JSON.stringify({ text: 'Real berries in the batter make this cake pink all the way through. Would you bake it this weekend?', alt: 'A tall slice of strawberry cake with whipped cream on a white plate' });
    const igPosts: unknown[] = [];
    const thPosts: { token: string; input: unknown }[] = [];
    const apiDeps = (): SocialDeps => ({
      ...deps(),
      now: () => Date.now(),
      instagramPicture: async (_src, out) => writeFileSync(out, 'jpeg-4x5'),
      instagram: (token) => ({
        publishInstagram: async (input) => {
          igPosts.push({ token, ...input });
          return { mediaId: 'ig-media-1', permalink: 'https://www.instagram.com/p/ABC/' };
        },
      }),
      threads: (token) => ({
        publish: async (input) => {
          thPosts.push({ token, input });
          return { mediaId: 'th-media-1', permalink: 'https://www.threads.net/@easycakes/post/XYZ' };
        },
      }),
      renewThreads: async (token) => ({ token: `${token}-renewed`, expiresAt: Date.now() + 60 * 86_400_000 }),
    });
    createSocialPosts(seoId);
    await kickSocial(apiDeps());
    await kickPictureMaker({
      settings, dataDir, now: () => clock, sleep: async () => {},
      make: async () => ({ data: Buffer.from('pic'), contentType: 'image/png' }),
      afterPin: (id, ok) => onPinPicture(id, ok, apiDeps()),
    });
    await kickSocial(apiDeps());

    expect(bufferPosts).toHaveLength(0);
    expect(igPosts).toEqual([expect.objectContaining({ token: 'fbtok', pageId: 'p1', igUserId: 'ig1', kind: 'image', caption: GOOD_IG.text })]);
    expect((igPosts[0] as { mediaUrl: string }).mediaUrl).toMatch(/\/media\/ig-picture\/\d+\/\d+\/[A-Za-z0-9_-]+\.jpg$/);
    // The Threads token ran out within days: it was renewed first, and the new one saved.
    expect(thPosts[0]!.token).toBe('old-th-renewed');
    expect(thPosts[0]!.input).toMatchObject({ userId: 'th1', kind: 'image' });
    const saved = listChannels().find((c) => c.id === th)!;
    expect(saved.token_expires_at! - Date.now()).toBeGreaterThan(50 * 86_400_000);
    const posts = listSocialPosts();
    expect(posts.find((p) => p.channel_id === ig)).toMatchObject({ status: 'sent', external_id: 'ig-media-1', post_link: 'https://www.instagram.com/p/ABC/' });
    expect(posts.find((p) => p.channel_id === th)).toMatchObject({ status: 'sent', external_id: 'th-media-1', post_link: 'https://www.threads.net/@easycakes/post/XYZ' });
  });

  it('cuts a 3:4 picture to Instagram’s 4:5 as a JPEG', async () => {
    const src = join(dataDir, 'p.png');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=896x1200', '-frames:v', '1', src]);
    const out = join(dataDir, instagramFileOf('p.png'));
    await makeInstagramPicture(src, out);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', out]).toString().trim();
    expect(probe).toBe('mjpeg,896,1120');
  });

  it('YouTube and TikTok take reels only: never an image post, and YouTube gets the title and category Buffer needs', () => {
    const yt = saveBufferChannel({ platform: 'youtube', name: 'Long Livo', bufferToken: 'tok', bufferChannelId: 'ch-yt', paidBuffer: false, postImage: true, postReel: true, multiWebsite: false }, KEY);
    const tt = saveBufferChannel({ platform: 'tiktok', name: 'longlivo', bufferToken: 'tok', bufferChannelId: 'ch-tt', paidBuffer: false, postImage: true, postReel: false, multiWebsite: false }, KEY);
    setWebsiteChannels(websiteId, [yt, tt], new Map([[yt, { image: true, reel: false }]]));
    expect(websiteChannels(websiteId).map((c) => [c.platform, c.post_image, c.post_reel])).toEqual([['tiktok', 0, 1], ['youtube', 0, 1]]);
    expect(createSocialPosts(seoId)).toBe(0);
    expect(bufferMetadata('youtube', { title: 'Strawberry Cake in 10 Seconds', url: POST_URL, firstComment: '', type: 'reel' })).toBe('youtube: { title: "Strawberry Cake in 10 Seconds" categoryId: "26" }');
    expect(bufferMetadata('tiktok', { title: 'x', url: POST_URL, firstComment: '', type: 'reel' })).toBe('');
    for (const p of ['youtube', 'tiktok', 'threads', 'linkedin', 'x']) expect(loadPlatformRules(p).platform).toBe(p);
  });

  it('makes no image post for a page set to post reels only', () => {
    setWebsiteChannels(websiteId, [fbChannel(false)]);
    expect(createSocialPosts(seoId)).toBe(0);
  });

  /* -- Rules files ---------------------------------------------------------- */

  it('finds every rules file by itself and checks it', () => {
    const found = listPlatformRules();
    expect(found.map((r) => r.platform)).toEqual(expect.arrayContaining(['facebook', 'pinterest']));
    expect(found.every((r) => r.errors.length === 0)).toBe(true);
    expect(loadPlatformRules('pinterest')).toMatchObject({ postText: 'description', pictureShape: 'PORTRAIT_3_4', link: 'pin_link' });
  });

  it('says exactly what is wrong with a broken rules file', () => {
    const bad = parseRules(
      'pinterest',
      '---\nplatform: pinterst\nfields: title\npost_text: description\npicture_shape: SQUARE\npicture_templates: nope.txt\nlink: sometimes\n---\nRules.\n\n## Limits\n\n- body_chars: 10-5\n',
    );
    expect(bad.rules).toBeNull();
    const all = bad.errors.join(' | ');
    expect(all).toMatch(/platform "pinterst" but the file is named pinterest\.md/);
    expect(all).toMatch(/post_text "description" is not one of the fields/);
    expect(all).toMatch(/picture_shape must be one of/);
    expect(all).toMatch(/Picture template "nope\.txt" is not in the prompts folder/);
    expect(all).toMatch(/link must be one of/);
    expect(all).toMatch(/Limit "body_chars" is not/);
    expect(parseRules('x', 'no header').errors[0]).toMatch(/must start with a header/);
  });

  it('checks a post against the numbers in its rules file', () => {
    const rules = loadPlatformRules('pinterest');
    expect(checkFields(GOOD_PIN, rules, 'f.longlivo.com')).toEqual([]);
    const tight = { ...rules, limits: { ...rules.limits, title_chars: [10, 20] as [number, number] } };
    expect(checkFields(GOOD_PIN, tight, 'f.longlivo.com').join(' ')).toMatch(/title has 59 characters; write 10 to 20/);
    expect(checkFields({ ...GOOD_PIN, title: `${GOOD_PIN.title}!` }, rules, '').join(' ')).toMatch(/title has 1 exclamation marks; it must have none/);
  });

  describe('each channel’s own rules', () => {
    it('a channel starts with its platform’s rules as its own copy, and a saved edit is used from its next post', async () => {
      const pin = pinChannel();
      const c = listChannels().find((x) => x.id === pin)!;
      expect(c.rules_text).toContain('# Pinterest rules');
      const edited = c.rules_text.replace('- title_chars: 40-100', '- title_chars: 40-50').replace('# Pinterest rules', '# Pinterest rules\n\nAlways mention the season.');
      expect(saveChannelRules(pin, edited)).toEqual([]);
      setWebsiteChannels(websiteId, [pin]);
      createSocialPosts(seoId);
      await kickSocial(deps());
      const first = asked.find((a) => a.name === 'newsite-social-post')!;
      expect(String(first.vars.platformRules)).toContain('Always mention the season.');
      // The saved limit is the one checked: the 59-character title is sent back.
      const second = asked.filter((a) => a.name === 'newsite-social-post')[1];
      expect(String(second?.vars.problemsJson)).toMatch(/title has 59 characters; write 40 to 50/);
    });

    it('one channel’s rules never change another’s', () => {
      const pin = pinChannel();
      const fb = fbChannel();
      const fbBefore = listChannels().find((x) => x.id === fb)!.rules_text;
      const pinText = listChannels().find((x) => x.id === pin)!.rules_text;
      expect(saveChannelRules(pin, pinText.replace('# Pinterest rules', '# Pinterest rules\n\nOnly for this pin channel.'))).toEqual([]);
      expect(listChannels().find((x) => x.id === fb)!.rules_text).toBe(fbBefore);
      const second = saveBufferChannel(
        { platform: 'pinterest', name: 'other', bufferToken: 'tok', bufferChannelId: 'ch-pin-2', paidBuffer: false, postImage: true, postReel: false, multiWebsite: false },
        KEY,
      );
      expect(listChannels().find((x) => x.id === second)!.rules_text).not.toContain('Only for this pin channel.');
    });

    it('refuses to save rules with problems, and says what they are', () => {
      const pin = pinChannel();
      const before = listChannels().find((x) => x.id === pin)!.rules_text;
      const problems = saveChannelRules(pin, before.replace('post_text: description', 'post_text: body'));
      expect(problems.join(' ')).toMatch(/post_text "body" is not one of the fields/);
      expect(listChannels().find((x) => x.id === pin)!.rules_text).toBe(before);
    });

    it('a channel whose saved rules are broken fails its posts with the reason', async () => {
      const pin = pinChannel();
      run(`UPDATE newsite_channels SET rules_text = ? WHERE id = ?`, '---\nplatform: pinterest\n---\nRules.\n', pin);
      setWebsiteChannels(websiteId, [pin]);
      createSocialPosts(seoId);
      await kickSocial(deps());
      expect(listSocialPosts()[0]!.status).toBe('failed');
      expect(listSocialPosts()[0]!.error).toMatch(/rules of channel “longlivo” have problems \(open the channel and click Edit rules\): .*needs "fields:"/);
    });

    it('a channel on a platform with no default starts with starter rules it can edit', () => {
      const ch = saveBufferChannel(
        { platform: 'bluesky', name: 'longlivo sky', bufferToken: 'tok', bufferChannelId: 'ch-sky', paidBuffer: false, postImage: true, postReel: false, multiWebsite: false },
        KEY,
      );
      const c = listChannels().find((x) => x.id === ch)!;
      expect(c.rules_text).toContain('platform: bluesky');
      expect(c.rules_text).toContain('# Bluesky rules');
      expect(saveChannelRules(ch, c.rules_text)).toEqual([]);
    });
  });

  describe('with an edited prompts folder', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'prompts-'));
      cpSync(PROMPTS, dir, { recursive: true });
      configurePrompts(dir);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('a new rules file connects a new platform to the Sharing phase', async () => {
      writeFileSync(join(dir, 'newsite-threads-1.template.txt'), 'A wide photo of {{scene}} with no words.');
      writeFileSync(
        join(dir, 'platforms', 'threads.md'),
        '---\nplatform: threads\nlabel: Threads\npost_label: Thread\nfields: text, alt\npost_text: text\nalt_field: alt\npicture_shape: HORIZONTAL\npicture_templates: newsite-threads-1.template.txt\nlink: none\n---\n# Threads rules\n\nShort and friendly.\n\n## Limits\n\n- text_chars: 20-500\n',
      );
      expect(listPlatformRules().map((r) => r.platform)).toContain('threads');
      answers.Threads = JSON.stringify({ text: 'A soft strawberry cake with real berries in every bite.', alt: 'A slice of strawberry cake on a plate' });
      const ch = saveBufferChannel(
        { platform: 'threads', name: 'longlivo threads', bufferToken: 'tok', bufferChannelId: 'ch-threads', paidBuffer: false, postImage: true, postReel: false, multiWebsite: false },
        KEY,
      );
      setWebsiteChannels(websiteId, [ch]);
      createSocialPosts(seoId);
      await kickSocial(deps());
      expect(await makeSocialPictures()).toEqual(['HORIZONTAL']);
      expect(bufferPosts).toHaveLength(1);
      expect(bufferPosts[0]).toMatchObject({ channelId: 'ch-threads', text: 'A soft strawberry cake with real berries in every bite.', metadata: '' });
      expect(listSocialPosts()[0]).toMatchObject({ kind: 'threads', status: 'sent' });
    });
  });

  /* -- The Share step -------------------------------------------------------- */

  describe('the Share step of a keyword plan', () => {
    const planIdOf = () => get<{ plan_id: number }>('SELECT plan_id FROM keyword_seo WHERE id = ?', seoId)!.plan_id;
    /** The website's Sharing page, then every one of its channels' pages (posts and problems). */
    const page = async () => {
      const a = await app();
      const urls = [`/new-website/sharing/site/${websiteId}`];
      for (const c of websiteChannels(websiteId)) {
        urls.push(`/new-website/sharing/site/${websiteId}/channel/${c.id}?tab=posts`, `/new-website/sharing/site/${websiteId}/channel/${c.id}?tab=problems`);
      }
      const bodies = await Promise.all(urls.map((url) => a.inject({ url })));
      return bodies.map((b) => b.body).join(' ');
    };
    const app = async () => {
      const a = Fastify();
      await a.register(formbody);
      registerSocialRoutes(a, { ...deps(), readFlash: () => null, autoStart: false });
      return a;
    };

    it('says when the website shares on no channel, with where to pick or add one', async () => {
      const out = await page();
      expect(out).toContain('Long Livo shares on no channel yet.');
      expect(out).toContain(`/new-website/${websiteId}/edit?section=4`);
      expect(out).toContain('<a href="/new-website/sharing">Social posts</a>');
    });

    it('offers Share now for a published article not on its channels yet, and shares it', async () => {
      setWebsiteChannels(websiteId, [pinChannel(), fbChannel()]);
      expect(await page()).toContain('Share now');
      const res = await (await app()).inject({ method: 'POST', url: `/new-website/keywords/share/${seoId}` });
      expect(res.headers.location).toMatch(/sharing\/site\/\d+\?ok=.*2%20channels/);
      expect(listPlanSocialPosts(planIdOf())).toHaveLength(2);
      expect(await page()).not.toContain('Share now');
    });

    it('shows what each channel made, and Queued in Buffer with Buffer’s time once Buffer took it', async () => {
      setWebsiteChannels(websiteId, [pinChannel()]);
      await share();
      const out = await page();
      expect(out).toContain('Queued in Buffer');
      expect(out).toContain('Buffer posts it 2026-10-14 09:30 UTC');
      expect(out).toContain(GOOD_PIN.title);
      expect(out).toContain('Call to action');
    });

    it('shows and sends a pin made before each field was kept on its own', async () => {
      setWebsiteChannels(websiteId, [pinChannel()]);
      createSocialPosts(seoId);
      const [post] = listSocialPosts();
      // As the earlier version left it: words in title/text/alt/overlay, its picture made, then failed.
      run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, file) VALUES (?, ?, 1000, 'p', 'a', 'done', 'pin.png')`, seoId, `pin-${post!.id}`);
      const pictureId = get<{ id: number }>('SELECT id FROM newsite_pictures WHERE slot = ?', `pin-${post!.id}`)!.id;
      run(
        `UPDATE newsite_social_posts SET status = 'failed', error = 'no address', title = ?, text = ?, alt = ?, overlay = ?, picture_id = ? WHERE id = ?`,
        GOOD_PIN.title, GOOD_PIN.description, GOOD_PIN.alt, JSON.stringify({ headline: GOOD_PIN.headline, cta: GOOD_PIN.cta }), pictureId, post!.id,
      );
      const out = await page();
      expect(out).toContain(GOOD_PIN.title);
      expect(out).toContain(GOOD_PIN.headline);
      expect(out).not.toContain('Its words are being written');
      const res = await (await app()).inject({ method: 'POST', url: `/new-website/keywords/share/post/${post!.id}/retry` });
      expect(res.headers.location).toMatch(/sharing\/site\/\d+\?ok=/);
      await kickSocial(deps());
      expect(asked.filter((x) => x.name === 'newsite-social-post')).toHaveLength(0); // its words are kept
      expect(bufferPosts[0]).toMatchObject({ text: GOOD_PIN.description, altText: GOOD_PIN.alt });
      expect(bufferPosts[0]!.metadata).toContain(JSON.stringify(GOOD_PIN.title));
      expect(getSocialPost(post!.id)!.status).toBe('sent');
    });

    it('is the Social posts page, after set up and create in the menu, with a Share articles wizard', async () => {
      setWebsiteChannels(websiteId, [pinChannel()]);
      const a = await app();
      const out = (await a.inject({ url: '/new-website/sharing' })).body;
      expect(out).toMatch(/Social channels<\/span>[\s\S]*Keywords &amp; articles<\/span>[\s\S]*Reels<\/span>[\s\S]*Social posts<\/span>/);
      expect(out).not.toContain('Shared content');
      expect(out).toContain('href="/new-website/sharing/new"');
      expect((await a.inject({ url: '/new-website/shared' })).headers.location).toBe('/new-website/sharing');
      const step2 = (await a.inject({ url: `/new-website/sharing/new/articles?website=${websiteId}` })).body;
      expect(step2).toContain('Step 2 of 2: Articles');
      expect(step2).toContain(`name="seo" value="${seoId}"`);
      const res = await a.inject({
        method: 'POST', url: '/new-website/sharing/share',
        payload: `websiteId=${websiteId}&seo=${seoId}`, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.headers.location).toMatch(new RegExp(`sharing/site/${websiteId}\\?ok=Sharing%201%20post`));
      expect(listPlanSocialPosts(planIdOf())).toHaveLength(1);
    });

    it('puts a failed post back to work', async () => {
      setWebsiteChannels(websiteId, [fbChannel()]);
      createSocialPosts(seoId);
      const [post] = listSocialPosts();
      run(`UPDATE newsite_social_posts SET status = 'failed', error = 'Facebook said no.' WHERE id = ?`, post!.id);
      expect(await page()).toContain('Facebook said no.');
      const res = await (await app()).inject({ method: 'POST', url: `/new-website/keywords/share/post/${post!.id}/retry` });
      expect(res.headers.location).toMatch(/sharing\/site\/\d+\?ok=/);
      expect(getSocialPost(post!.id)!.status).not.toBe('failed');
    });

    it('shows a rules file and its problems on its page', async () => {
      const res = await (await app()).inject({ url: '/new-website/channels/rules/pinterest' });
      expect(res.body).toContain('This rules file is valid');
      expect(res.body).toContain('headline, cta, title, description, alt');
      const missing = await (await app()).inject({ url: '/new-website/channels/rules/mastodon' });
      expect(missing.body).toContain('There is no rules file for mastodon');
    });
  });
});

describe('The Buffer call itself', () => {
  afterEach(() => vi.unstubAllGlobals());

  const answer = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

  it('sends the image, its alt text and the service metadata, and returns Buffer’s post id and time', async () => {
    answer({ data: { createPost: { post: { id: 'p-1', dueAt: '2026-10-14T09:30:00.000Z' } } } });
    const out = await new BufferClient('tok').createImagePost({
      text: 'Words',
      channelId: 'ch-pin',
      imageUrl: 'https://dash.example.com/media/picture/1/2/sig.png',
      altText: 'A cake',
      metadata: 'pinterest: { title: "T" url: "https://x.com/a" boardServiceId: "b2" }',
    });
    expect(out).toEqual({ id: 'p-1', dueAt: '2026-10-14T09:30:00.000Z' });
    const call = (fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0]!;
    const sent = JSON.parse(call[1].body) as { query: string };
    expect(sent.query).toContain('channelId: "ch-pin"');
    expect(sent.query).toContain('url: "https://dash.example.com/media/picture/1/2/sig.png"');
    expect(sent.query).toContain('altText: "A cake"');
    expect(sent.query).toContain('pinterest: { title: "T" url: "https://x.com/a" boardServiceId: "b2" }');
    expect(sent.query).not.toContain('animatedThumbnail');
  });

  it('throws on Buffer’s error, and on any answer without a post id', async () => {
    answer({ data: { createPost: { message: 'Invalid post: Image could not be read from its URL' } } });
    await expect(new BufferClient('tok').createImagePost({ text: 't', channelId: 'c', imageUrl: 'u', altText: 'a', metadata: '' })).rejects.toThrow(/Image could not be read/);
    answer({ data: { createPost: {} } });
    await expect(new BufferClient('tok').createImagePost({ text: 't', channelId: 'c', imageUrl: 'u', altText: 'a', metadata: '' })).rejects.toThrow(/did not confirm/);
  });
});
