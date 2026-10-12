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

  it('lists every platform: Pinterest and Facebook to add, the rest coming soon', async () => {
    const res = await (await app()).inject({ url: '/new-website/channels' });
    expect(res.body).toContain('Add Pinterest');
    expect(res.body).toContain('Add Facebook');
    expect(res.body).toMatch(/Instagram<\/h2><span class="ch-soon">Coming soon/);
  });

  it('adds a Pinterest channel: token, pick the channel, then the check', async () => {
    const a = await app();
    const bad = await post(a, '/new-website/channels/pinterest/connect', { bufferToken: 'nope' });
    expect(bad.body).toContain('Buffer did not accept this token');

    const pick = await post(a, '/new-website/channels/pinterest/connect', { bufferToken: BUFFER_TOKEN });
    expect(pick.body).toContain('longlivo');
    expect(pick.body).toContain('2 boards');
    expect(pick.body).not.toContain('Long Livo page'); // only Pinterest channels
    expect(pick.body).not.toContain(BUFFER_TOKEN); // the token never goes back into a page

    const saved = await post(a, '/new-website/channels/pinterest/save', { draft: draftIn(pick.body), channelId: 'ch-pin' });
    expect(saved.statusCode).toBe(303);
    const [c] = listChannels();
    expect(c).toMatchObject({ platform: 'pinterest', name: 'longlivo', buffer_channel_id: 'ch-pin', multi_website: 0 });
    expect(c!.buffer_token_enc).not.toContain(BUFFER_TOKEN);
    expect(bufferTokenOf(c!, KEY)).toBe(BUFFER_TOKEN);

    const checked = await a.inject({ url: saved.headers.location as string });
    expect(checked.body).toContain('Connected. Buffer answers, with 2 boards');
  });

  it('adds Facebook pages: token, pages, check, Buffer plan with its red warning, what to post', async () => {
    const a = await app();
    const pick = await post(a, '/new-website/channels/facebook/connect', { fbToken: FB_TOKEN });
    expect(pick.body).toContain('Easy Cakes');
    expect(pick.body).not.toContain(FB_TOKEN);
    const draft = draftIn(pick.body);

    const check = await post(a, '/new-website/channels/facebook/check', { draft, pageId: ['p1', 'p2'] });
    expect(check.body).toContain('Easy Cakes: connected.');
    expect(check.body).toContain('Cookie Corner: Page p2 returned no access token');

    const only = await post(a, '/new-website/channels/facebook/check', { draft, pageId: 'p1' });
    expect(only.body).toContain('Easy Cakes: connected.');

    const plan = await a.inject({ url: `/new-website/channels/facebook/plan?draft=${draft}` });
    expect(plan.body).toContain('I have a paid Buffer plan (first comment unlocked)');
    expect(plan.body).toMatch(/class="ch-warn"[^>]*>Buffer’s free plan cannot add the link in the first comment/);

    const what = await a.inject({ url: `/new-website/channels/facebook/post?draft=${draft}` });
    expect(what.body).toContain('Image post');
    expect(what.body).toContain('Reel');

    const none = await post(a, '/new-website/channels/facebook/save', { draft });
    expect(none.body).toContain('Pick what to post');

    const saved = await post(a, '/new-website/channels/facebook/save', { draft, postImage: '1', multiWebsite: '1' });
    expect(saved.statusCode).toBe(303);
    const [c] = listChannels();
    expect(c).toMatchObject({ platform: 'facebook', name: 'Easy Cakes', fb_page_id: 'p1', post_image: 1, post_reel: 0, paid_buffer: 0, multi_website: 1 });
    expect(fbTokenOf(c!, KEY)).toBe(FB_TOKEN);
  });

  it('lets a single-website channel belong to one website only', async () => {
    const a = await app();
    const pick = await post(a, '/new-website/channels/pinterest/connect', { bufferToken: BUFFER_TOKEN });
    await post(a, '/new-website/channels/pinterest/save', { draft: draftIn(pick.body), channelId: 'ch-pin' });
    const channelId = listChannels()[0]!.id;
    const site = (name: string, domain: string) =>
      createNewWebsite(
        {
          name, domain, apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '', persona: 'Storyteller', status: 'active',
          autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '',
        },
        KEY,
      );
    const one = site('One', 'one.example.com');
    const two = site('Two', 'two.example.com');

    expect(setWebsiteChannels(one, [channelId])).toEqual([]);
    expect(websiteChannels(one).map((c) => c.id)).toEqual([channelId]);
    // Taken: the second website does not even see it, and cannot take it.
    expect(channelsFor(two)).toEqual([]);
    expect(setWebsiteChannels(two, [channelId])[0]).toMatch(/already used by another website/);

    // Set to multiple websites: both may use it.
    await post(a, `/new-website/channels/${channelId}/settings`, { multiWebsite: '1' });
    expect(getChannel(channelId)!.multi_website).toBe(1);
    expect(setWebsiteChannels(two, [channelId])).toEqual([]);
    expect(websiteChannels(two)).toHaveLength(1);
  });
});
