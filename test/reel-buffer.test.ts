import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel,
  getFbPage,
  getReel,
  insertFbToken,
  insertKeyword,
  setFbPageBufferChannel,
  setFbPageOptions,
  updateReel,
  upsertFbPage,
  upsertSite,
  type ReelView,
} from '../src/db/repos.js';
import { publishReel, type ReelDeps } from '../src/reels/engine.js';
import {
  bufferCaption,
  reelPublisher,
  sendReelToBuffer,
  type BufferReelDeps,
} from '../src/reels/buffer.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Reels handed to Buffer instead of uploaded to the page.
 *
 * The two are not variations of one thing. Buffer posts later, on its own
 * queue, which is why the video has to live at an address that outlasts this
 * process and why there is no first comment to put the link in. Both of those
 * are pinned here, along with the refusals: a page with no channel, and a
 * missing token, must say so rather than post somewhere plausible.
 */

const KEY = randomBytes(32);

function settingsWith(overrides: Record<string, string> = {}): Settings {
  const settings = new Settings(KEY);
  settings.set('fb_enabled', 'true');
  settings.set('reel_publisher', 'buffer');
  settings.set('reel_buffer_token', 'buffer-token');
  for (const [key, value] of Object.entries(overrides)) settings.set(key, value);
  return settings;
}

function seed(options: { channel?: { id: string; name: string } | null } = {}): {
  reelId: number;
  pageId: number;
} {
  const siteId = upsertSite(
    { name: 'bitespoon', domain: 'bitespoon.com', status: 'active', daily_target: 1,
      interval_minutes: 60, pin_username: '', project_id: '', paused_reason: '' },
    KEY,
  );
  const keywordId = insertKeyword({ seed_keyword: 'soup', spy_title: 'Soup' });
  const tokenId = insertFbToken('App', 'tok', KEY);
  const pageId = upsertFbPage({ pageId: '77', name: 'Soup Page', tokenId });
  setFbPageOptions(pageId, { niche: 'soup', autoPublish: true, enabled: true });
  if (options.channel !== null) {
    setFbPageBufferChannel(pageId, options.channel ?? { id: 'CH1', name: 'Soup Daily' });
  }

  const reelId = createReel({
    runId: null, siteId, keywordId, fbPageId: pageId,
    prompt: 'p', caption: 'A warm bowl of soup', references: [], stage: 'done',
  });
  updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });
  return { reelId, pageId };
}

function bufferDeps(overrides: Partial<BufferReelDeps> = {}) {
  const createVideoPost = vi.fn(async () => 'BUF-1');
  const hostVideo = vi.fn(async () => 'https://bitespoon.com/uploads/reel.mp4');
  const deps: BufferReelDeps = {
    readVideo: vi.fn(async () => Buffer.from('mp4')),
    hostVideo,
    client: () => ({ createVideoPost }) as never,
    ...overrides,
  };
  return { deps, createVideoPost, hostVideo };
}

function engineDeps(buffer: BufferReelDeps): ReelDeps {
  const facebook = {
    publishReel: vi.fn(async () => ({ videoId: 'VID1', permalink: 'https://fb/VID1' })),
    commentOnReel: vi.fn(async () => ({ commentId: 'C1' })),
  };
  return {
    facebookFor: vi.fn(() => facebook),
    images: {} as ReelDeps['images'],
    telegram: { sendMessage: vi.fn(async () => true) } as unknown as ReelDeps['telegram'],
    download: vi.fn(async () => Buffer.from('mp4')),
    prompt: vi.fn(async () => ({ content: '{}' })),
    clipsDir: '',
    assemble: vi.fn(async () => {}),
    uploadImage: vi.fn(async () => ''),
    pause: vi.fn(async () => {}),
    encryptionKey: KEY,
    buffer,
    // Exposed for the assertion that Graph was not touched.
    ...( { facebook } as object ),
  } as ReelDeps & { facebook: typeof facebook };
}

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
});

afterEach(() => closeDatabase());

describe('publishing a reel through Buffer', () => {
  it('sends the video to the page’s channel and records Buffer’s post id', async () => {
    const { reelId } = seed();
    const { deps, createVideoPost, hostVideo } = bufferDeps();

    await publishReel(getReel(reelId) as ReelView, engineDeps(deps), settingsWith());

    // Hosted first: Buffer fetches the file when the post goes out, which may
    // be hours after this, so a signed Flow url would be dead by then.
    expect(hostVideo).toHaveBeenCalled();
    expect(createVideoPost).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'CH1',
        videoUrl: 'https://bitespoon.com/uploads/reel.mp4',
      }),
    );
    expect(getReel(reelId)).toMatchObject({ status: 'published', buffer_post_id: 'BUF-1' });
  });

  it('never uploads to the page when Buffer is the way out', async () => {
    const { reelId } = seed();
    const { deps } = bufferDeps();
    const engine = engineDeps(deps) as ReelDeps & { facebook: { publishReel: ReturnType<typeof vi.fn> } };

    await publishReel(getReel(reelId) as ReelView, engine, settingsWith());

    expect(engine.facebook.publishReel).not.toHaveBeenCalled();
    expect(getReel(reelId)!.fb_video_id).toBeNull();
  });

  it('refuses a page that names no channel rather than picking one', async () => {
    // Posting a page's reel to whichever channel came first is how a recipe
    // reaches an audience that never asked for it.
    const { reelId } = seed({ channel: null });
    const { deps, createVideoPost } = bufferDeps();

    await expect(
      publishReel(getReel(reelId) as ReelView, engineDeps(deps), settingsWith()),
    ).rejects.toThrow(/no Buffer channel/i);
    expect(createVideoPost).not.toHaveBeenCalled();
  });

  it('refuses when there is no Buffer token', async () => {
    const { reelId } = seed();
    const { deps } = bufferDeps({ client: () => null });

    await expect(
      sendReelToBuffer(getReel(reelId) as ReelView, settingsWith({ reel_buffer_token: '' }), deps),
    ).rejects.toThrow(/No Buffer token/i);
  });

  it('keeps the channel name beside the id, so the table can name it', () => {
    const { pageId } = seed({ channel: { id: 'CH9', name: 'Dinner Ideas' } });
    expect(getFbPage(pageId)).toMatchObject({
      buffer_channel_id: 'CH9',
      buffer_channel_name: 'Dinner Ideas',
    });
  });
});

describe('the caption Buffer is given', () => {
  it('carries the article link, because a queued post has no first comment', () => {
    const { reelId } = seed();
    updateReel(reelId, { status: 'ready' });
    const reel = { ...(getReel(reelId) as ReelView), post_url: 'https://bitespoon.com/soup' };

    expect(bufferCaption(reel, settingsWith())).toBe(
      'A warm bowl of soup\n\nhttps://bitespoon.com/soup',
    );
  });

  it('leaves the caption alone when the link is switched off', () => {
    const { reelId } = seed();
    const reel = { ...(getReel(reelId) as ReelView), post_url: 'https://bitespoon.com/soup' };

    expect(bufferCaption(reel, settingsWith({ reel_buffer_link_in_text: 'false' }))).toBe(
      'A warm bowl of soup',
    );
  });

  it('does not repeat a link the caption already carries', () => {
    // The caption is written by a model, and nothing stops it adding one.
    const { reelId } = seed();
    updateReel(reelId, { caption: 'Soup: https://bitespoon.com/soup' });
    const reel = { ...(getReel(reelId) as ReelView), post_url: 'https://bitespoon.com/soup' };

    expect(bufferCaption(reel, settingsWith())).toBe('Soup: https://bitespoon.com/soup');
  });
});

describe('which way out is taken', () => {
  it('is Graph unless Buffer is chosen, including for a value it does not know', () => {
    expect(reelPublisher(new Settings(KEY))).toBe('facebook');
    expect(reelPublisher(settingsWith({ reel_publisher: 'something-else' }))).toBe('facebook');
    expect(reelPublisher(settingsWith())).toBe('buffer');
  });
});
