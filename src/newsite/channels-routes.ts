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
  saveChannelRules,
  saveFacebookApiChannel,
  setChannelContent,
  setChannelWebsites,
  takesImages,
  takesReels,
  videoOnly,
  PLATFORMS,
  viasOf,
  type Platform,
  type Via,
} from './channels.js';
import {
  channelPage,
  addPlatformStep,
  addViaStep,
  connectionPart,
  PART_TITLE,
  planPart,
  postsPart,
  rulesPart,
  websitesPart,
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
import { sharingChanged } from './sharing-sync.js';
import { channelRules, checkPlatformRules, defaultRulesText, listPlatformRules, parseRules } from './platform-rules.js';

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
const letters = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');
/** Buffer's service name where it differs from the platform's key. */
const SERVICE_OF: Record<string, string> = { x: 'twitter' };
const isOf = (platform: Platform) => (c: BufferChannel): boolean =>
  letters(c.service) === letters(SERVICE_OF[platform] ?? platform) || letters(c.service) === letters(platform) || (platform === 'pinterest' && c.boards.length > 0);

/** The platform and way in the address, when it is one we build. */
function routeOf(request: FastifyRequest): WizardContext | null {
  const p = request.params as { platform?: string; via?: string };
  const platform = String(p.platform ?? '') as Platform;
  const via = p.via as Via;
  // Any Buffer platform can be connected; a channel starts with its platform's default rules (or starter rules).
  if (!/^[a-z0-9-]+$/.test(platform) || !viasOf(platform).includes(via)) return null;
  if (!PLATFORMS.some((x) => x.key === platform) && !checkPlatformRules(platform).rules) return null;
  const rules = parseRules(platform, defaultRulesText(platform, platformLabel(platform))).rules;
  return { platform, via, firstComment: via === 'buffer' && rules?.link === 'first_comment' };
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
    const names = new Map(channels.map((c) => [c.id, websiteChoices(channelWebsiteIds(c.id)).filter((x) => x.checked).map((x) => x.name)]));
    const rules = new Map(channels.map((c) => [c.id, channelRules(c)]));
    return send(reply, page('Channels', channelsPage(channels, names, rules), request));
  });

  /* -- Add a channel: the platform, then how it posts, then its wizard ---- */

  /** Buffer's platforms, then any platform with only a default rules file. */
  const platformChoices = () => {
    const files = listPlatformRules();
    return [
      ...PLATFORMS.map((p) => ({ key: p.key, label: p.label, ready: files.some((f) => f.platform === p.key && f.rules) })),
      ...files.filter((f) => f.rules && !PLATFORMS.some((p) => p.key === f.platform)).map((f) => ({ key: f.platform, label: f.rules!.label, ready: true })),
    ];
  };

  app.get('/new-website/channels/add', async (request, reply) => send(reply, page('Add a channel', addPlatformStep(platformChoices()), request)));

  app.post('/new-website/channels/add', async (request, reply) => {
    const platform = String(body(request).platform ?? '');
    if (!platformChoices().some((p) => p.key === platform)) {
      return send(reply, page('Add a channel', addPlatformStep(platformChoices(), 'Pick a platform.'), request));
    }
    if (viasOf(platform).length > 1) return send(reply, page('Add a channel', addViaStep(platform), request));
    return reply.redirect(`/new-website/channels/${platform}/buffer/new`, 303);
  });

  app.post('/new-website/channels/add/via', async (request, reply) => {
    const b = body(request);
    const platform = String(b.platform ?? '');
    const via = String(b.via ?? '') as Via;
    if (!viasOf(platform).includes(via)) return reply.redirect('/new-website/channels/add', 303);
    return reply.redirect(`/new-website/channels/${platform}/${via}/new`, 303);
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
          note: w.platform === 'pinterest' ? (c.boards.length === 1 ? '1 board' : `${c.boards.length} boards`) : `${platformLabel(w.platform)} in Buffer`,
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
      const msg = w.platform === 'pinterest' ? 'Pick one channel.' : 'Pick at least one.';
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
    if (w.firstComment) return send(reply, page(title(w), planStep(ctx, d.paidBuffer), request));
    if (takesReels(w.platform) && !videoOnly(w.platform)) return send(reply, page(title(w), postStep(ctx, { image: d.postImage, reel: d.postReel }), request));
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
    const ctx = { ...w, draft: String(b.draft) };
    if (takesReels(w.platform) && !videoOnly(w.platform)) return send(reply, page(title(w), postStep(ctx, { image: d.postImage, reel: d.postReel }), request));
    return send(reply, page(title(w), websitesStep(ctx, websiteChoices([]), false), request));
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
              paidBuffer: Boolean(w.firstComment) && d.paidBuffer,
              postImage: takesImages(w.platform) && (!takesReels(w.platform) || d.postImage),
              postReel: takesReels(w.platform) && (videoOnly(w.platform) || d.postReel),
              multiWebsite: multi,
            },
            deps.encryptionKey,
          )
        : saveFacebookApiChannel({ name: p.name, fbToken: d.token, pageId: p.id, postImage: d.postImage, postReel: d.postReel, multiWebsite: multi }, deps.encryptionKey),
    );
    for (const id of ids) setChannelWebsites(id, websiteIds);
    sharingChanged();
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
        return { ok: true, text: `Connected. Buffer answers and lists this ${c.platform === 'facebook' ? 'page' : 'channel'}.` };
      }
      await lookups.facebookPageCheck(fbTokenOf(c, deps.encryptionKey), c.fb_page_id);
      return { ok: true, text: 'Connected. Facebook gives this page a posting token.' };
    } catch (err) {
      return { ok: false, text: `Not connected: ${errorMessage(err)}` };
    }
  };

  /* -- One channel: its card, and one part at a time ------------------------ */

  const channelOf = (request: FastifyRequest) => getChannel(Number((request.params as { id: string }).id) || 0);
  const websiteNames = (id: number): string[] => websiteChoices(channelWebsiteIds(id)).filter((s) => s.checked).map((s) => s.name);
  const toChannel = (reply: FastifyReply, id: number, msg: string) => reply.redirect(`/new-website/channels/${id}?ok=${encodeURIComponent(msg)}`, 303);

  /** What the rules box opens with: the channel's saved rules, or its platform's default until it saves its own. */
  const rulesTextOf = (c: NonNullable<ReturnType<typeof getChannel>>): string => c.rules_text || defaultRulesText(c.platform, platformLabel(c.platform));

  app.get('/new-website/channels/:id', async (request, reply) => {
    const c = channelOf(request);
    if (!c) return reply.redirect('/new-website/channels', 303);
    // Right after adding a Buffer channel, its connection is checked first.
    const q = (request.query ?? {}) as Record<string, unknown>;
    if (on(q.check)) return send(reply, page(c.name, connectionPart(c, await check(c.id)), request));
    return send(reply, page(c.name, channelPage(c, websiteNames(c.id), channelRules(c)), request));
  });

  /** One part of a channel, opened alone in the wizard frame. */
  app.get('/new-website/channels/:id/edit/:part', async (request, reply) => {
    const c = channelOf(request);
    const part = String((request.params as { part: string }).part);
    if (!c) return reply.redirect('/new-website/channels', 303);
    const title = `${c.name}: ${PART_TITLE[part] ?? ''}`;
    switch (part) {
      case 'connection':
        return send(reply, page(title, connectionPart(c, await check(c.id)), request));
      case 'websites':
        return send(reply, page(title, websitesPart(c, websiteChoices(channelWebsiteIds(c.id))), request));
      case 'posts':
        return takesReels(c.platform) && !videoOnly(c.platform) ? send(reply, page(title, postsPart(c), request)) : reply.redirect(`/new-website/channels/${c.id}`, 303);
      case 'plan':
        return c.via === 'buffer' ? send(reply, page(title, planPart(c), request)) : reply.redirect(`/new-website/channels/${c.id}`, 303);
      case 'rules':
        return send(reply, page(title, rulesPart(c, rulesTextOf(c)), request));
      default:
        return reply.redirect(`/new-website/channels/${c.id}`, 303);
    }
  });

  app.post('/new-website/channels/:id/edit/:part', async (request, reply) => {
    const c = channelOf(request);
    const part = String((request.params as { part: string }).part);
    if (!c) return reply.redirect('/new-website/channels', 303);
    const b = body(request);
    const title = `${c.name}: ${PART_TITLE[part] ?? ''}`;
    switch (part) {
      case 'connection':
        return send(reply, page(title, connectionPart(c, await check(c.id)), request));
      case 'websites': {
        const websiteIds = list(b.websiteId).map(Number).filter(Boolean);
        const multi = on(b.multiWebsite);
        if (websiteIds.length > 1 && !multi) {
          return send(reply, page(title, websitesPart({ ...c, multi_website: 0 }, websiteChoices(websiteIds), 'You picked more than one website. Tick “Connect this channel to multiple websites”, or pick one.'), request));
        }
        run('UPDATE newsite_channels SET multi_website = ? WHERE id = ?', multi ? 1 : 0, c.id);
        const refused = setChannelWebsites(c.id, websiteIds);
        sharingChanged();
        if (refused) return send(reply, page(title, websitesPart(getChannel(c.id)!, websiteChoices(websiteIds), refused), request));
        return toChannel(reply, c.id, 'Websites saved.');
      }
      case 'posts': {
        if (!on(b.postImage) && !on(b.postReel)) {
          return send(reply, page(title, postsPart({ ...c, post_image: 0, post_reel: 0 }, 'Pick what to post: an image post, a reel, or both.'), request));
        }
        setChannelContent(c.id, { image: on(b.postImage), reel: on(b.postReel) });
        sharingChanged();
        return toChannel(reply, c.id, 'What to post saved.');
      }
      case 'plan':
        run('UPDATE newsite_channels SET paid_buffer = ? WHERE id = ?', on(b.paidBuffer) ? 1 : 0, c.id);
        return toChannel(reply, c.id, 'Buffer plan saved.');
      case 'rules': {
        const text = on(b.reset) ? defaultRulesText(c.platform, platformLabel(c.platform)) : String(b.rules ?? '');
        const problems = saveChannelRules(c.id, text);
        if (problems.length) return send(reply, page(title, rulesPart(c, text, problems), request));
        return toChannel(reply, c.id, on(b.reset) ? 'Rules set back to the default. This channel’s next post uses them.' : 'Rules saved. This channel’s next post uses them.');
      }
      default:
        return reply.redirect(`/new-website/channels/${c.id}`, 303);
    }
  });

  app.post('/new-website/channels/:id/delete', async (request, reply) => {
    deleteChannel(Number((request.params as { id: string }).id) || 0);
    return reply.redirect(`/new-website/channels?ok=${encodeURIComponent('Channel removed.')}`, 303);
  });
}
