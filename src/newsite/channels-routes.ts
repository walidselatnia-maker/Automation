import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BufferClient, type BufferChannel } from '../integrations/buffer.js';
import { FacebookClient, type FacebookPage } from '../integrations/facebook.js';
import { errorMessage } from '../lib/logger.js';
import {
  bufferTokenOf,
  channelWebsiteIds,
  deleteChannel,
  fbTokenOf,
  getChannel,
  listChannels,
  saveFacebookChannel,
  savePinterestChannel,
} from './channels.js';
import {
  channelPage,
  channelsPage,
  facebookCheckStep,
  facebookConnectStep,
  facebookPickStep,
  facebookPlanStep,
  facebookPostStep,
  pinterestConnectStep,
  pinterestPickStep,
} from './channels-view.js';
import { newLayout, type NewFlash } from './layout.js';
import { getNewWebsite } from './repo.js';
import { run } from '../db/index.js';

/** What the wizards ask Buffer and Facebook; replaceable so tests call neither. */
export interface ChannelLookups {
  /** The Pinterest channels (with their boards) in a Buffer account. */
  bufferChannels: (token: string) => Promise<BufferChannel[]>;
  /** The Facebook pages a business token can see. */
  facebookPages: (token: string) => Promise<FacebookPage[]>;
  /** Proves a page can be posted to with this token (its page token can be had). */
  facebookPageCheck: (token: string, pageId: string) => Promise<void>;
}

export const realLookups: ChannelLookups = {
  bufferChannels: async (token) => {
    const client = new BufferClient(token);
    return client.getChannels(await client.getOrganizationId());
  },
  facebookPages: (token) => new FacebookClient({ systemUserToken: token }).listPages(),
  facebookPageCheck: async (token, pageId) => {
    await new FacebookClient({ systemUserToken: token }).pageToken(pageId);
  },
};

export interface ChannelRouteDeps {
  encryptionKey: Buffer;
  readFlash: (query: unknown) => NewFlash;
  lookups?: ChannelLookups;
}

/**
 * A wizard in progress: the token pasted in step 1 and what was learned with
 * it, kept here between steps so it never goes back into a page. Forgotten
 * after an hour.
 */
interface Draft {
  platform: 'pinterest' | 'facebook';
  token: string;
  pinterest?: BufferChannel[];
  pages?: FacebookPage[];
  picked?: FacebookPage[];
  expires: number;
}
const drafts = new Map<string, Draft>();
const newDraft = (d: Omit<Draft, 'expires'>): string => {
  const now = Date.now();
  for (const [k, v] of drafts) if (v.expires < now) drafts.delete(k);
  const id = randomBytes(12).toString('hex');
  drafts.set(id, { ...d, expires: now + 60 * 60_000 });
  return id;
};
const draftOf = (id: unknown, platform: Draft['platform']): Draft | undefined => {
  const d = drafts.get(String(id ?? ''));
  return d && d.platform === platform && d.expires > Date.now() ? d : undefined;
};

const body = (request: FastifyRequest): Record<string, unknown> => (request.body as Record<string, unknown> | undefined) ?? {};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === '' ? [] : [String(v)]);
const on = (v: unknown): boolean => v === '1' || v === 'on' || v === true;

const isPinterest = (c: BufferChannel): boolean => c.service.toLowerCase() === 'pinterest' || c.boards.length > 0;

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteDeps): void {
  const lookups = deps.lookups ?? realLookups;
  const page = (title: string, html: ReturnType<typeof channelsPage>, request: FastifyRequest) =>
    newLayout({ title, active: '/new-website/channels', body: html, flash: deps.readFlash(request.query) });
  const send = (reply: import('fastify').FastifyReply, s: string) => reply.type('text/html; charset=utf-8').send(s);
  const lost = '/new-website/channels?error=' + encodeURIComponent('That setup expired. Start it again.');

  app.get('/new-website/channels', async (request, reply) => {
    const channels = listChannels();
    const usedBy = new Map(channels.map((c) => [c.id, channelWebsiteIds(c.id).length]));
    return send(reply, page('Channels', channelsPage(channels, usedBy), request));
  });

  /* -- Pinterest ---------------------------------------------------------- */

  app.get('/new-website/channels/pinterest/new', async (request, reply) => send(reply, page('Add Pinterest', pinterestConnectStep(), request)));

  app.post('/new-website/channels/pinterest/connect', async (request, reply) => {
    const token = String(body(request).bufferToken ?? '').trim();
    if (!token) return send(reply, page('Add Pinterest', pinterestConnectStep('Paste the Buffer access token.'), request));
    let channels: BufferChannel[];
    try {
      channels = (await lookups.bufferChannels(token)).filter(isPinterest);
    } catch (err) {
      return send(reply, page('Add Pinterest', pinterestConnectStep(`Buffer did not accept this token: ${errorMessage(err)}`), request));
    }
    if (!channels.length) {
      return send(reply, page('Add Pinterest', pinterestConnectStep('This Buffer account has no Pinterest channel. Connect Pinterest in Buffer first.'), request));
    }
    const draft = newDraft({ platform: 'pinterest', token, pinterest: channels });
    return send(reply, page('Add Pinterest', pinterestPickStep(draft, channels.map((c) => ({ id: c.id, name: c.name, boards: c.boards.length }))), request));
  });

  app.post('/new-website/channels/pinterest/save', async (request, reply) => {
    const b = body(request);
    const d = draftOf(b.draft, 'pinterest');
    if (!d) return reply.redirect(lost, 303);
    const picked = d.pinterest!.find((c) => c.id === String(b.channelId ?? ''));
    if (!picked) {
      return send(reply, page('Add Pinterest', pinterestPickStep(String(b.draft), d.pinterest!.map((c) => ({ id: c.id, name: c.name, boards: c.boards.length })), 'Pick one channel.'), request));
    }
    const id = savePinterestChannel({ name: picked.name, bufferToken: d.token, bufferChannelId: picked.id, multiWebsite: on(b.multiWebsite) }, deps.encryptionKey);
    drafts.delete(String(b.draft));
    // Step 3, the check, runs on the channel's own page.
    return reply.redirect(`/new-website/channels/${id}?check=1`, 303);
  });

  /* -- Facebook ----------------------------------------------------------- */

  app.get('/new-website/channels/facebook/new', async (request, reply) => send(reply, page('Add Facebook', facebookConnectStep(), request)));

  app.post('/new-website/channels/facebook/connect', async (request, reply) => {
    const token = String(body(request).fbToken ?? '').trim();
    if (!token) return send(reply, page('Add Facebook', facebookConnectStep('Paste the Facebook access token.'), request));
    let pages: FacebookPage[];
    try {
      pages = await lookups.facebookPages(token);
    } catch (err) {
      return send(reply, page('Add Facebook', facebookConnectStep(`Facebook did not accept this token: ${errorMessage(err)}`), request));
    }
    if (!pages.length) return send(reply, page('Add Facebook', facebookConnectStep('This token sees no Facebook page. Give it a role on your pages first.'), request));
    const draft = newDraft({ platform: 'facebook', token, pages });
    const taken = new Set(listChannels().filter((c) => c.platform === 'facebook').map((c) => c.fb_page_id));
    return send(reply, page('Add Facebook', facebookPickStep(draft, pages.map((p) => ({ ...p, taken: taken.has(p.id) }))), request));
  });

  app.post('/new-website/channels/facebook/check', async (request, reply) => {
    const b = body(request);
    const d = draftOf(b.draft, 'facebook');
    if (!d) return reply.redirect(lost, 303);
    const ids = new Set(list(b.pageId));
    const picked = d.pages!.filter((p) => ids.has(p.id));
    if (!picked.length) {
      const taken = new Set(listChannels().filter((c) => c.platform === 'facebook').map((c) => c.fb_page_id));
      return send(reply, page('Add Facebook', facebookPickStep(String(b.draft), d.pages!.map((p) => ({ ...p, taken: taken.has(p.id) })), 'Pick at least one page.'), request));
    }
    d.picked = picked;
    const results = await Promise.all(
      picked.map(async (p) => {
        try {
          await lookups.facebookPageCheck(d.token, p.id);
          return { name: p.name, ok: true };
        } catch (err) {
          return { name: p.name, ok: false, error: errorMessage(err) };
        }
      }),
    );
    return send(reply, page('Add Facebook', facebookCheckStep(String(b.draft), results), request));
  });

  app.get('/new-website/channels/facebook/plan', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    if (!draftOf(q.draft, 'facebook')?.picked) return reply.redirect(lost, 303);
    return send(reply, page('Add Facebook', facebookPlanStep(String(q.draft)), request));
  });

  app.get('/new-website/channels/facebook/post', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    if (!draftOf(q.draft, 'facebook')?.picked) return reply.redirect(lost, 303);
    return send(reply, page('Add Facebook', facebookPostStep(String(q.draft), on(q.paidBuffer)), request));
  });

  app.post('/new-website/channels/facebook/save', async (request, reply) => {
    const b = body(request);
    const d = draftOf(b.draft, 'facebook');
    if (!d?.picked) return reply.redirect(lost, 303);
    if (!on(b.postImage) && !on(b.postReel)) {
      return send(reply, page('Add Facebook', facebookPostStep(String(b.draft), on(b.paidBuffer), 'Pick what to post: an image post, a reel, or both.'), request));
    }
    for (const p of d.picked) {
      saveFacebookChannel(
        { name: p.name, fbToken: d.token, pageId: p.id, paidBuffer: on(b.paidBuffer), postImage: on(b.postImage), postReel: on(b.postReel), multiWebsite: on(b.multiWebsite) },
        deps.encryptionKey,
      );
    }
    drafts.delete(String(b.draft));
    const n = d.picked.length;
    return reply.redirect(`/new-website/channels?ok=${encodeURIComponent(`${n} Facebook page${n === 1 ? '' : 's'} added.`)}`, 303);
  });

  /* -- One channel -------------------------------------------------------- */

  /** The Check step: is the channel still reachable with its saved token? */
  const check = async (id: number): Promise<{ ok: boolean; text: string }> => {
    const c = getChannel(id)!;
    try {
      if (c.platform === 'pinterest') {
        const found = (await lookups.bufferChannels(bufferTokenOf(c, deps.encryptionKey))).find((x) => x.id === c.buffer_channel_id);
        if (!found) return { ok: false, text: 'Buffer no longer lists this Pinterest channel. Check it in Buffer, or add the channel again.' };
        if (!found.boards.length) return { ok: false, text: 'This Pinterest channel has no boards. Create boards on Pinterest first.' };
        return { ok: true, text: `Connected. Buffer answers, with ${found.boards.length} board${found.boards.length === 1 ? '' : 's'} to pick from.` };
      }
      await lookups.facebookPageCheck(fbTokenOf(c, deps.encryptionKey), c.fb_page_id);
      return { ok: true, text: 'Connected. Facebook gives this page a posting token.' };
    } catch (err) {
      return { ok: false, text: `Not connected: ${errorMessage(err)}` };
    }
  };

  const showChannel = async (request: FastifyRequest, id: number, withCheck: boolean) => {
    const c = getChannel(id);
    if (!c) return null;
    const websites = channelWebsiteIds(c.id).map((w) => getNewWebsite(w)?.name ?? `Website ${w}`);
    return page(c.name, channelPage(c, websites, withCheck ? await check(c.id) : null), request);
  };

  app.get('/new-website/channels/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id) || 0;
    const q = (request.query ?? {}) as Record<string, unknown>;
    const htmlOut = await showChannel(request, id, on(q.check));
    return htmlOut ? send(reply, htmlOut) : reply.redirect('/new-website/channels', 303);
  });

  app.post('/new-website/channels/:id/check', async (request, reply) => {
    const id = Number((request.params as { id: string }).id) || 0;
    const htmlOut = await showChannel(request, id, true);
    return htmlOut ? send(reply, htmlOut) : reply.redirect('/new-website/channels', 303);
  });

  app.post('/new-website/channels/:id/settings', async (request, reply) => {
    const id = Number((request.params as { id: string }).id) || 0;
    const c = getChannel(id);
    if (!c) return reply.redirect('/new-website/channels', 303);
    const b = body(request);
    if (c.platform === 'facebook' && !on(b.postImage) && !on(b.postReel)) {
      return reply.redirect(`/new-website/channels/${id}?error=${encodeURIComponent('Pick what to post: an image post, a reel, or both.')}`, 303);
    }
    run(
      `UPDATE newsite_channels SET multi_website = ?, paid_buffer = ?, post_image = ?, post_reel = ? WHERE id = ?`,
      on(b.multiWebsite) ? 1 : 0,
      on(b.paidBuffer) ? 1 : 0,
      c.platform === 'facebook' ? (on(b.postImage) ? 1 : 0) : c.post_image,
      c.platform === 'facebook' ? (on(b.postReel) ? 1 : 0) : c.post_reel,
      id,
    );
    return reply.redirect(`/new-website/channels/${id}?ok=${encodeURIComponent('Settings saved.')}`, 303);
  });

  app.post('/new-website/channels/:id/delete', async (request, reply) => {
    deleteChannel(Number((request.params as { id: string }).id) || 0);
    return reply.redirect(`/new-website/channels?ok=${encodeURIComponent('Channel removed.')}`, 303);
  });
}
