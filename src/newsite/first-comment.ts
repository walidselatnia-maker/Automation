import { all, run } from '../db/index.js';
import { FacebookClient } from '../integrations/facebook.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { fbTokenOf, getChannel, type ChannelRow } from './channels.js';
import { channelRules } from './platform-rules.js';

const log = createLogger('newsite-first-comment');

/** What the first comment needs from Facebook's Graph API; replaceable so tests call nothing. */
export interface CommentApi {
  findPagePost(pageId: string, link: string): Promise<string | null>;
  commentOnPost(input: { pageId: string; postId: string; message: string }): Promise<{ commentId: string }>;
  findInstagramMedia(input: { pageId: string; igUserId: string; link: string }): Promise<string | null>;
  commentOnInstagram(input: { pageId: string; mediaId: string; message: string }): Promise<{ commentId: string }>;
}

export interface FirstCommentDeps {
  encryptionKey: Buffer;
  comments?: (token: string) => CommentApi;
}

const realComments = (token: string): CommentApi => new FacebookClient({ systemUserToken: token });

/** Platforms whose Buffer posts can get their first comment through the Graph API. */
export const COMMENT_PLATFORMS = ['facebook', 'instagram'] as const;

/**
 * Does this channel get its first comment here, after the post is out? A
 * Buffer channel for Facebook or Instagram that has a Facebook token, and an
 * Instagram channel posting through the API. (A Facebook API channel comments
 * the moment it posts.)
 */
export function commentsThroughApi(c: Pick<ChannelRow, 'via' | 'platform' | 'fb_token_enc' | 'fb_page_id'>): boolean {
  if (!c.fb_token_enc || !c.fb_page_id) return false;
  return c.via === 'buffer' ? (COMMENT_PLATFORMS as readonly string[]).includes(c.platform) : c.platform === 'instagram';
}

/** How many times a comment is tried before the post is left without one. */
const MAX_TRIES = 3;

const TABLES = [
  { table: 'newsite_social_posts', seo: 't.seo_id' },
  { table: 'newsite_reel_shares', seo: '(SELECT r.seo_id FROM newsite_reels r WHERE r.id = t.reel_id)' },
] as const;

/**
 * Buffer posted it; the Graph API adds the article link as its first comment.
 * Runs for posts whose address Buffer has given, sent in the last seven days,
 * on Buffer channels set up for it, whose rules put the link in the first comment.
 */
export async function addFirstComments(deps: FirstCommentDeps): Promise<number> {
  let added = 0;
  const apis = new Map<number, CommentApi>();
  for (const { table, seo } of TABLES) {
    const rows = all<{ id: number; channel_id: number; post_link: string; post_url: string; tries: number }>(
      `SELECT t.id, t.channel_id, t.post_link, t.comment_tries AS tries, s.post_url FROM ${table} t
         JOIN newsite_channels c ON c.id = t.channel_id
         JOIN keyword_seo s ON s.id = ${seo}
        WHERE t.status = 'sent' AND t.post_link <> '' AND t.comment_id = '' AND t.comment_tries < ?
          AND c.fb_token_enc <> '' AND c.fb_page_id <> '' AND c.platform IN ('facebook', 'instagram')
          AND s.post_url <> '' AND t.sent_at >= datetime('now', '-7 days')`,
      MAX_TRIES,
    );
    for (const row of rows) {
      const channel = getChannel(row.channel_id);
      if (!channel || !commentsThroughApi(channel)) continue;
      if (channelRules(channel).rules?.link !== 'first_comment') continue;
      let api = apis.get(channel.id);
      if (!api) {
        api = (deps.comments ?? realComments)(fbTokenOf(channel, deps.encryptionKey));
        apis.set(channel.id, api);
      }
      try {
        const commentId = await commentOn(api, channel, row.post_link, row.post_url);
        run(`UPDATE ${table} SET comment_id = ?, comment_tries = comment_tries + 1, error = '' WHERE id = ?`, commentId, row.id);
        added += 1;
      } catch (err) {
        const last = row.tries + 1 >= MAX_TRIES;
        run(
          `UPDATE ${table} SET comment_tries = comment_tries + 1, error = ? WHERE id = ?`,
          `Posted, but the link comment ${last ? 'failed' : 'did not go on yet'}: ${errorMessage(err).slice(0, 300)}`,
          row.id,
        );
        log.warn(`${table} ${row.id}: first comment failed: ${errorMessage(err)}`);
      }
    }
  }
  return added;
}

async function commentOn(api: CommentApi, channel: ChannelRow, link: string, message: string): Promise<string> {
  if (channel.platform === 'instagram') {
    const mediaId = await api.findInstagramMedia({ pageId: channel.fb_page_id, igUserId: channel.api_account_id, link });
    if (!mediaId) throw new Error(`Instagram does not list ${link} on this account (is it the same account as in Buffer?)`);
    return (await api.commentOnInstagram({ pageId: channel.fb_page_id, mediaId, message })).commentId;
  }
  const postId = await api.findPagePost(channel.fb_page_id, link);
  if (!postId) throw new Error(`The page does not list ${link} (is it the same page as in Buffer?)`);
  return (await api.commentOnPost({ pageId: channel.fb_page_id, postId, message })).commentId;
}
