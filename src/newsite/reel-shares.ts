import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { BufferClient, type BufferChannel } from '../integrations/buffer.js';
import { FacebookClient } from '../integrations/facebook.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { commentsThroughApi } from './first-comment.js';
import { newsiteReelMediaUrl } from '../core/media-links.js';
import type { Settings } from '../settings.js';
import { bufferTokenOf, fbTokenOf, getChannel, takesReels, websiteChannels, type ChannelRow } from './channels.js';
import { channelRules } from './platform-rules.js';
import { getReel, reelDir, type ReelRow } from './reels.js';
import { getSeoRow } from './seo.js';
import { bufferMetadata, isQueueFull, pickBoard, realInstagram, realThreads, websiteOf, writePostWords, type InstagramApi, type ThreadsApi } from './social.js';
import { threadsTokenOf, type Renew } from './threads-token.js';

/**
 * Sharing a made reel: the one video of an article (reels.ts), sent to each
 * of its website's channels that takes reels (Facebook, Instagram,
 * Pinterest), with its own status, error and retry per channel. The video is
 * the same everywhere and never made again for another channel: a Facebook
 * reel, an Instagram reel, a Pinterest video pin.
 *
 * Its words are written fresh from the article by the channel's rules (never
 * the image post's words again, so a page never shows the same text twice).
 * The link rule is the image posts' rule: never in the words; a pin carries
 * it as its own link, a Facebook reel as the first comment.
 *
 * A made reel goes by itself to the channels set to post reels; any other
 * channel is picked on the Reels page.
 */

const log = createLogger('newsite-reel-shares');

/** Said to the AI with the channel's rules: the words are for a video. */
const REEL_NOTE =
  'This post is a reel: a 10-second vertical video of the dish being made, ending on the finished result. Write its words for that video, not for a picture.';

export interface ReelShareRow {
  id: number;
  reel_id: number;
  channel_id: number;
  status: 'pending' | 'waiting' | 'sent' | 'failed';
  text: string;
  title: string;
  board_name: string;
  external_id: string;
  comment_id: string;
  /** The reel on its platform, once it is out (post-links.ts fills it in for Buffer posts). */
  post_link: string;
  error: string;
  retry_at: number | null;
  created_at: string;
  sent_at: string | null;
}

export interface ReelBufferApi {
  channels: () => Promise<BufferChannel[]>;
  createVideoPost: (input: { text: string; channelId: string; videoUrl: string; metadata: string }) => Promise<string>;
}

export interface ReelFacebookApi {
  publishReel: (input: { pageId: string; video: Buffer; description: string }) => Promise<{ videoId: string; permalink: string }>;
  commentOnPost: (input: { pageId: string; postId: string; message: string }) => Promise<{ commentId: string }>;
}

export interface ReelShareDeps {
  settings: Settings;
  encryptionKey: Buffer;
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
  dataDir?: string;
  buffer?: (token: string) => ReelBufferApi;
  facebook?: (token: string) => ReelFacebookApi;
  instagram?: (token: string) => InstagramApi;
  threads?: (token: string) => ThreadsApi;
  renewThreads?: Renew;
  now?: () => number;
  /** Wakes the sharer when a waiting share is due; tests pass their own. */
  wakeIn?: (ms: number, wake: () => void) => void;
}

const realBuffer = (token: string): ReelBufferApi => {
  const client = new BufferClient(token);
  return {
    channels: async () => client.getChannels(await client.getOrganizationId()),
    createVideoPost: (input) => client.createVideoPost(input),
  };
};

const realFacebook = (token: string): ReelFacebookApi => {
  const client = new FacebookClient({ systemUserToken: token });
  return { publishReel: (i) => client.publishReel(i), commentOnPost: (i) => client.commentOnPost(i) };
};

export const getReelShare = (id: number): ReelShareRow | undefined => get<ReelShareRow>('SELECT * FROM newsite_reel_shares WHERE id = ?', id);

/** Every reel share of one keyword plan's articles. */
export const listPlanReelShares = (planId: number): ReelShareRow[] =>
  all<ReelShareRow>(
    `SELECT sh.* FROM newsite_reel_shares sh JOIN newsite_reels r ON r.id = sh.reel_id JOIN keyword_seo s ON s.id = r.seo_id
      WHERE s.plan_id = ? ORDER BY sh.id`,
    planId,
  );

/** Every channel of the reel's website that takes reels: where it can be shared. */
export function reelDestinations(reel: Pick<ReelRow, 'seo_id'>): ChannelRow[] {
  const site = websiteOf(reel.seo_id);
  return site ? websiteChannels(site.id).filter((c) => takesReels(c.platform)) : [];
}

/**
 * A reel is made: share it on each of its channels it is not on yet. A share
 * that failed (the reel was made again after it) goes back to work. Returns
 * how many were added.
 */
export function createReelShares(reelId: number): number {
  const reel = getReel(reelId);
  if (!reel || reel.status !== 'done') return 0;
  let added = 0;
  for (const c of reelDestinations(reel).filter((c) => c.post_reel)) added += shareReelOn(reel.id, c.id);
  return added;
}

/**
 * Share a made reel on one channel of its website that takes reels (picked on
 * the Reels page). Returns 1 when it was added or put back to work.
 */
export function shareReelOn(reelId: number, channelId: number): number {
  const reel = getReel(reelId);
  if (!reel || reel.status !== 'done' || !reelDestinations(reel).some((c) => c.id === channelId)) return 0;
  const added = Number(run('INSERT OR IGNORE INTO newsite_reel_shares (reel_id, channel_id) VALUES (?, ?)', reelId, channelId).changes);
  if (added) return 1;
  return Number(run(`UPDATE newsite_reel_shares SET status = 'pending', error = '', retry_at = NULL WHERE reel_id = ? AND channel_id = ? AND status = 'failed'`, reelId, channelId).changes);
}

/** Put a failed share back to work. */
export function retryReelShare(id: number): void {
  run(`UPDATE newsite_reel_shares SET status = 'pending', error = '', retry_at = NULL WHERE id = ? AND status = 'failed'`, id);
}

const fail = (id: number, error: string): void => {
  run(`UPDATE newsite_reel_shares SET status = 'failed', error = ? WHERE id = ?`, error.slice(0, 900), id);
};

/** One share: its words, then the video to Buffer or the Facebook API. */
async function work(share: ReelShareRow, deps: ReelShareDeps, now: number): Promise<void> {
  const reel = getReel(share.reel_id);
  const channel = getChannel(share.channel_id);
  const row = reel ? getSeoRow(reel.seo_id) : undefined;
  const site = row ? websiteOf(row.id) : undefined;
  if (!reel || !channel || !row || !site) return fail(share.id, 'Its reel, article, website or channel is gone.');
  if (reel.status !== 'done' || !reel.file) return fail(share.id, 'The reel has no video yet.');
  if (row.post_status !== 'published' || !row.post_url) return fail(share.id, 'The article is not published on the website yet.');
  if (!websiteChannels(site.id).some((c) => c.id === channel.id && c.post_reel)) {
    // The website no longer sends reels there: it is dropped, never sent.
    run('DELETE FROM newsite_reel_shares WHERE id = ?', share.id);
    return;
  }
  const check = channelRules(channel);
  if (!check.rules) return fail(share.id, `${check.file} have problems (open the channel and click Edit rules): ${check.errors.join(' ')}`);
  const rules = check.rules;

  if (!share.text) {
    const out = await writePostWords(rules, row, site, deps.ask, REEL_NOTE);
    if (!out.answer) return fail(share.id, out.problems.join(' '));
    share.text = out.answer[rules.postText] ?? '';
    share.title = out.answer.title ?? '';
    run('UPDATE newsite_reel_shares SET text = ?, title = ? WHERE id = ?', share.text, share.title, share.id);
  }

  if (channel.via === 'buffer') {
    const api = (deps.buffer ?? realBuffer)(bufferTokenOf(channel, deps.encryptionKey));
    try {
      const found = (await api.channels()).find((c) => c.id === channel.buffer_channel_id);
      if (!found) throw new Error(`Buffer no longer lists this ${rules.label} channel. Check it on the Channels page.`);
      let board: { serviceId: string; name: string } | undefined;
      if (channel.platform === 'pinterest') {
        if (!found.boards.length) throw new Error('This Pinterest channel has no boards. Create one on Pinterest first.');
        board = await pickBoard({ row, site }, found.boards, deps);
      }
      const base = deps.settings.get('public_base_url').trim();
      if (!base) {
        throw new Error('This platform has no public address yet, so Buffer cannot fetch the video. Open the dashboard once at its https address, or set it in Platform settings → Images.');
      }
      const videoUrl = newsiteReelMediaUrl(base, reel.id, deps.settings.get('reel_media_link_days'), deps.encryptionKey, now);
      const firstComment = rules.link === 'first_comment' && channel.paid_buffer && !commentsThroughApi(channel) ? row.post_url : '';
      const id = await api.createVideoPost({
        text: share.text,
        channelId: channel.buffer_channel_id,
        videoUrl,
        metadata: bufferMetadata(channel.platform, { title: share.title || row.title, url: row.post_url, boardServiceId: board?.serviceId, firstComment, type: 'reel' }),
      });
      const note = rules.link === 'first_comment' && !channel.paid_buffer && !commentsThroughApi(channel) ? 'Queued without the link: Buffer’s free plan cannot add a first comment.' : '';
      run(
        `UPDATE newsite_reel_shares SET status = 'sent', external_id = ?, board_name = ?, error = ?, retry_at = NULL, sent_at = datetime('now') WHERE id = ?`,
        id, board?.name ?? '', note, share.id,
      );
    } catch (err) {
      if (!isQueueFull(err)) return fail(share.id, errorMessage(err));
      const hours = Math.max(1, deps.settings.getNumber('buffer_hold_hours'));
      run(
        `UPDATE newsite_reel_shares SET status = 'waiting', retry_at = ?, error = ? WHERE id = ?`,
        now + hours * 3_600_000,
        `Buffer did not take it yet (${errorMessage(err).slice(0, 200)}). Tries again in ${hours} hours.`,
        share.id,
      );
    }
    return;
  }

  if (channel.platform === 'instagram' || channel.platform === 'threads') {
    // Both fetch the video from its public link, post it, and say where it is.
    try {
      const base = deps.settings.get('public_base_url').trim();
      if (!base) throw new Error(`This platform has no public address yet, so ${rules.label} cannot fetch the video. Open the dashboard once at its https address, or set it in Platform settings → Images.`);
      const videoUrl = newsiteReelMediaUrl(base, reel.id, deps.settings.get('reel_media_link_days'), deps.encryptionKey, now);
      const posted =
        channel.platform === 'instagram'
          ? await (deps.instagram ?? realInstagram)(fbTokenOf(channel, deps.encryptionKey)).publishInstagram({
              pageId: channel.fb_page_id, igUserId: channel.api_account_id, kind: 'reel', mediaUrl: videoUrl, caption: share.text,
            })
          : await (deps.threads ?? realThreads)(await threadsTokenOf(channel, deps.encryptionKey, deps.renewThreads)).publish({
              userId: channel.api_account_id, kind: 'video', mediaUrl: videoUrl, text: share.text,
            });
      run(
        `UPDATE newsite_reel_shares SET status = 'sent', external_id = ?, post_link = ?, error = '', sent_at = datetime('now') WHERE id = ?`,
        posted.mediaId, posted.permalink, share.id,
      );
      log.info(`reel ${reel.id} shared on ${channel.name} (${rules.label} API): ${posted.mediaId}`);
    } catch (err) {
      fail(share.id, errorMessage(err));
    }
    return;
  }
  if (channel.platform !== 'facebook') return fail(share.id, `Posting reels to ${rules.label} through its own API is not built; connect it through Buffer.`);
  const api = (deps.facebook ?? realFacebook)(fbTokenOf(channel, deps.encryptionKey));
  let videoId: string;
  try {
    const video = readFileSync(join(reelDir(deps.dataDir), reel.file));
    ({ videoId } = await api.publishReel({ pageId: channel.fb_page_id, video, description: share.text }));
  } catch (err) {
    return fail(share.id, errorMessage(err));
  }
  run(`UPDATE newsite_reel_shares SET status = 'sent', external_id = ?, post_link = ?, error = '', sent_at = datetime('now') WHERE id = ?`, videoId, `https://www.facebook.com/reel/${videoId}`, share.id);
  log.info(`reel ${reel.id} shared on ${channel.name}: video ${videoId}`);
  if (rules.link !== 'first_comment') return;
  try {
    const { commentId } = await api.commentOnPost({ pageId: channel.fb_page_id, postId: videoId, message: row.post_url });
    run('UPDATE newsite_reel_shares SET comment_id = ? WHERE id = ?', commentId, share.id);
  } catch (err) {
    run('UPDATE newsite_reel_shares SET error = ? WHERE id = ?', `Posted, but the link comment failed: ${errorMessage(err).slice(0, 300)}`, share.id);
  }
}

let running: Promise<void> | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

const defaultWake = (ms: number, wake: () => void): void => {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wake();
  }, Math.min(ms, 2 ** 31 - 1));
  wakeTimer.unref?.();
};

/** Share every reel that is ready, one at a time; wake again for the first that waits. */
export function kickReelShares(deps: ReelShareDeps): Promise<void> {
  if (running) return running;
  const now = deps.now ?? Date.now;
  running = Promise.resolve()
    .then(async () => {
      const seen = new Set<number>();
      for (;;) {
        const share = get<ReelShareRow>(
          `SELECT * FROM newsite_reel_shares WHERE status = 'pending' OR (status = 'waiting' AND retry_at <= ?) ORDER BY id LIMIT 1`,
          now(),
        );
        if (!share || seen.has(share.id)) break;
        seen.add(share.id);
        try {
          await work(share, deps, now());
        } catch (err) {
          log.error(`Reel share ${share.id} failed: ${errorMessage(err)}`);
          fail(share.id, errorMessage(err));
        }
      }
      const next = get<{ at: number | null }>(`SELECT MIN(retry_at) AS at FROM newsite_reel_shares WHERE status = 'waiting'`);
      if (next?.at) (deps.wakeIn ?? defaultWake)(Math.max(1000, next.at - now()), () => void kickReelShares(deps));
    })
    .finally(() => {
      running = null;
    });
  return running;
}
