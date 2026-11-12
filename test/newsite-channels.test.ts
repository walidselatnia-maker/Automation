import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { registerChannelRoutes, type ChannelLookups } from '../src/newsite/channels-routes.js';
import { bufferTokenOf, channelBoards, channelsFor, fbTokenOf, getChannel, listChannels, saveBufferChannel, setChannelWebsiteCategories, setWebsiteChannels, websiteChannels } from '../src/newsite/channels.js';
import { createNewWebsite } from '../src/newsite/repo.js';

const KEY = randomBytes(32);
const BUFFER_TOKEN = 'buffer-secret-token-123';
const FB_TOKEN = 'fb-secret-token-456';
const THREADS_TOKEN = 'threads-secret-token-789';

const lookups: ChannelLookups = {
  bufferChannels: async (token) => {
    if (token !== BUFFER_TOKEN) throw new Error('Buffer HTTP 401: unauthorized');
    return [
      { id: 'ch-pin', name: 'longlivo', service: 'pinterest', boards: [{ serviceId: 'b1', name: 'Cakes' }, { serviceId: 'b2', name: 'Cookies' }] },
      { id: 'ch-fb', name: 'Long Livo page', service: 'facebook', boards: [] },
    ];
  },
  facebookPages: async (token) => {
    if (token !== FB_TOKEN) throw new Error('Listing pages failed: Invalid OAuth access token');
    return [{ id: 'p1', name: 'Easy Cakes' }, { id: 'p2', name: 'Cookie Corner' }];
  },
  facebookPageCheck: async (_token, pageId) => {
    if (pageId === 'p2') throw new Error('Page p2 returned no access token');
  },
  instagramAccounts: async (token) => {
    if (token !== FB_TOKEN) throw new Error('Listing Instagram accounts failed: Invalid OAuth access token');
    return [{ pageId: 'p1', pageName: 'Easy Cakes', igUserId: 'ig1', username: 'easycakes' }];
  },
  threadsProfile: async (token) => {
    if (token !== THREADS_TOKEN) throw new Error('Reading the Threads profile failed: Invalid OAuth access token');
    return { id: 'th1', username: 'easycakes' };
  },
};

const form = (fields: Record<string, string | string[]>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) p.append(k, x);
  return p.toString();
};

describe('New dashboard: channels', () => {
  const app = async () => {
    const a = Fastify();
    await a.register(formbody);
    registerChannelRoutes(a, { encryptionKey: KEY, readFlash: () => null, lookups });
    return a;
  };
  const post = async (a: Awaited<ReturnType<typeof app>>, url: string, fields: Record<string, string | string[]>) =>
    a.inject({ method: 'POST', url, payload: form(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const draftIn = (body: string): string => body.match(/name="draft" value="([0-9a-f]+)"/)![1]!;

  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  const site = (name: string, domain: string) =>
    createNewWebsite(
      {
        name, domain, apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '', persona: 'Storyteller', status: 'active',
        autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );

  it('sets a Buffer channel to get its first comment through the Facebook Graph API', async () => {
    const a = await app();
    const fb = saveBufferChannel({ platform: 'facebook', name: 'Cookie Corner', bufferToken: BUFFER_TOKEN, bufferChannelId: 'ch-fb', paidBuffer: false, postImage: true, postReel: true, multiWebsite: false }, KEY);
    const ig = saveBufferChannel({ platform: 'instagram', name: 'easycakes', bufferToken: BUFFER_TOKEN, bufferChannelId: 'ch-ig', paidBuffer: false, postImage: true, postReel: true, multiWebsite: false }, KEY);

    const card = (await a.inject({ url: `/new-website/channels/${fb}` })).body;
    expect(card).toContain('First comment through the API');
    expect(card).toContain(`href="/new-website/channels/${fb}/edit/comment"`);
    expect(card).toContain('Not set up');

    expect((await a.inject({ url: `/new-website/channels/${fb}/edit/comment` })).body).toContain('pages_manage_engagement');
    expect((await post(a, `/new-website/channels/${fb}/edit/comment`, { token: 'wrong' })).body).toContain('Facebook did not accept this token');
    // The page Buffer calls this channel by is picked to start with.
    const pick = (await post(a, `/new-website/channels/${fb}/edit/comment`, { token: FB_TOKEN })).body;
    expect(pick).toMatch(/value="p2" checked/);
    const saved = await post(a, `/new-website/channels/${fb}/edit/comment`, { draft: draftIn(pick), pick: 'p2' });
    expect(saved.statusCode).toBe(303);
    expect(getChannel(fb)).toMatchObject({ via: 'buffer', fb_page_id: 'p2', api_account_id: '' });
    expect(fbTokenOf(getChannel(fb)!, KEY)).toBe(FB_TOKEN);
    expect((await a.inject({ url: `/new-website/channels/${fb}` })).body).toContain('Commented through the Facebook Graph API once Buffer has posted (as the page)');

    // Instagram: the token already saved is used when none is pasted; the account linked to a page is picked.
    expect((await a.inject({ url: `/new-website/channels/${ig}/edit/comment` })).body).toContain('Leave it empty to use the token already saved.');
    const igPick = (await post(a, `/new-website/channels/${ig}/edit/comment`, { token: '' })).body;
    expect(igPick).toMatch(/value="p1:ig1" checked/);
    await post(a, `/new-website/channels/${ig}/edit/comment`, { draft: draftIn(igPick), pick: 'p1:ig1' });
    expect(getChannel(ig)).toMatchObject({ fb_page_id: 'p1', api_account_id: 'ig1' });

    // And off again.
    await post(a, `/new-website/channels/${ig}/edit/comment`, { off: '1' });
    expect(getChannel(ig)).toMatchObject({ fb_token_enc: '', fb_page_id: '', api_account_id: '' });
    await a.close();
  });

  it('adds Instagram through the Facebook page’s API, and Threads through its own API', async () => {
    const a = await app();
    const one = site('Long Livo', 'f.longlivo.com');
    for (const platform of ['instagram', 'threads']) {
      const via = (await post(a, '/new-website/channels/add', { platform })).body;
      expect(via).toContain('value="api"');
    }

    // Instagram: the accounts linked to the token's pages.
    const igPick = await post(a, '/new-website/channels/instagram/api/connect', { token: FB_TOKEN });
    expect(igPick.body).toContain('easycakes');
    expect(igPick.body).toContain('Instagram of the page Easy Cakes');
    let draft = draftIn(igPick.body);
    const igCheck = await post(a, '/new-website/channels/instagram/api/pick', { draft, pick: 'p1:ig1' });
    expect(igCheck.body).toContain('easycakes: connected.');
    await post(a, '/new-website/channels/instagram/api/checked', { draft });
    await post(a, '/new-website/channels/instagram/api/what', { draft, postImage: '1', postReel: '1' });
    await post(a, '/new-website/channels/instagram/api/save', { draft, websiteId: String(one) });
    const ig = listChannels().find((c) => c.platform === 'instagram')!;
    expect(ig).toMatchObject({ via: 'api', name: 'easycakes', fb_page_id: 'p1', api_account_id: 'ig1', post_image: 1, post_reel: 1 });
    expect(fbTokenOf(ig, KEY)).toBe(FB_TOKEN);

    // Threads: its own token, the one profile it belongs to, counted on for a while before its first renewal.
    expect((await post(a, '/new-website/channels/threads/api/connect', { token: 'wrong' })).body).toContain('Threads did not accept this token');
    const thPick = await post(a, '/new-website/channels/threads/api/connect', { token: THREADS_TOKEN });
    expect(thPick.body).toContain('Your Threads profile');
    draft = draftIn(thPick.body);
    expect((await post(a, '/new-website/channels/threads/api/pick', { draft, pick: 'th1' })).body).toContain('easycakes: connected.');
    await post(a, '/new-website/channels/threads/api/checked', { draft });
    await post(a, '/new-website/channels/threads/api/what', { draft, postImage: '1' });
    await post(a, '/new-website/channels/threads/api/save', { draft, websiteId: String(one) });
    const th = listChannels().find((c) => c.platform === 'threads')!;
    expect(th).toMatchObject({ via: 'api', name: 'easycakes', api_account_id: 'th1', post_image: 1 });
    expect(fbTokenOf(th, KEY)).toBe(THREADS_TOKEN);
    expect(th.token_expires_at! - Date.now()).toBeGreaterThan(20 * 86_400_000);

    const card = (await a.inject({ url: `/new-website/channels/${th.id}?check=1` })).body;
    expect((await a.inject({ url: `/new-website/channels/${th.id}` })).body).toContain('The Threads API');
    expect(card).toContain('Connected. Threads answers as @easycakes.');
    expect((await a.inject({ url: `/new-website/channels/${ig.id}?check=1` })).body).toContain('linked to the page Easy Cakes');
    await a.close();
  });

  it('adds channels through one wizard: Add channel, the platform, then how it posts', async () => {
    const a = await app();
    const empty = await a.inject({ url: '/new-website/channels' });
    expect(empty.body).toContain('No channels yet');
    expect(empty.body).toContain('href="/new-website/channels/add"');

    const platforms = await a.inject({ url: '/new-website/channels/add' });
    expect(platforms.body).toContain('Step 1 of 2: Platform');
    for (const name of ['Pinterest', 'Facebook', 'Instagram']) expect(platforms.body).toContain(`<b>${name}</b>`);

    // Pinterest posts through Buffer only: straight to its own wizard.
    const pin = await post(a, '/new-website/channels/add', { platform: 'pinterest' });
    expect(pin.headers.location).toBe('/new-website/channels/pinterest/buffer/new');
    // Facebook: Buffer or the API, then its wizard.
    const fb = await post(a, '/new-website/channels/add', { platform: 'facebook' });
    expect(fb.body).toContain('Step 2 of 2: How it posts');
    expect((await post(a, '/new-website/channels/add/via', { platform: 'facebook', via: 'api' })).headers.location).toBe('/new-website/channels/facebook/api/new');
    expect((await post(a, '/new-website/channels/add/via', { platform: 'pinterest', via: 'api' })).headers.location).toBe('/new-website/channels/add');
    expect((await a.inject({ url: '/new-website/channels/pinterest/api/new' })).statusCode).toBe(303);
  });

  it('adds a Pinterest channel through Buffer: token, channel, what to post, websites, then the check', async () => {
    const a = await app();
    const one = site('One', 'one.example.com');
    const two = site('Two', 'two.example.com');
    const bad = await post(a, '/new-website/channels/pinterest/buffer/connect', { token: 'nope' });
    expect(bad.body).toContain('Buffer did not accept this token');

    const pick = await post(a, '/new-website/channels/pinterest/buffer/connect', { token: BUFFER_TOKEN });
    expect(pick.body).toContain('longlivo');
    expect(pick.body).toContain('2 boards');
    expect(pick.body).not.toContain('Long Livo page'); // only Pinterest channels
    expect(pick.body).not.toContain(BUFFER_TOKEN); // the token never goes back into a page
    const draft = draftIn(pick.body);

    const what = await post(a, '/new-website/channels/pinterest/buffer/pick', { draft, pick: 'ch-pin' });
    expect(what.body).toContain('Step 3 of 5: What to post'); // Pinterest takes reels as video pins
    const websites = await post(a, '/new-website/channels/pinterest/buffer/what', { draft, postImage: '1', postReel: '1' });
    expect(websites.body).toContain('Step 4 of 5: Websites');
    expect(websites.body).toContain('one.example.com');
    expect(websites.body).toContain('Connect this channel to multiple websites');

    const both = await post(a, '/new-website/channels/pinterest/buffer/save', { draft, websiteId: [String(one), String(two)] });
    expect(both.body).toContain('You picked more than one website');
    expect(listChannels()).toHaveLength(0);

    const saved = await post(a, '/new-website/channels/pinterest/buffer/save', { draft, websiteId: String(one) });
    expect(saved.statusCode).toBe(303);
    const [c] = listChannels();
    expect(c).toMatchObject({ platform: 'pinterest', via: 'buffer', name: 'longlivo', buffer_channel_id: 'ch-pin', multi_website: 0, post_image: 1, post_reel: 1 });
    expect(c!.buffer_token_enc).not.toContain(BUFFER_TOKEN);
    expect(bufferTokenOf(c!, KEY)).toBe(BUFFER_TOKEN);
    expect(channelBoards(c!)).toEqual([{ serviceId: 'b1', name: 'Cakes' }, { serviceId: 'b2', name: 'Cookies' }]);
    expect(websiteChannels(one).map((x) => x.id)).toEqual([c!.id]);

    const checked = await a.inject({ url: saved.headers.location as string });
    expect(checked.body).toContain('Connected. Buffer answers, with 2 boards');
  });

  it('adds Facebook pages through the API: token, pages, check, what to post, websites; no Buffer in it', async () => {
    const a = await app();
    const one = site('One', 'one.example.com');
    const pick = await post(a, '/new-website/channels/facebook/api/connect', { token: FB_TOKEN });
    expect(pick.body).toContain('Easy Cakes');
    expect(pick.body).not.toContain(FB_TOKEN);
    const draft = draftIn(pick.body);

    const check = await post(a, '/new-website/channels/facebook/api/pick', { draft, pick: ['p1', 'p2'] });
    expect(check.body).toContain('Easy Cakes: connected.');
    expect(check.body).toContain('Cookie Corner: Page p2 returned no access token');

    const only = await post(a, '/new-website/channels/facebook/api/pick', { draft, pick: 'p1' });
    expect(only.body).toContain('Easy Cakes: connected.');
    expect(only.body).not.toContain('Buffer');

    const what = await post(a, '/new-website/channels/facebook/api/checked', { draft });
    expect(what.body).toContain('Image post');
    expect(what.body).toContain('Reel');
    expect(what.body).not.toContain('paid Buffer plan');

    const none = await post(a, '/new-website/channels/facebook/api/what', { draft });
    expect(none.body).toContain('Pick what to post');
    const websites = await post(a, '/new-website/channels/facebook/api/what', { draft, postImage: '1' });
    expect(websites.body).toContain('Step 5 of 5: Websites');

    const saved = await post(a, '/new-website/channels/facebook/api/save', { draft, websiteId: String(one), multiWebsite: '1' });
    expect(saved.statusCode).toBe(303);
    const [c] = listChannels();
    expect(c).toMatchObject({ platform: 'facebook', via: 'api', name: 'Easy Cakes', fb_page_id: 'p1', post_image: 1, post_reel: 0, paid_buffer: 0, multi_website: 1 });
    expect(fbTokenOf(c!, KEY)).toBe(FB_TOKEN);
    expect(websiteChannels(one)).toHaveLength(1);
  });

  it('adds a Facebook page through Buffer: token, pages, Buffer plan with its red warning, what to post, websites', async () => {
    const a = await app();
    const pick = await post(a, '/new-website/channels/facebook/buffer/connect', { token: BUFFER_TOKEN });
    expect(pick.body).toContain('Long Livo page');
    expect(pick.body).not.toContain('<b>longlivo</b>'); // only Facebook channels from Buffer
    const draft = draftIn(pick.body);

    const plan = await post(a, '/new-website/channels/facebook/buffer/pick', { draft, pick: 'ch-fb' });
    expect(plan.body).toContain('I have a paid Buffer plan (first comment unlocked)');
    expect(plan.body).toMatch(/class="ch-warn"[^>]*>Buffer’s free plan cannot add a first comment/);

    const what = await post(a, '/new-website/channels/facebook/buffer/plan', { draft, paidBuffer: '1' });
    expect(what.body).toContain('Image post');
    await post(a, '/new-website/channels/facebook/buffer/what', { draft, postImage: '1' });
    const saved = await post(a, '/new-website/channels/facebook/buffer/save', { draft });
    expect(saved.headers.location).toMatch(/check=1/);
    const [c] = listChannels();
    expect(c).toMatchObject({ platform: 'facebook', via: 'buffer', buffer_channel_id: 'ch-fb', paid_buffer: 1, post_image: 1, fb_token_enc: '' });
    const checked = await a.inject({ url: saved.headers.location as string });
    expect(checked.body).toContain('Connected. Buffer answers and lists this page.');
  });

  /** A Pinterest channel added through its wizard. */
  const addPin = async (a: Awaited<ReturnType<typeof app>>): Promise<number> => {
    const pick = await post(a, '/new-website/channels/pinterest/buffer/connect', { token: BUFFER_TOKEN });
    const draft = draftIn(pick.body);
    await post(a, '/new-website/channels/pinterest/buffer/pick', { draft, pick: 'ch-pin' });
    await post(a, '/new-website/channels/pinterest/buffer/what', { draft, postImage: '1' });
    await post(a, '/new-website/channels/pinterest/buffer/save', { draft });
    return listChannels()[0]!.id;
  };

  it('shows each channel as a card of parts, each with one Change button', async () => {
    const a = await app();
    const id = await addPin(a);
    const list = await a.inject({ url: '/new-website/channels' });
    // Pinterest takes reels, so it has a What to post part too.
    for (const part of ['connection', 'websites', 'posts', 'rules']) expect(list.body).toContain(`href="/new-website/channels/${id}/edit/${part}"`);
    expect(list.body).toContain('Rules OK');
    expect(list.body).toContain('href="/new-website/channels/add">Add channel</a>');
  });

  it('changes the rules alone, in the wizard frame: the text, then Save', async () => {
    const a = await app();
    const id = await addPin(a);
    const editor = await a.inject({ url: `/new-website/channels/${id}/edit/rules` });
    expect(editor.body).toContain('<textarea id="ch-rules-text" name="rules"');
    expect(editor.body).toContain('# Pinterest rules');
    expect(editor.body).toContain('Only this part changes.');

    const text = getChannel(id)!.rules_text.replace('# Pinterest rules', '# Pinterest rules\n\nWrite for busy parents.');
    const saved = await post(a, `/new-website/channels/${id}/edit/rules`, { rules: text });
    expect(saved.headers.location).toMatch(/ok=Rules%20saved/);
    expect(getChannel(id)!.rules_text).toContain('Write for busy parents.');

    const bad = await post(a, `/new-website/channels/${id}/edit/rules`, { rules: text.replace('link: pin_link', 'link: sometimes') });
    expect(bad.statusCode).toBe(200);
    expect(bad.body).toContain('Not saved. Fix this and save again');
    expect(bad.body).toContain('link must be one of');
    expect(bad.body).toContain('link: sometimes'); // the text is kept in the box
    expect(getChannel(id)!.rules_text).toContain('link: pin_link');

    await post(a, `/new-website/channels/${id}/edit/rules`, { rules: 'anything', reset: '1' });
    expect(getChannel(id)!.rules_text).not.toContain('Write for busy parents.');
  });

  it('changes the websites alone, in the wizard frame', async () => {
    const a = await app();
    const one = site('One', 'one.example.com');
    const two = site('Two', 'two.example.com');
    const id = await addPin(a);

    const part = await a.inject({ url: `/new-website/channels/${id}/edit/websites` });
    expect(part.body).toContain('one.example.com');
    const refused = await post(a, `/new-website/channels/${id}/edit/websites`, { websiteId: [String(one), String(two)] });
    expect(refused.statusCode).toBe(200);
    expect(refused.body).toContain('You picked more than one website');
    await post(a, `/new-website/channels/${id}/edit/websites`, { websiteId: [String(one), String(two)], multiWebsite: '1' });
    expect(websiteChannels(one)).toHaveLength(1);
    expect(websiteChannels(two)).toHaveLength(1);

    const check = await a.inject({ url: `/new-website/channels/${id}/edit/connection` });
    expect(check.body).toContain('Connected. Buffer answers, with 2 boards');
  });

  it('lets a single-website channel belong to one website only', async () => {
    const a = await app();
    const pick = await post(a, '/new-website/channels/pinterest/buffer/connect', { token: BUFFER_TOKEN });
    const draft = draftIn(pick.body);
    await post(a, '/new-website/channels/pinterest/buffer/pick', { draft, pick: 'ch-pin' });
    await post(a, '/new-website/channels/pinterest/buffer/what', { draft, postImage: '1' });
    await post(a, '/new-website/channels/pinterest/buffer/save', { draft });
    const channelId = listChannels()[0]!.id;
    const one = site('One', 'one.example.com');
    const two = site('Two', 'two.example.com');

    expect(setWebsiteChannels(one, [channelId])).toEqual([]);
    expect(websiteChannels(one).map((c) => c.id)).toEqual([channelId]);
    // Taken: the second website does not even see it, and cannot take it.
    expect(channelsFor(two)).toEqual([]);
    expect(setWebsiteChannels(two, [channelId])[0]).toMatch(/already used by another website/);

    // Set to multiple websites: both may use it.
    await post(a, `/new-website/channels/${channelId}/edit/websites`, { multiWebsite: '1', websiteId: String(one) });
    expect(getChannel(channelId)!.multi_website).toBe(1);
    expect(setWebsiteChannels(two, [channelId])).toEqual([]);
    expect(websiteChannels(two)).toHaveLength(1);
  });

  it('organizes channels by website, showing each website with its connected channels', async () => {
    const a = await app();
    const siteA = site('Website A', 'website-a.com');
    const siteB = site('Website B', 'website-b.com');

    // Add a Pinterest channel for Website A
    const pickPin = await post(a, '/new-website/channels/pinterest/buffer/connect', { token: BUFFER_TOKEN });
    const draftPin = draftIn(pickPin.body);
    await post(a, '/new-website/channels/pinterest/buffer/pick', { draft: draftPin, pick: 'ch-pin' });
    await post(a, '/new-website/channels/pinterest/buffer/what', { draft: draftPin, postImage: '1' });
    await post(a, '/new-website/channels/pinterest/buffer/save', { draft: draftPin, websiteId: String(siteA) });

    // Add a Facebook page for Website B through API
    const pickFb = await post(a, '/new-website/channels/facebook/api/connect', { token: FB_TOKEN });
    const draftFb = draftIn(pickFb.body);
    await post(a, '/new-website/channels/facebook/api/pick', { draft: draftFb, pick: 'p1' });
    await post(a, '/new-website/channels/facebook/api/checked', { draft: draftFb });
    await post(a, '/new-website/channels/facebook/api/what', { draft: draftFb, postImage: '1' });
    await post(a, '/new-website/channels/facebook/api/save', { draft: draftFb, websiteId: String(siteB) });

    // Visit /new-website/channels: both websites have dedicated sections
    const page = await a.inject({ url: '/new-website/channels' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="website-' + siteA + '"');
    expect(page.body).toContain('id="website-' + siteB + '"');
    expect(page.body).toContain('Website A');
    expect(page.body).toContain('website-a.com');
    expect(page.body).toContain('Website B');
    expect(page.body).toContain('website-b.com');

    // Filter tabs exist
    expect(page.body).toContain('href="/new-website/channels?website=' + siteA + '"');
    expect(page.body).toContain('href="/new-website/channels?website=' + siteB + '"');

    // Direct filter to Website A
    const filterA = await a.inject({ url: `/new-website/channels?website=${siteA}` });
    expect(filterA.statusCode).toBe(200);
    expect(filterA.body).toContain('id="website-' + siteA + '"');
    expect(filterA.body).not.toContain('id="website-' + siteB + '"');
  });

  it('assigns channels to specific categories during channel creation and displays them', async () => {
    const a = await app();
    const siteA = site('Website A', 'website-a.com');

    const pickPin = await post(a, '/new-website/channels/pinterest/buffer/connect', { token: BUFFER_TOKEN });
    const draftPin = draftIn(pickPin.body);
    await post(a, '/new-website/channels/pinterest/buffer/pick', { draft: draftPin, pick: 'ch-pin' });
    await post(a, '/new-website/channels/pinterest/buffer/what', { draft: draftPin, postImage: '1' });
    await post(a, '/new-website/channels/pinterest/buffer/save', {
      draft: draftPin,
      websiteId: String(siteA),
      [`cat-${siteA}`]: ['desserts', 'baking'],
    });

    const channels = websiteChannels(siteA);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.categories).toEqual(['desserts', 'baking']);

    const page = await a.inject({ url: '/new-website/channels' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('desserts');
    expect(page.body).toContain('baking');
    expect(page.body).toContain(`/new-website/channels/${channels[0]!.id}/edit/categories?website=${siteA}`);
  });

  it('manages channel category assignments via dedicated categories route and setChannelWebsiteCategories', async () => {
    const a = await app();
    const siteA = site('Website A', 'website-a.com');
    const id = await addPin(a);
    setWebsiteChannels(siteA, [id]);

    // Initially all categories
    expect(websiteChannels(siteA)[0]!.categories).toEqual([]);

    // Open category edit page
    const editPage = await a.inject({ url: `/new-website/channels/${id}/edit/categories?website=${siteA}` });
    expect(editPage.statusCode).toBe(200);
    expect(editPage.body).toContain('Category assignments');
    expect(editPage.body).toContain('Website A');

    // Update categories via POST
    const updateRes = await post(a, `/new-website/channels/${id}/edit/categories`, {
      websiteId: String(siteA),
      categories: ['Main Dishes', 'Breakfast'],
    });
    expect(updateRes.statusCode).toBe(303);
    expect(websiteChannels(siteA)[0]!.categories).toEqual(['main dishes', 'breakfast']);

    // Programmatic update via setChannelWebsiteCategories
    setChannelWebsiteCategories(id, siteA, ['Soups']);
    expect(websiteChannels(siteA)[0]!.categories).toEqual(['soups']);

    // Clear back to all categories
    await post(a, `/new-website/channels/${id}/edit/categories`, {
      websiteId: String(siteA),
      categories: [],
    });
    expect(websiteChannels(siteA)[0]!.categories).toEqual([]);

    const page = await a.inject({ url: '/new-website/channels' });
    expect(page.body).toContain('All categories (entire website)');
  });
});
