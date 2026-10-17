import { all, run } from '../db/index.js';
import { BufferClient } from '../integrations/buffer.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { bufferTokenOf, getChannel } from './channels.js';

/**
 * The link to each shared post on its platform.
 *
 * A post sent through the Facebook API has its address at once. A post given
 * to Buffer only has one once Buffer has sent it, which can be hours later,
 * so Buffer is asked again for every queued post with no link yet: what it
 * answers as the post's externalLink becomes the link on the Sharing pages.
 * A post Buffer could not send is marked failed with Buffer's reason, so it
 * can be tried again.
 */

const log = createLogger('newsite-post-links');

/** What reading a Buffer post can do; replaceable so tests call no real Buffer. */
export interface BufferPostReader {
  getPost: (id: string) => Promise<{ status: string; externalLink: string; error: string }>;
}

export interface PostLinkDeps {
  encryptionKey: Buffer;
  buffer?: (token: string) => BufferPostReader;
}

const TABLES = ['newsite_social_posts', 'newsite_reel_shares'] as const;

let running: Promise<number> | null = null;
let lastRun = 0;

/** Ask Buffer about every sent post that has no link yet. Returns how many links were found. */
export function refreshPostLinks(deps: PostLinkDeps): Promise<number> {
  if (running) return running;
  lastRun = Date.now();
  running = (async () => {
    let found = 0;
    const readers = new Map<number, BufferPostReader>();
    for (const table of TABLES) {
      const rows = all<{ id: number; channel_id: number; external_id: string }>(
        `SELECT t.id, t.channel_id, t.external_id FROM ${table} t JOIN newsite_channels c ON c.id = t.channel_id
          WHERE t.status = 'sent' AND t.post_link = '' AND t.external_id <> '' AND c.via = 'buffer'`,
      );
      for (const row of rows) {
        let reader = readers.get(row.channel_id);
        if (!reader) {
          const channel = getChannel(row.channel_id);
          if (!channel) continue;
          const token = bufferTokenOf(channel, deps.encryptionKey);
          reader = (deps.buffer ?? ((t: string) => new BufferClient(t)))(token);
          readers.set(row.channel_id, reader);
        }
        try {
          const post = await reader.getPost(row.external_id);
          if (post.externalLink) {
            run(`UPDATE ${table} SET post_link = ? WHERE id = ?`, post.externalLink, row.id);
            found += 1;
          } else if (post.status.toLowerCase() === 'error') {
            run(`UPDATE ${table} SET status = 'failed', error = ? WHERE id = ?`, `Buffer could not post it: ${post.error || 'no reason given'}`.slice(0, 900), row.id);
          }
        } catch (err) {
          log.warn(`${table} ${row.id}: Buffer did not say where the post is: ${errorMessage(err)}`);
        }
      }
    }
    return found;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** On a page view: ask again, at most every few minutes. */
export function refreshPostLinksSoon(deps: PostLinkDeps, everyMs = 3 * 60_000): void {
  if (Date.now() - lastRun < everyMs) return;
  void refreshPostLinks(deps).catch(() => {});
}
