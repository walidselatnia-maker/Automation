import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  BUFFER_ACCOUNT_LIMIT,
  listBufferAccounts,
  upsertBufferAccount,
  upsertSite,
} from '../src/db/repos.js';
import { BufferPool, isRotatable } from '../src/integrations/buffer-pool.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A full Buffer queue must not lose a finished article.
 *
 * Ten posts a day and Buffer refuses everything until it drains. That refusal
 * arrived at the last step of the run — article written, images generated, post
 * already live on the site — and failed the whole thing over the pin. The site
 * moves to its next Buffer account instead, and the run finishes.
 */

const KEY = randomBytes(32);

const seedSite = (): number =>
  upsertSite(
    {
      name: 'bitespoon',
      domain: 'bitespoon.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 3,
      interval_minutes: 60,
    },
    KEY,
  );

/** Buffer's HTTP surface, so the pool is exercised without the network. */
const bufferReplies = (
  handlers: { queueFullFor?: string[]; failAllWith?: string } = {},
): ReturnType<typeof vi.fn> => {
  const calls: { token: string; query: string }[] = [];

  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).Authorization).replace(
      'Bearer ',
      '',
    );
    const query = String(init.body);
    calls.push({ token, query });

    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

    if (query.includes('GetOrganizations')) {
      return json({ data: { account: { organizations: [{ id: `org-${token}`, name: token }] } } });
    }

    if (query.includes('GetChannelsWithBoards')) {
      return json({
        data: {
          channels: [
            {
              id: `channel-${token}`,
              name: 'pinterest',
              metadata: { boards: [{ serviceId: `board-${token}`, name: 'Dinners' }] },
            },
          ],
        },
      });
    }

    // createPost
    if (handlers.failAllWith) {
      return json({ data: { createPost: { message: handlers.failAllWith } } });
    }
    if (handlers.queueFullFor?.includes(token)) {
      return json({
        data: { createPost: { message: 'You have reached the maximum queue size for this day' } },
      });
    }
    return json({ data: { createPost: { post: { id: `post-${token}` } } } });
  });

  (fetchMock as unknown as { calls: typeof calls }).calls = calls;
  return fetchMock;
};

const post = {
  text: 'A pin',
  channelId: 'channel-token-1',
  imageUrl: 'https://bitespoon.com/pin.jpg',
  altText: 'alt',
  title: 'Honey Soy Chicken Thighs',
  linkUrl: 'https://bitespoon.com/recipe',
  boardServiceId: 'board-token-1',
};

let originalFetch: typeof fetch;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDatabase();
});

describe('recognising a refusal worth rotating on', () => {
  it.each([
    'Buffer rejected the post: You have reached the maximum queue size',
    'Buffer HTTP 429: too many requests',
    'Buffer rejected the post: daily limit reached',
    'Buffer HTTP 401: unauthorized',
    'Buffer rejected the post: token expired',
  ])('rotates on %s', (message) => {
    expect(isRotatable(new Error(message))).toBe(true);
  });

  it.each([
    'Buffer rejected the post: image could not be fetched',
    'Buffer returned no data',
    'Buffer rejected the post: text is required',
  ])('does not rotate on %s', (message) => {
    // These fail identically on every account. Retrying would only spend five
    // accounts arriving at the same answer.
    expect(isRotatable(new Error(message))).toBe(false);
  });
});

describe('a site with several Buffer accounts', () => {
  it('moves to the next account when the queue is full, and still posts', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'Main', token: 'token-1', enabled: true }, KEY);
    upsertBufferAccount({ siteId, label: 'Overflow', token: 'token-2', enabled: true }, KEY);

    globalThis.fetch = bufferReplies({ queueFullFor: ['token-1'] }) as unknown as typeof fetch;

    const pool = new BufferPool({ id: siteId, domain: 'bitespoon.com', pinUsername: '' }, KEY);
    const result = await pool.createPost(post, 'Dinners');

    expect(result.postId).toBe('post-token-2');
    expect(result.account).toBe('Overflow');

    // The channel and board come from the account that actually took the post:
    // ids issued by one Buffer account mean nothing on another.
    expect(result.destination.channelId).toBe('channel-token-2');
    expect(result.destination.boardServiceId).toBe('board-token-2');
  });

  it('records which account is full, so the site page can say so', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'Main', token: 'token-1', enabled: true }, KEY);
    upsertBufferAccount({ siteId, label: 'Overflow', token: 'token-2', enabled: true }, KEY);

    globalThis.fetch = bufferReplies({ queueFullFor: ['token-1'] }) as unknown as typeof fetch;

    await new BufferPool({ id: siteId, domain: 'bitespoon.com', pinUsername: '' }, KEY).createPost(
      post,
      'Dinners',
    );

    const [main, overflow] = listBufferAccounts(siteId, KEY);
    expect(main!.fullUntil).toBeInstanceOf(Date);
    expect(main!.lastError).toContain('maximum queue size');
    expect(overflow!.fullUntil).toBeNull();
  });

  it('tries a full account last rather than dropping it', async () => {
    // If every account is full, posting through the one that refused longest
    // ago beats not posting at all. Buffer decides either way.
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'Main', token: 'token-1', enabled: true }, KEY);
    upsertBufferAccount({ siteId, label: 'Overflow', token: 'token-2', enabled: true }, KEY);

    globalThis.fetch = bufferReplies({ queueFullFor: ['token-1'] }) as unknown as typeof fetch;
    await new BufferPool({ id: siteId, domain: 'bitespoon.com', pinUsername: '' }, KEY).createPost(
      post,
      'Dinners',
    );

    // Main is now marked full, so the next run should start on Overflow.
    globalThis.fetch = bufferReplies() as unknown as typeof fetch;
    const second = await new BufferPool(
      { id: siteId, domain: 'bitespoon.com', pinUsername: '' },
      KEY,
    ).createPost(post, 'Dinners');

    expect(second.account).toBe('Overflow');
  });

  it('skips an account that is switched off', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'Main', token: 'token-1', enabled: false }, KEY);
    upsertBufferAccount({ siteId, label: 'Overflow', token: 'token-2', enabled: true }, KEY);

    globalThis.fetch = bufferReplies() as unknown as typeof fetch;
    const result = await new BufferPool(
      { id: siteId, domain: 'bitespoon.com', pinUsername: '' },
      KEY,
    ).createPost(post, 'Dinners');

    expect(result.account).toBe('Overflow');
  });

  it('fails only once every account has refused', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'Main', token: 'token-1', enabled: true }, KEY);
    upsertBufferAccount({ siteId, label: 'Overflow', token: 'token-2', enabled: true }, KEY);

    globalThis.fetch = bufferReplies({
      queueFullFor: ['token-1', 'token-2'],
    }) as unknown as typeof fetch;

    const pool = new BufferPool({ id: siteId, domain: 'bitespoon.com', pinUsername: '' }, KEY);
    await expect(pool.createPost(post, 'Dinners')).rejects.toThrow(/All 2 Buffer account/);
  });

  it('does not spend accounts on a rejection no account can fix', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'Main', token: 'token-1', enabled: true }, KEY);
    upsertBufferAccount({ siteId, label: 'Overflow', token: 'token-2', enabled: true }, KEY);

    globalThis.fetch = bufferReplies({
      failAllWith: 'image could not be fetched',
    }) as unknown as typeof fetch;

    const pool = new BufferPool({ id: siteId, domain: 'bitespoon.com', pinUsername: '' }, KEY);
    await expect(pool.createPost(post, 'Dinners')).rejects.toThrow(/image could not be fetched/);

    // Nothing was marked full: the post is the problem, not the account.
    expect(listBufferAccounts(siteId, KEY).every((a) => a.fullUntil === null)).toBe(true);
  });
});

describe('a site with one account, as before', () => {
  it('uses the token on the site form when no accounts are configured', async () => {
    const siteId = upsertSite(
      {
        name: 'bitespoon',
        domain: 'bitespoon.com',
        status: 'active',
        pin_username: '',
        project_id: '',
        daily_target: 3,
        interval_minutes: 60,
        bufferToken: 'legacy-token',
      },
      KEY,
    );

    globalThis.fetch = bufferReplies() as unknown as typeof fetch;
    const pool = new BufferPool(
      { id: siteId, domain: 'bitespoon.com', pinUsername: '' },
      KEY,
      'legacy-token',
    );

    expect(pool.size).toBe(1);
    expect((await pool.createPost(post, 'Dinners')).postId).toBe('post-legacy-token');
  });

  it('says so plainly when there is no account at all', async () => {
    const siteId = seedSite();
    const pool = new BufferPool({ id: siteId, domain: 'bitespoon.com', pinUsername: '' }, KEY);
    await expect(pool.createPost(post)).rejects.toThrow(/No Buffer account is configured/);
  });
});

describe('the account limit', () => {
  it('refuses a sixth account', () => {
    const siteId = seedSite();
    for (let i = 1; i <= BUFFER_ACCOUNT_LIMIT; i++) {
      upsertBufferAccount({ siteId, label: `Account ${i}`, token: `token-${i}`, enabled: true }, KEY);
    }

    expect(() =>
      upsertBufferAccount({ siteId, label: 'One too many', token: 'token-6', enabled: true }, KEY),
    ).toThrow(/at most 5/);
  });

  it('keeps the stored token when a save leaves the field blank', () => {
    const siteId = seedSite();
    const id = upsertBufferAccount({ siteId, label: 'Main', token: 'token-1', enabled: true }, KEY);

    upsertBufferAccount({ siteId, label: 'Renamed', token: '', enabled: true }, KEY, id);

    const [account] = listBufferAccounts(siteId, KEY);
    expect(account!.label).toBe('Renamed');
    expect(account!.token).toBe('token-1');
  });
});
