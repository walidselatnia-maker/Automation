import { all, get, run } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';

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
export const PLATFORMS: { key: string; label: string; built: boolean }[] = [
  { key: 'pinterest', label: 'Pinterest', built: true },
  { key: 'facebook', label: 'Facebook', built: true },
  { key: 'instagram', label: 'Instagram', built: false },
  { key: 'threads', label: 'Threads', built: false },
  { key: 'linkedin', label: 'LinkedIn', built: false },
  { key: 'bluesky', label: 'Bluesky', built: false },
  { key: 'substack', label: 'Substack', built: false },
  { key: 'youtube', label: 'YouTube', built: false },
  { key: 'tiktok', label: 'TikTok', built: false },
  { key: 'mastodon', label: 'Mastodon', built: false },
  { key: 'google-business', label: 'Google Business Profile', built: false },
  { key: 'x', label: 'Twitter / X', built: false },
  { key: 'start-page', label: 'Start Page', built: false },
];

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
      `INSERT INTO newsite_channels (name, buffer_token_enc, paid_buffer, post_image, post_reel, multi_website, platform, via, buffer_channel_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'buffer', ?)`,
      ...values, input.platform, input.bufferChannelId,
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
      `INSERT INTO newsite_channels (name, fb_token_enc, post_image, post_reel, multi_website, platform, via, fb_page_id)
       VALUES (?, ?, ?, ?, ?, 'facebook', 'api', ?)`,
      ...values, input.pageId,
    ).lastInsertRowid,
  );
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

/**
 * Save which channels a website posts to. A single-website channel already
 * used by another website is refused with a message; the rest are saved.
 */
export function setWebsiteChannels(websiteId: number, channelIds: number[]): string[] {
  const allowed = new Set(channelsFor(websiteId).map((c) => c.id));
  const refused = channelIds.filter((id) => !allowed.has(id));
  run('DELETE FROM newsite_website_channels WHERE website_id = ?', websiteId);
  for (const id of channelIds.filter((x) => allowed.has(x))) {
    run('INSERT OR IGNORE INTO newsite_website_channels (website_id, channel_id) VALUES (?, ?)', websiteId, id);
  }
  return refused.map((id) => {
    const c = getChannel(id);
    return `“${c?.name ?? id}” is already used by another website and is not set to “Connect this channel to multiple websites”.`;
  });
}

/** The channels a website posts its articles to. */
export const websiteChannels = (websiteId: number): ChannelRow[] =>
  all<ChannelRow>(
    `SELECT c.* FROM newsite_channels c JOIN newsite_website_channels wc ON wc.channel_id = c.id WHERE wc.website_id = ? ORDER BY c.platform, c.name`,
    websiteId,
  );

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
  run('DELETE FROM newsite_website_channels WHERE channel_id = ?', channelId);
  for (const w of ids) run('INSERT OR IGNORE INTO newsite_website_channels (website_id, channel_id) VALUES (?, ?)', w, channelId);
  return null;
}
