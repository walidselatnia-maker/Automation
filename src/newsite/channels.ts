import { all, get, run } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';

/**
 * The new dashboard's social channels.
 *
 * A channel is one place posts go: one Pinterest channel in one Buffer
 * account, or one Facebook page. Channels are set up once, on the Channels
 * page, and each website then chooses which of them it posts to. Tokens are
 * stored encrypted and never shown again; nothing here comes with the code,
 * so a fresh install starts with no channels at all.
 */

export type Platform = 'pinterest' | 'facebook';

/** Every platform Buffer offers, in the order the Channels page lists them. Only some are built. */
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

export interface PinterestChannelInput {
  name: string;
  bufferToken: string;
  bufferChannelId: string;
  multiWebsite: boolean;
}

/** Add a Pinterest channel, or update the one with the same Buffer channel. */
export function savePinterestChannel(input: PinterestChannelInput, key: Buffer): number {
  const old = get<{ id: number }>(
    `SELECT id FROM newsite_channels WHERE platform = 'pinterest' AND buffer_channel_id = ?`,
    input.bufferChannelId,
  );
  if (old) {
    run(
      `UPDATE newsite_channels SET name = ?, buffer_token_enc = ?, multi_website = ? WHERE id = ?`,
      input.name, encrypt(input.bufferToken, key), input.multiWebsite ? 1 : 0, old.id,
    );
    return old.id;
  }
  return Number(
    run(
      `INSERT INTO newsite_channels (platform, name, buffer_token_enc, buffer_channel_id, multi_website) VALUES ('pinterest', ?, ?, ?, ?)`,
      input.name, encrypt(input.bufferToken, key), input.bufferChannelId, input.multiWebsite ? 1 : 0,
    ).lastInsertRowid,
  );
}

export interface FacebookChannelInput {
  name: string;
  fbToken: string;
  pageId: string;
  paidBuffer: boolean;
  postImage: boolean;
  postReel: boolean;
  multiWebsite: boolean;
}

/** Add a Facebook page as a channel, or update the one for the same page. */
export function saveFacebookChannel(input: FacebookChannelInput, key: Buffer): number {
  const old = get<{ id: number }>(`SELECT id FROM newsite_channels WHERE platform = 'facebook' AND fb_page_id = ?`, input.pageId);
  const values = [
    input.name,
    encrypt(input.fbToken, key),
    input.paidBuffer ? 1 : 0,
    input.postImage ? 1 : 0,
    input.postReel ? 1 : 0,
    input.multiWebsite ? 1 : 0,
  ];
  if (old) {
    run(
      `UPDATE newsite_channels SET name = ?, fb_token_enc = ?, paid_buffer = ?, post_image = ?, post_reel = ?, multi_website = ? WHERE id = ?`,
      ...values, old.id,
    );
    return old.id;
  }
  return Number(
    run(
      `INSERT INTO newsite_channels (platform, name, fb_token_enc, paid_buffer, post_image, post_reel, multi_website, fb_page_id)
       VALUES ('facebook', ?, ?, ?, ?, ?, ?, ?)`,
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
