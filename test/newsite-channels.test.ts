import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { registerChannelRoutes, type ChannelLookups } from '../src/newsite/channels-routes.js';
import { bufferTokenOf, channelsFor, fbTokenOf, getChannel, listChannels, setWebsiteChannels, websiteChannels } from '../src/newsite/channels.js';
import { createNewWebsite } from '../src/newsite/repo.js';

const KEY = randomBytes(32);
const BUFFER_TOKEN = 'buffer-secret-token-123';
const FB_TOKEN = 'fb-secret-token-456';

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

  it('adds a Pinterest channel through Buffer: token, channel, websites, then the check', async () => {
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

    const websites = await post(a, '/new-website/channels/pinterest/buffer/pick', { draft, pick: 'ch-pin' });
    expect(websites.body).toContain('Step 3 of 4: Websites');
    expect(websites.body).toContain('one.example.com');
    expect(websites.body).toContain('Connect this channel to multiple websites');

    const both = await post(a, '/new-website/channels/pinterest/buffer/save', { draft, websiteId: [String(one), String(two)] });
    expect(both.body).toContain('You picked more than one website');
    expect(listChannels()).toHaveLength(0);

    const saved = await post(a, '/new-website/channels/pinterest/buffer/save', { draft, websiteId: String(one) });
    expect(saved.statusCode).toBe(303);
    const [c] = listChannels();
    expect(c).toMatchObject({ platform: 'pinterest', via: 'buffer', name: 'longlivo', buffer_channel_id: 'ch-pin', multi_website: 0 });
    expect(c!.buffer_token_enc).not.toContain(BUFFER_TOKEN);
    expect(bufferTokenOf(c!, KEY)).toBe(BUFFER_TOKEN);
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
    await post(a, '/new-website/channels/pinterest/buffer/save', { draft });
    return listChannels()[0]!.id;
  };

  it('shows each channel as a card of parts, each with one Change button', async () => {
    const a = await app();
    const id = await addPin(a);
    const list = await a.inject({ url: '/new-website/channels' });
    for (const part of ['connection', 'websites', 'rules']) expect(list.body).toContain(`href="/new-website/channels/${id}/edit/${part}"`);
    expect(list.body).not.toContain(`/edit/posts`); // not a Facebook page
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
});
