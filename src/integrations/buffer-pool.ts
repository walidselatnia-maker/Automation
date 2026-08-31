import { BufferClient, BufferError, type BufferChannel } from './buffer.js';
import {
  listBufferAccounts,
  markBufferAccountFull,
  markBufferAccountUsed,
  type BufferAccount,
} from '../db/repos.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('buffer-pool');

/**
 * A site's Buffer accounts, tried in order.
 *
 * A Buffer queue takes ten posts a day and then refuses everything until it
 * drains. That used to fail the run at its last step — the article written,
 * the images generated, the post published to the site, and only the pin lost.
 *
 * So a full queue is not a failure here. It is a signal to move to the site's
 * next account and carry on, and the run finishes exactly as it would have.
 * Only running out of accounts is a failure.
 *
 * Rotation is reactive, on Buffer's own refusal, rather than on a count kept
 * here: posts scheduled into the same account from anywhere else count against
 * the same ten, so a number maintained locally would drift from the real one.
 *
 * The interface is BufferClient's, so the pipeline steps neither know nor care
 * that there is more than one account behind it.
 */

/** How long a refused account sits out. Long enough to cover the day's runs. */
const FULL_FOR_MS = 6 * 60 * 60 * 1000;

/**
 * Rejections that mean "not through this account" rather than "not at all".
 *
 * Buffer's wording is not contractual, so this matches broadly on purpose: a
 * missed match costs a failed run, while a false positive costs one rotation
 * to an account that works. Auth failures are here for the same reason a full
 * queue is — the account cannot post, and the next one might.
 */
const ROTATE_ON = [
  'queue',
  'limit',
  'full',
  'maximum',
  'exceeded',
  'too many',
  'quota',
  'throttl',
  'rate',
  'http 429',
  'unauthorized',
  'unauthenticated',
  'forbidden',
  'http 401',
  'http 403',
  'invalid token',
  'expired',
];

/**
 * The marker that says every account is spent.
 *
 * Matched as text rather than caught as a type: the error crosses the step
 * boundary wrapped in StepFailedError and reaches the scheduler as a message,
 * so the message is the only part that survives the journey.
 */
export const BUFFER_EXHAUSTED = 'All Buffer accounts are full';

export const isBufferExhausted = (error: unknown): boolean =>
  errorMessage(error).includes(BUFFER_EXHAUSTED);

export const isRotatable = (error: unknown): boolean => {
  const text = errorMessage(error).toLowerCase();
  return ROTATE_ON.some((marker) => text.includes(marker));
};

export interface BufferPoolSite {
  id: number;
  domain: string;
  /** Picks the right channel when an account exposes more than one. */
  pinUsername: string;
}

/** Where a post is going: resolved per account, since ids do not carry over. */
export interface BufferDestination {
  channelId: string;
  boardServiceId: string;
  boardName: string;
}

export class BufferPool {
  private readonly accounts: BufferAccount[];
  private index = 0;

  constructor(
    private readonly site: BufferPoolSite,
    encryptionKey: Buffer,
    /** The site's own column, still the only account for a site with one. */
    legacyToken = '',
    now = new Date(),
  ) {
    const configured = listBufferAccounts(site.id, encryptionKey)
      .filter((a) => a.enabled && a.token.trim() !== '')
      // An account that refused recently goes last rather than being dropped:
      // if every account is full, posting through the least recently refused
      // one beats not posting at all, and Buffer decides either way.
      .sort((a, b) => {
        const fullA = a.fullUntil && a.fullUntil > now ? 1 : 0;
        const fullB = b.fullUntil && b.fullUntil > now ? 1 : 0;
        if (fullA !== fullB) return fullA - fullB;
        return a.position - b.position;
      });

    this.accounts =
      configured.length > 0
        ? configured
        : legacyToken.trim() !== ''
          ? // No rows yet: a site added before rotation existed, or one whose
            // token was typed into the site form. Its single token still works.
            [
              {
                id: 0,
                siteId: site.id,
                label: 'Site token',
                token: legacyToken,
                position: 1,
                enabled: true,
                fullUntil: null,
                lastUsedAt: null,
                lastError: null,
              },
            ]
          : [];
  }

  get size(): number {
    return this.accounts.length;
  }

  /** Which account is in use, for logs and for the run's step detail. */
  get current(): BufferAccount | undefined {
    return this.accounts[this.index];
  }

  private client(): BufferClient {
    const account = this.current;
    if (!account) {
      throw new BufferError(
        `No Buffer account is configured for ${this.site.domain}. Add one on the site page.`,
      );
    }
    return new BufferClient(account.token);
  }

  async getOrganizationId(): Promise<string> {
    return this.client().getOrganizationId();
  }

  async getChannels(organizationId: string): Promise<BufferChannel[]> {
    return this.client().getChannels(organizationId);
  }

  /**
   * The channel and board to post to on the account now in use.
   *
   * Ids belong to the account that issued them, so a rotation invalidates the
   * channel resolved before it. `preferBoard` carries the board the model
   * chose across by name, which is the only part of that choice that means
   * anything on a different account.
   */
  async resolveDestination(preferBoard = ''): Promise<BufferDestination> {
    const client = this.client();
    const channels = await client.getChannels(await client.getOrganizationId());

    if (channels.length === 0) {
      throw new BufferError('Buffer returned no channels for this organization');
    }

    const wanted = this.site.pinUsername.trim().toLowerCase();
    const channel =
      (wanted ? channels.find((c) => c.name.toLowerCase() === wanted) : undefined) ?? channels[0]!;

    if (channels.length > 1 && !wanted) {
      log.warn(
        `Buffer token for ${this.site.domain} exposes ${channels.length} channels and no ` +
          `Pinterest username is set; using "${channel.name}".`,
      );
    }

    if (channel.boards.length === 0) {
      throw new BufferError(`Buffer channel "${channel.name}" has no Pinterest boards`);
    }

    const board =
      channel.boards.find((b) => b.name.toLowerCase() === preferBoard.trim().toLowerCase()) ??
      channel.boards[0]!;

    return {
      channelId: channel.id,
      boardServiceId: board.serviceId,
      boardName: board.name,
    };
  }

  /**
   * Schedule a pin, moving down the accounts while Buffer refuses.
   *
   * The caller passes the destination it resolved earlier. Every rotation
   * re-resolves it against the new account, because a channel id from one
   * account means nothing on another.
   */
  async createPost(
    input: {
      text: string;
      channelId: string;
      imageUrl: string;
      altText: string;
      title: string;
      linkUrl: string;
      boardServiceId: string;
    },
    boardName = '',
  ): Promise<{ postId: string; account: string; destination: BufferDestination }> {
    if (this.accounts.length === 0) {
      throw new BufferError(
        `No Buffer account is configured for ${this.site.domain}. Add one on the site page.`,
      );
    }

    let destination: BufferDestination = {
      channelId: input.channelId,
      boardServiceId: input.boardServiceId,
      boardName,
    };
    let lastError = '';

    for (; this.index < this.accounts.length; this.index++) {
      const account = this.accounts[this.index]!;

      // Every account after the first needs its own channel and board: the
      // ones resolved for the previous account do not exist here.
      if (this.index > 0) {
        try {
          destination = await this.resolveDestination(boardName);
        } catch (err) {
          lastError = errorMessage(err);
          log.warn(`Buffer account "${account.label}" has no usable channel`, lastError);
          if (account.id > 0) {
            markBufferAccountFull(account.id, lastError, new Date(Date.now() + FULL_FOR_MS));
          }
          continue;
        }
      }

      try {
        const postId = await new BufferClient(account.token).createPost({
          ...input,
          channelId: destination.channelId,
          boardServiceId: destination.boardServiceId,
        });

        if (account.id > 0) markBufferAccountUsed(account.id);
        return { postId, account: account.label, destination };
      } catch (err) {
        lastError = errorMessage(err);

        // A rejection this pool cannot fix — a malformed post, an image Buffer
        // will not fetch — fails the same way on every account. Retrying it
        // five times would only spend five accounts saying so.
        if (!isRotatable(err)) throw err;

        log.warn(
          `Buffer account "${account.label}" refused the post, moving to the next: ${lastError}`,
        );
        if (account.id > 0) {
          markBufferAccountFull(account.id, lastError, new Date(Date.now() + FULL_FOR_MS));
        }
      }
    }

    throw new BufferError(
      `${BUFFER_EXHAUSTED}: all ${this.accounts.length} Buffer account(s) for ` +
        `${this.site.domain} refused the post. Last reason: ${lastError}`,
    );
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    if (this.accounts.length === 0) return { ok: false, error: 'No Buffer account configured' };
    return this.client().healthCheck();
  }
}
