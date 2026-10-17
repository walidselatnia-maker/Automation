import { all } from '../db/index.js';
import { ThreadsClient } from '../integrations/threads.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { fbTokenOf, getChannel, saveChannelToken, type ChannelRow } from './channels.js';

/**
 * A Threads token lasts 60 days and can only be renewed while it still works,
 * so each Threads channel's token is renewed once fewer than RENEW_DAYS are
 * left: when it is used, and by the sharing timer for channels not used in a
 * while. A token that ran out has to be pasted again on the channel's page.
 */

const log = createLogger('newsite-threads-token');
const RENEW_DAYS = 10;

export type Renew = (token: string) => Promise<{ token: string; expiresAt: number }>;
const realRenew: Renew = (token) => new ThreadsClient({ token }).refresh();

/** The channel's working Threads token, renewed first when it runs out soon. */
export async function threadsTokenOf(channel: ChannelRow, key: Buffer, renew: Renew = realRenew, now = Date.now()): Promise<string> {
  const token = fbTokenOf(channel, key);
  const ends = channel.token_expires_at;
  if (!ends || ends - now > RENEW_DAYS * 86_400_000) return token;
  if (ends <= now) {
    throw new Error(`The Threads token of “${channel.name}” ran out on ${new Date(ends).toISOString().slice(0, 10)}. Add the channel again with a new token (Channels → Add a channel → Threads → Through the Threads API): it updates this one.`);
  }
  try {
    const fresh = await renew(token);
    saveChannelToken(channel.id, fresh.token, fresh.expiresAt, key);
    log.info(`Threads token of channel ${channel.id} renewed until ${new Date(fresh.expiresAt).toISOString().slice(0, 10)}`);
    return fresh.token;
  } catch (err) {
    log.warn(`Threads token of channel ${channel.id} could not be renewed yet: ${errorMessage(err)}`);
    return token;
  }
}

/** Renew every Threads token that runs out soon. */
export async function renewThreadsTokens(key: Buffer, renew: Renew = realRenew): Promise<void> {
  for (const { id } of all<{ id: number }>(`SELECT id FROM newsite_channels WHERE platform = 'threads' AND via = 'api'`)) {
    const c = getChannel(id);
    if (c) await threadsTokenOf(c, key, renew).catch((err) => log.warn(errorMessage(err)));
  }
}
