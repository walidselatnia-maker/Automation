import { all, get, run } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { defaultRulesText, parseRules } from './platform-rules.js';

/**
 * The new dashboard's social channels.
 *
 * A channel is one place posts go, connected one way only: through a Buffer
 * account (a Pinterest or Facebook channel in Buffer) or through the
 * platform's own API (a Facebook page and a business token). Channels are set up once, on the Channels
 * page, and each website then chooses which of them it posts to. Tokens are
 * stored encrypted and never shown again; nothing here comes with the code,
 * so a fresh install starts with no channels at all.
 */

/** A channel's platform: Buffer's service name, and the name of its rules file. */
export type Platform = string;

/**
 * Every platform Buffer offers, in the order the Channels page lists them. A
 * platform can be used once prompts/platforms/<key>.md exists and is valid;
 * `built` here is only the starting list.
 */
export const PLATFORMS: { key: string; label: string; built: boolean; color: string }[] = [
  { key: 'pinterest', label: 'Pinterest', built: true, color: '#e60023' },
  { key: 'facebook', label: 'Facebook', built: true, color: '#1877f2' },
  { key: 'instagram', label: 'Instagram', built: true, color: '#f77737' },
  { key: 'threads', label: 'Threads', built: false, color: '#6b6b6b' },
  { key: 'linkedin', label: 'LinkedIn', built: false, color: '#0a66c2' },
  { key: 'bluesky', label: 'Bluesky', built: false, color: '#1185fe' },
  { key: 'substack', label: 'Substack', built: false, color: '#ff6719' },
  { key: 'youtube', label: 'YouTube', built: false, color: '#ff0000' },
  { key: 'tiktok', label: 'TikTok', built: false, color: '#25c4c4' },
  { key: 'mastodon', label: 'Mastodon', built: false, color: '#6364ff' },
  { key: 'google-business', label: 'Google Business Profile', built: false, color: '#4285f4' },
  { key: 'x', label: 'Twitter / X', built: false, color: '#6b6b6b' },
  { key: 'start-page', label: 'Start Page', built: false, color: '#7c3aed' },
];

/**
 * The colour a channel's card is tinted with: its platform's colour today.
 * One place to change, so a channel can get its own colour later.
 */
export const channelColor = (c: { platform: string }): string => PLATFORMS.find((p) => p.key === c.platform)?.color ?? '#8a94a3';

export interface ChannelRow {
  id: number;
  platform: Platform;
  via: Via;
  name: string;
  buffer_token_enc: string;
  buffer_channel_id: string;
  fb_token_enc: string;
  fb_page_id: string;
  paid_buffer: number;
  post_image: number;
  post_reel: number;
  multi_website: number;
  next_template: number;
  /** The channel's own rules, edited on its page; empty means its platform's default rules. */
  rules_text: string;
  created_at: string;
}

export const listChannels = (): ChannelRow[] => all<ChannelRow>('SELECT * FROM newsite_channels ORDER BY platform, name');

export const getChannel = (id: number): ChannelRow | undefined => get<ChannelRow>('SELECT * FROM newsite_channels WHERE id = ?', id);

const secret = (enc: string, key: Buffer): string => {
  if (!enc) return '';
  try {
    return decrypt(enc, key);
  } catch {
    return '';
  }
};

export const bufferTokenOf = (c: ChannelRow, key: Buffer): string => secret(c.buffer_token_enc, key);
export const fbTokenOf = (c: ChannelRow, key: Buffer): string => secret(c.fb_token_enc, key);

/**
 * How far back a channel newly given to a website catches up: the website's
 * articles published, and reels made, in these last days (sharing-sync.ts).
 */
export const CATCH_UP_DAYS = 7;

/** The platforms a reel (a vertical video) can be shared on. */
export const REEL_PLATFORMS = ['facebook', 'instagram', 'pinterest'] as const;
export const takesReels = (platform: string): boolean => (REEL_PLATFORMS as readonly string[]).includes(platform);

/** How a channel posts. Buffer and the platform's own API are kept apart. */
export type Via = 'buffer' | 'api';

/** The ways each built platform can be connected. Pinterest only goes through Buffer. */
export const viasOf = (platform: string): Via[] => (platform === 'facebook' ? ['buffer', 'api'] : ['buffer']);

export const viaLabel = (via: string): string => (via === 'buffer' ? 'Buffer' : 'API');

export interface BufferChannelInput {
  platform: Platform;
  name: string;
  bufferToken: string;
  bufferChannelId: string;
  paidBuffer: boolean;
  postImage: boolean;
  postReel: boolean;
  multiWebsite: boolean;
}

/** Add a channel that posts through a Buffer account, or update the one for the same Buffer channel. */
export function saveBufferChannel(input: BufferChannelInput, key: Buffer): number {
  const old = get<{ id: number }>(
    `SELECT id FROM newsite_channels WHERE platform = ? AND via = 'buffer' AND buffer_channel_id = ?`,
    input.platform, input.bufferChannelId,
  );
  const values = [
    input.name,
    encrypt(input.bufferToken, key),
    input.paidBuffer ? 1 : 0,
    input.postImage ? 1 : 0,
    input.postReel ? 1 : 0,
    input.multiWebsite ? 1 : 0,
  ];
  if (old) {
    run(
      `UPDATE newsite_channels SET name = ?, buffer_token_enc = ?, paid_buffer = ?, post_image = ?, post_reel = ?, multi_website = ? WHERE id = ?`,
      ...values, old.id,
    );
    return old.id;
  }
  return Number(
    run(
      `INSERT INTO newsite_channels (name, buffer_token_enc, paid_buffer, post_image, post_reel, multi_website, platform, via, buffer_channel_id, rules_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'buffer', ?, ?)`,
      ...values, input.platform, input.bufferChannelId, defaultRulesText(input.platform, platformName(input.platform)),
    ).lastInsertRowid,
  );
}

export interface FacebookApiChannelInput {
  name: string;
  fbToken: string;
  pageId: string;
  postImage: boolean;
  postReel: boolean;
  multiWebsite: boolean;
}

/** Add a Facebook page posted to through the Facebook API, or update the one for the same page. */
export function saveFacebookApiChannel(input: FacebookApiChannelInput, key: Buffer): number {
  const old = get<{ id: number }>(`SELECT id FROM newsite_channels WHERE platform = 'facebook' AND via = 'api' AND fb_page_id = ?`, input.pageId);
  const values = [input.name, encrypt(input.fbToken, key), input.postImage ? 1 : 0, input.postReel ? 1 : 0, input.multiWebsite ? 1 : 0];
  if (old) {
    run(`UPDATE newsite_channels SET name = ?, fb_token_enc = ?, post_image = ?, post_reel = ?, multi_website = ? WHERE id = ?`, ...values, old.id);
    return old.id;
  }
  return Number(
    run(
      `INSERT INTO newsite_channels (name, fb_token_enc, post_image, post_reel, multi_website, platform, via, fb_page_id, rules_text)
       VALUES (?, ?, ?, ?, ?, 'facebook', 'api', ?, ?)`,
      ...values, input.pageId, defaultRulesText('facebook', 'Facebook'),
    ).lastInsertRowid,
  );
}

/** A platform's name for people: Buffer's label, or the key with a capital. */
export const platformName = (key: string): string => PLATFORMS.find((p) => p.key === key)?.label ?? key.charAt(0).toUpperCase() + key.slice(1);

/**
 * Save a channel's own rules, after checking them. Returns what is wrong
 * (nothing is saved then), or an empty list once saved.
 */
export function saveChannelRules(id: number, text: string): string[] {
  const c = getChannel(id);
  if (!c) return ['That channel no longer exists.'];
  const clean = text.replace(/\r\n/g, '\n');
  const check = parseRules(c.platform, clean, `the rules of “${c.name}”`);
  if (!check.rules) return check.errors;
  run('UPDATE newsite_channels SET rules_text = ? WHERE id = ?', clean, id);
  return [];
}

/**
 * Change what a channel posts: its own default for websites added later, and
 * what every website using it sends it now.
 */
export function setChannelContent(channelId: number, what: ChannelContent): void {
  run('UPDATE newsite_channels SET post_image = ?, post_reel = ? WHERE id = ?', what.image ? 1 : 0, what.reel ? 1 : 0, channelId);
  run('UPDATE newsite_website_channels SET post_image = ?, post_reel = ? WHERE channel_id = ?', what.image ? 1 : 0, what.reel ? 1 : 0, channelId);
}

export const deleteChannel = (id: number): void => {
  run('DELETE FROM newsite_channels WHERE id = ?', id);
};

/* -- Websites and channels ------------------------------------------------ */

export const websiteChannelIds = (websiteId: number): number[] =>
  all<{ channel_id: number }>('SELECT channel_id FROM newsite_website_channels WHERE website_id = ?', websiteId).map((r) => r.channel_id);

export const channelWebsiteIds = (channelId: number): number[] =>
  all<{ website_id: number }>('SELECT website_id FROM newsite_website_channels WHERE channel_id = ?', channelId).map((r) => r.website_id);

/**
 * Channels a website may choose: every channel set to "multiple websites",
 * and each single-website channel that no other website uses yet.
 */
export function channelsFor(websiteId: number): ChannelRow[] {
  return listChannels().filter((c) => c.multi_website || channelWebsiteIds(c.id).every((w) => w === websiteId));
}

/** What a website sends to one of its channels. */
export interface ChannelContent {
  image: boolean;
  reel: boolean;
}

/**
 * Save which channels a website posts to, and what it sends to each. A
 * channel left out of `content` keeps what the website already sent it, or
 * starts from the channel's own choice when it is new to the website. A
 * single-website channel already used by another website is refused with a
 * message; the rest are saved.
 */
export function setWebsiteChannels(websiteId: number, channelIds: number[], content: Map<number, ChannelContent> = new Map()): string[] {
  const allowed = new Set(channelsFor(websiteId).map((c) => c.id));
  const refused = channelIds.filter((id) => !allowed.has(id));
  const before = new Map(websiteChannels(websiteId).map((c) => [c.id, { image: Boolean(c.post_image), reel: Boolean(c.post_reel) }]));
  run('DELETE FROM newsite_website_channels WHERE website_id = ?', websiteId);
  for (const id of channelIds.filter((x) => allowed.has(x))) {
    const c = getChannel(id)!;
    const what = content.get(id) ?? before.get(id) ?? { image: Boolean(c.post_image), reel: Boolean(c.post_reel) };
    run(
      'INSERT OR IGNORE INTO newsite_website_channels (website_id, channel_id, post_image, post_reel) VALUES (?, ?, ?, ?)',
      websiteId, id, what.image || !takesReels(c.platform) ? 1 : 0, what.reel && takesReels(c.platform) ? 1 : 0,
    );
  }
  return refused.map((id) => {
    const c = getChannel(id);
    return `“${c?.name ?? id}” is already used by another website and is not set to “Connect this channel to multiple websites”.`;
  });
}

/**
 * The channels a website posts its articles to. Their post_image and
 * post_reel are what this website sends them, not the channel's own default.
 */
export const websiteChannels = (websiteId: number): ChannelRow[] =>
  all<ChannelRow & { site_image: number; site_reel: number }>(
    `SELECT c.*, wc.post_image AS site_image, wc.post_reel AS site_reel FROM newsite_channels c
       JOIN newsite_website_channels wc ON wc.channel_id = c.id WHERE wc.website_id = ? ORDER BY c.platform, c.name`,
    websiteId,
  ).map(({ site_image, site_reel, ...c }) => ({ ...c, post_image: site_image, post_reel: site_reel }));

/**
 * Choose, from the channel's side, the websites it posts for. A channel not
 * set to "multiple websites" may serve one website only; asking for more is
 * refused with a message and nothing is changed.
 */
export function setChannelWebsites(channelId: number, websiteIds: number[]): string | null {
  const c = getChannel(channelId);
  if (!c) return 'That channel no longer exists.';
  const ids = [...new Set(websiteIds.filter(Boolean))];
  if (ids.length > 1 && !c.multi_website) {
    return 'This channel is for one website only. Tick “Connect this channel to multiple websites” to use it on more.';
  }
  const before = new Map(
    all<{ website_id: number; post_image: number; post_reel: number }>('SELECT website_id, post_image, post_reel FROM newsite_website_channels WHERE channel_id = ?', channelId).map((r) => [r.website_id, r]),
  );
  run('DELETE FROM newsite_website_channels WHERE channel_id = ?', channelId);
  for (const w of ids) {
    const old = before.get(w);
    run(
      'INSERT OR IGNORE INTO newsite_website_channels (website_id, channel_id, post_image, post_reel) VALUES (?, ?, ?, ?)',
      w, channelId, old?.post_image ?? c.post_image, old?.post_reel ?? c.post_reel,
    );
  }
  return null;
}

/**
 * Where a shared post is on its platform. A post sent through the Facebook
 * API is found from its id alone; anything else only has the link it was
 * given (Buffer's, once it has posted it).
 */
export function postLinkOf(p: { status: string; post_link: string; external_id: string }, channel: ChannelRow | undefined, kind: 'reel' | 'post'): string {
  if (p.post_link) return p.post_link;
  if (p.status !== 'sent' || !p.external_id || channel?.platform !== 'facebook' || channel.via !== 'api') return '';
  return kind === 'reel' ? `https://www.facebook.com/reel/${p.external_id}` : `https://www.facebook.com/${p.external_id}`;
}

/** The channel's own page on its platform, when its address is known. */
export function channelPageLink(channel: ChannelRow | undefined): string {
  if (channel?.platform === 'facebook' && channel.fb_page_id) return `https://www.facebook.com/${channel.fb_page_id}`;
  // Buffer names an Instagram channel by its username.
  const username = channel?.platform === 'instagram' ? channel.name.replace(/^@/, '').trim() : '';
  return /^[A-Za-z0-9._]{1,30}$/.test(username) ? `https://www.instagram.com/${username}/` : '';
}
