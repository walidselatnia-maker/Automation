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

  it('lists every platform, Buffer and the API kept apart: Pinterest through Buffer only, Facebook both ways', async () => {
    const res = await (await app()).inject({ url: '/new-website/channels' });
    expect(res.body).toContain('href="/new-website/channels/pinterest/buffer/new"');
    expect(res.body).not.toContain('/channels/pinterest/api/new');
    expect(res.body).toContain('href="/new-website/channels/facebook/buffer/new"');
    expect(res.body).toContain('href="/new-website/channels/facebook/api/new"');
    expect(res.body).toContain('Through Buffer');
    expect(res.body).toContain('Through the API');
    // A platform with no rules file says how to add it.
    expect(res.body).toMatch(/Instagram<\/h2><span class="ch-soon">No rules file/);
    expect(res.body).toContain('Add prompts/platforms/instagram.md');
    expect(res.body).toContain('Rules file OK');
    expect((await (await app()).inject({ url: '/new-website/channels/pinterest/api/new' })).statusCode).toBe(303);
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

  it('changes a channel’s websites from the channel page', async () => {
    const a = await app();
    const one = site('One', 'one.example.com');
    const two = site('Two', 'two.example.com');
    const pick = await post(a, '/new-website/channels/pinterest/buffer/connect', { token: BUFFER_TOKEN });
    const draft = draftIn(pick.body);
    await post(a, '/new-website/channels/pinterest/buffer/pick', { draft, pick: 'ch-pin' });
    await post(a, '/new-website/channels/pinterest/buffer/save', { draft });
    const id = listChannels()[0]!.id;

    const page = await a.inject({ url: `/new-website/channels/${id}` });
    expect(page.body).toContain('one.example.com');
    const refused = await post(a, `/new-website/channels/${id}/settings`, { websiteId: [String(one), String(two)] });
    expect(refused.headers.location).toMatch(/error=/);
    await post(a, `/new-website/channels/${id}/settings`, { websiteId: [String(one), String(two)], multiWebsite: '1' });
    expect(websiteChannels(one)).toHaveLength(1);
    expect(websiteChannels(two)).toHaveLength(1);
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
    await post(a, `/new-website/channels/${channelId}/settings`, { multiWebsite: '1', websiteId: String(one) });
    expect(getChannel(channelId)!.multi_website).toBe(1);
    expect(setWebsiteChannels(two, [channelId])).toEqual([]);
    expect(websiteChannels(two)).toHaveLength(1);
  });
});
