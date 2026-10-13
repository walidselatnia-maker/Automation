import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { run } from '../db/index.js';
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
  saveBufferChannel,
  saveFacebookApiChannel,
  setChannelWebsites,
  VIAS,
  type Platform,
  type Via,
} from './channels.js';
import {
  channelPage,
  channelsPage,
  checkStep,
  connectStep,
  pickStep,
  planStep,
  platformLabel,
  postStep,
  websitesStep,
  type PickChoice,
  type WebsiteChoice,
  type WizardContext,
} from './channels-view.js';
import { newLayout, type NewFlash } from './layout.js';
import { listNewWebsites } from './repo.js';

/** What the wizards ask Buffer and Facebook; replaceable so tests call neither. */
export interface ChannelLookups {
  /** The channels (Pinterest ones with their boards) in a Buffer account. */
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
  /** Whether a platform's rules file is approved, for the Channels page. */
  rulesOk?: (platform: Platform) => boolean;
}

/**
 * A wizard in progress: the token pasted in step 1 and what was chosen since,
 * kept here between steps so the token never goes back into a page.
 * Forgotten after an hour.
 */
interface Draft {
  platform: Platform;
  via: Via;
  token: string;
  /** What step 2 offered: Buffer channels or Facebook pages. */
  choices: PickChoice[];
  picked: { id: string; name: string }[];
  paidBuffer: boolean;
  postImage: boolean;
  postReel: boolean;
  expires: number;
}
const drafts = new Map<string, Draft>();
const newDraft = (d: Omit<Draft, 'expires' | 'picked' | 'paidBuffer' | 'postImage' | 'postReel'>): string => {
  const now = Date.now();
  for (const [k, v] of drafts) if (v.expires < now) drafts.delete(k);
  const id = randomBytes(12).toString('hex');
  drafts.set(id, { ...d, picked: [], paidBuffer: false, postImage: true, postReel: false, expires: now + 60 * 60_000 });
  return id;
};

const body = (request: FastifyRequest): Record<string, unknown> => (request.body as Record<string, unknown> | undefined) ?? {};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === '' ? [] : [String(v)]);
const on = (v: unknown): boolean => v === '1' || v === 'on' || v === true;

/** Is this Buffer channel one of the platform's? */
const isOf = (platform: Platform) => (c: BufferChannel): boolean =>
  platform === 'pinterest' ? c.service.toLowerCase() === 'pinterest' || c.boards.length > 0 : c.service.toLowerCase() === 'facebook';

/** The platform and way in the address, when it is one we build. */
function routeOf(request: FastifyRequest): WizardContext | null {
  const p = request.params as { platform?: string; via?: string };
  const platform = p.platform as Platform;
  const via = p.via as Via;
  return VIAS[platform]?.includes(via) ? { platform, via } : null;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteDeps): void {
  const lookups = deps.lookups ?? realLookups;
  const page = (title: string, h: ReturnType<typeof channelsPage>, request: FastifyRequest) =>
    newLayout({ title, active: '/new-website/channels', body: h, flash: deps.readFlash(request.query) });
  const send = (reply: FastifyReply, s: string) => reply.type('text/html; charset=utf-8').send(s);
  const lost = '/new-website/channels?error=' + encodeURIComponent('That setup expired. Start it again.');
  const title = (w: WizardContext) => `Add ${platformLabel(w.platform)}`;

  /** Every website, ticked when it is in `ids`. */
  const websiteChoices = (ids: number[]): WebsiteChoice[] => {
    const set = new Set(ids);
    return listNewWebsites().map((s) => ({ id: s.id, name: s.name, domain: s.domain, checked: set.has(s.id) }));
  };

  /** The draft of this wizard, if it is still there. */
  const draftOf = (w: WizardContext, id: unknown): Draft | undefined => {
    const d = drafts.get(String(id ?? ''));
    return d && d.platform === w.platform && d.via === w.via && d.expires > Date.now() ? d : undefined;
  };

  /** Channels already set up for the same Buffer channel or page, the same way. */
  const takenIds = (w: WizardContext): Set<string> =>
    new Set(
      listChannels()
        .filter((c) => c.platform === w.platform && c.via === w.via)
        .map((c) => (w.via === 'buffer' ? c.buffer_channel_id : c.fb_page_id)),
    );

  const choiceList = (w: WizardContext, d: Draft): PickChoice[] => {
    const taken = takenIds(w);
    return d.choices.map((c) => ({
      id: c.id,
      name: c.name,
      note: taken.has(c.id) ? 'Already a channel: picking it again updates it' : c.note,
    }));
  };

  app.get('/new-website/channels', async (request, reply) => {
    const channels = listChannels();
    const usedBy = new Map(channels.map((c) => [c.id, channelWebsiteIds(c.id).length]));
    return send(reply, page('Channels', channelsPage(channels, usedBy, deps.rulesOk), request));
  });

  /* -- Step 1: connect ---------------------------------------------------- */

  app.get('/new-website/channels/:platform/:via/new', async (request, reply) => {
    const w = routeOf(request);
    if (!w) return reply.redirect('/new-website/channels', 303);
    return send(reply, page(title(w), connectStep(w), request));
  });

  app.post('/new-website/channels/:platform/:via/connect', async (request, reply) => {
    const w = routeOf(request);
    if (!w) return reply.redirect('/new-website/channels', 303);
    const token = String(body(request).token ?? '').trim();
    const name = w.via === 'buffer' ? 'Buffer' : 'Facebook';
    if (!token) return send(reply, page(title(w), connectStep(w, `Paste the ${name} access token.`), request));

    let choices: PickChoice[];
    try {
      if (w.via === 'buffer') {
        choices = (await lookups.bufferChannels(token)).filter(isOf(w.platform)).map((c) => ({
          id: c.id,
          name: c.name,
          note: w.platform === 'pinterest' ? (c.boards.length === 1 ? '1 board' : `${c.boards.length} boards`) : 'Facebook page in Buffer',
        }));
      } else {
        choices = (await lookups.facebookPages(token)).map((p) => ({ id: p.id, name: p.name, note: `Page ${p.id}` }));
      }
    } catch (err) {
      return send(reply, page(title(w), connectStep(w, `${name} did not accept this token: ${errorMessage(err)}`), request));
    }
    if (!choices.length) {
      const why =
        w.via === 'api'
          ? 'This token sees no Facebook page. Give it a role on your pages first.'
          : `This Buffer account has no ${platformLabel(w.platform)} ${w.platform === 'facebook' ? 'page' : 'channel'}. Connect it in Buffer first.`;
      return send(reply, page(title(w), connectStep(w, why), request));
    }
    const draft = newDraft({ platform: w.platform, via: w.via, token, choices });
    const ctx = { ...w, draft };
    return send(reply, page(title(w), pickStep(ctx, choiceList(ctx, drafts.get(draft)!)), request));
  });

  /* -- Step 2: pick ------------------------------------------------------- */

  app.post('/new-website/channels/:platform/:via/pick', async (request, reply) => {
    const w = routeOf(request);
    const b = body(request);
    const d = w && draftOf(w, b.draft);
    if (!w || !d) return reply.redirect(lost, 303);
    const ctx = { ...w, draft: String(b.draft) };
    const ids = new Set(list(b.pick));
    const picked = d.choices.filter((c) => ids.has(c.id));
    if (!picked.length) {
      const msg = w.platform === 'pinterest' ? 'Pick one channel.' : 'Pick at least one page.';
      return send(reply, page(title(w), pickStep(ctx, choiceList(ctx, d), msg), request));
    }
    d.picked = w.platform === 'pinterest' ? picked.slice(0, 1) : picked;

    if (w.via === 'api') {
      // The check step: each page is asked for its posting token.
      const results = await Promise.all(
        d.picked.map(async (p) => {
          try {
            await lookups.facebookPageCheck(d.token, p.id);
            return { name: p.name, ok: true };
          } catch (err) {
            return { name: p.name, ok: false, error: errorMessage(err) };
          }
        }),
      );
      return send(reply, page(title(w), checkStep(ctx, results), request));
    }
    if (w.platform === 'facebook') return send(reply, page(title(w), planStep(ctx, d.paidBuffer), request));
    return send(reply, page(title(w), websitesStep(ctx, websiteChoices([]), false), request));
  });

  /* -- Facebook's middle steps -------------------------------------------- */

  app.post('/new-website/channels/:platform/:via/checked', async (request, reply) => {
    const w = routeOf(request);
    const b = body(request);
    const d = w && draftOf(w, b.draft);
    if (!w || !d?.picked.length) return reply.redirect(lost, 303);
    return send(reply, page(title(w), postStep({ ...w, draft: String(b.draft) }, { image: d.postImage, reel: d.postReel }), request));
  });

  app.post('/new-website/channels/:platform/:via/plan', async (request, reply) => {
    const w = routeOf(request);
    const b = body(request);
    const d = w && draftOf(w, b.draft);
    if (!w || !d?.picked.length) return reply.redirect(lost, 303);
    d.paidBuffer = on(b.paidBuffer);
    return send(reply, page(title(w), postStep({ ...w, draft: String(b.draft) }, { image: d.postImage, reel: d.postReel }), request));
  });

  app.post('/new-website/channels/:platform/:via/what', async (request, reply) => {
    const w = routeOf(request);
    const b = body(request);
    const d = w && draftOf(w, b.draft);
    if (!w || !d?.picked.length) return reply.redirect(lost, 303);
    const ctx = { ...w, draft: String(b.draft) };
    d.postImage = on(b.postImage);
    d.postReel = on(b.postReel);
    if (!d.postImage && !d.postReel) {
      return send(reply, page(title(w), postStep(ctx, { image: false, reel: false }, 'Pick what to post: an image post, a reel, or both.'), request));
    }
    return send(reply, page(title(w), websitesStep(ctx, websiteChoices([]), false), request));
  });

  /* -- Last step: websites, then save ------------------------------------- */

  app.post('/new-website/channels/:platform/:via/save', async (request, reply) => {
    const w = routeOf(request);
    const b = body(request);
    const d = w && draftOf(w, b.draft);
    if (!w || !d?.picked.length) return reply.redirect(lost, 303);
    const ctx = { ...w, draft: String(b.draft) };
    const websiteIds = list(b.websiteId).map(Number).filter(Boolean);
    const multi = on(b.multiWebsite);
    if (websiteIds.length > 1 && !multi) {
      return send(
        reply,
        page(title(w), websitesStep(ctx, websiteChoices(websiteIds), multi, 'You picked more than one website. Tick “Connect this channel to multiple websites”, or pick one.'), request),
      );
    }

    const ids = d.picked.map((p) =>
      w.via === 'buffer'
        ? saveBufferChannel(
            {
              platform: w.platform,
              name: p.name,
              bufferToken: d.token,
              bufferChannelId: p.id,
              paidBuffer: w.platform === 'facebook' && d.paidBuffer,
              postImage: w.platform === 'pinterest' || d.postImage,
              postReel: w.platform === 'facebook' && d.postReel,
              multiWebsite: multi,
            },
            deps.encryptionKey,
          )
        : saveFacebookApiChannel({ name: p.name, fbToken: d.token, pageId: p.id, postImage: d.postImage, postReel: d.postReel, multiWebsite: multi }, deps.encryptionKey),
    );
    for (const id of ids) setChannelWebsites(id, websiteIds);
    drafts.delete(String(b.draft));

    // A Buffer channel's last step, the check, runs on the channel's own page.
    if (ids.length === 1) return reply.redirect(`/new-website/channels/${ids[0]}?${w.via === 'buffer' ? 'check=1&' : ''}ok=${encodeURIComponent('Channel saved.')}`, 303);
    return reply.redirect(`/new-website/channels?ok=${encodeURIComponent(`${ids.length} channels saved.`)}`, 303);
  });

  /* -- One channel -------------------------------------------------------- */

  /** The Check step: is the channel still reachable with its saved token? */
  const check = async (id: number): Promise<{ ok: boolean; text: string }> => {
    const c = getChannel(id)!;
    try {
      if (c.via === 'buffer') {
        const found = (await lookups.bufferChannels(bufferTokenOf(c, deps.encryptionKey))).find((x) => x.id === c.buffer_channel_id);
        if (!found) return { ok: false, text: `Buffer no longer lists this ${platformLabel(c.platform)} channel. Check it in Buffer, or add the channel again.` };
        if (c.platform === 'pinterest') {
          if (!found.boards.length) return { ok: false, text: 'This Pinterest channel has no boards. Create boards on Pinterest first.' };
          return { ok: true, text: `Connected. Buffer answers, with ${found.boards.length} board${found.boards.length === 1 ? '' : 's'} to pick from.` };
        }
        return { ok: true, text: 'Connected. Buffer answers and lists this page.' };
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
    return page(c.name, channelPage(c, websiteChoices(channelWebsiteIds(c.id)), withCheck ? await check(c.id) : null), request);
  };

  app.get('/new-website/channels/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id) || 0;
    const q = (request.query ?? {}) as Record<string, unknown>;
    const out = await showChannel(request, id, on(q.check));
    return out ? send(reply, out) : reply.redirect('/new-website/channels', 303);
  });

  app.post('/new-website/channels/:id/check', async (request, reply) => {
    const id = Number((request.params as { id: string }).id) || 0;
    const out = await showChannel(request, id, true);
    return out ? send(reply, out) : reply.redirect('/new-website/channels', 303);
  });

  app.post('/new-website/channels/:id/settings', async (request, reply) => {
    const id = Number((request.params as { id: string }).id) || 0;
    const c = getChannel(id);
    if (!c) return reply.redirect('/new-website/channels', 303);
    const b = body(request);
    const back = (msg: string, kind: 'ok' | 'error') => reply.redirect(`/new-website/channels/${id}?${kind}=${encodeURIComponent(msg)}`, 303);
    const isFb = c.platform === 'facebook';
    if (isFb && !on(b.postImage) && !on(b.postReel)) return back('Pick what to post: an image post, a reel, or both.', 'error');
    const websiteIds = list(b.websiteId).map(Number).filter(Boolean);
    if (websiteIds.length > 1 && !on(b.multiWebsite)) {
      return back('You picked more than one website. Tick “Connect this channel to multiple websites”, or pick one.', 'error');
    }
    run(
      `UPDATE newsite_channels SET multi_website = ?, paid_buffer = ?, post_image = ?, post_reel = ? WHERE id = ?`,
      on(b.multiWebsite) ? 1 : 0,
      isFb && c.via === 'buffer' && on(b.paidBuffer) ? 1 : 0,
      isFb ? (on(b.postImage) ? 1 : 0) : c.post_image,
      isFb ? (on(b.postReel) ? 1 : 0) : c.post_reel,
      id,
    );
    const refused = setChannelWebsites(id, websiteIds);
    return refused ? back(refused, 'error') : back('Settings saved.', 'ok');
  });

  app.post('/new-website/channels/:id/delete', async (request, reply) => {
    deleteChannel(Number((request.params as { id: string }).id) || 0);
    return reply.redirect(`/new-website/channels?ok=${encodeURIComponent('Channel removed.')}`, 303);
  });
}
