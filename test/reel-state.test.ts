import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel,
  createRun,
  getReel,
  insertKeyword,
  markRunPublished,
  updateReel,
  upsertFbPage,
  upsertSite,
  type ReelView,
} from '../src/db/repos.js';
import { publishReel, tickReels, type ReelDeps } from '../src/reels/engine.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A reel moves on its own, one state per tick, and stops when it should.
 *
 * The gate that matters is per page: a niche page that has earned trust may
 * publish unattended while a newer one waits to be read. And a reel with no
 * page waits forever on purpose — guessing a page posts a recipe to an
 * audience that did not ask for it, which is worse than posting nothing.
 */

const KEY = randomBytes(32);

function settingsWith(enabled: boolean): Settings {
  const settings = new Settings(KEY);
  settings.set('fb_enabled', enabled ? 'true' : 'false');
  return settings;
}

function fakeDeps(overrides: Partial<ReelDeps> = {}): ReelDeps {
  return {
    images: {
      poll: vi.fn(async () => ({
        job_id: 'J1',
        status: 'PROCESSING',
        image_url: null,
        image_expires_at: null,
        error: null,
      })),
      submitVideo: vi.fn(async () => 'J1'),
    } as unknown as ReelDeps['images'],
    facebook: {
      publishReel: vi.fn(async () => ({ videoId: 'VID1', permalink: 'https://fb/VID1' })),
    } as unknown as ReelDeps['facebook'],
    telegram: { sendMessage: vi.fn(async () => true) } as unknown as ReelDeps['telegram'],
    download: vi.fn(async () => Buffer.from('mp4')),
    ...overrides,
  };
}

function seed(options: { autoPublish: boolean; withPage?: boolean }): {
  reelId: number;
  pageId: number;
} {
  const siteId = upsertSite(
    {
      name: 'bitespoon',
      domain: 'bitespoon.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 1,
      interval_minutes: 60,
    },
    KEY,
  );

  const keywordId = insertKeyword({ seed_keyword: 'slow cooker', spy_title: 'Stew' });
  const runId = createRun(keywordId, siteId);
  markRunPublished(runId, 'p1', 'https://bitespoon.com/stew', 'Stew');

  const pageId = upsertFbPage({
    pageId: '999',
    name: 'Slow Cooker Suppers',
    autoPublish: options.autoPublish,
    enabled: true,
  });

  const reelId = createReel({
    runId,
    siteId,
    keywordId,
    fbPageId: options.withPage === false ? null : pageId,
    prompt: 'a stew, steaming',
    caption: 'Stew',
    references: ['https://bitespoon.com/a.webp'],
  });

  return { reelId, pageId };
}

const completed = (url: string) =>
  vi.fn(async () => ({
    job_id: 'J1',
    status: 'COMPLETED',
    image_url: url,
    image_expires_at: null,
    error: null,
  }));

describe('a reel moving through its states', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
  });

  afterEach(() => closeDatabase());

  it('does nothing at all while Facebook publishing is off', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'generating', jobId: 'J1' });

    const deps = fakeDeps();
    const result = await tickReels(settingsWith(false), deps);

    expect(result).toEqual({ advanced: 0, failed: 0 });
    expect(deps.images.poll).not.toHaveBeenCalled();
  });

  it('leaves a reel generating while the video is not finished', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'generating', jobId: 'J1' });

    await tickReels(settingsWith(true), fakeDeps());

    expect(getReel(reelId)!.status).toBe('generating');
  });

  it('moves to ready and keeps the video when generation finishes', async () => {
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'generating', jobId: 'J1' });

    const deps = fakeDeps();
    deps.images.poll = completed('https://cdn/video.mp4');

    await tickReels(settingsWith(true), deps);

    const reel = getReel(reelId)!;
    expect(reel.status).toBe('ready');
    expect(reel.video_url).toBe('https://cdn/video.mp4');
  });

  it('fails the reel when the video job fails', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'generating', jobId: 'J1' });

    const deps = fakeDeps();
    deps.images.poll = vi.fn(async () => ({
      job_id: 'J1',
      status: 'FAILED',
      image_url: null,
      image_expires_at: null,
      error: 'reCAPTCHA rejected',
    }));

    const result = await tickReels(settingsWith(true), deps);

    expect(result.failed).toBe(1);
    const reel = getReel(reelId)!;
    expect(reel.status).toBe('failed');
    expect(reel.error).toMatch(/reCAPTCHA rejected/);
  });

  it('publishes a ready reel when its page publishes automatically', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).toHaveBeenCalledOnce();
    const reel = getReel(reelId)!;
    expect(reel.status).toBe('published');
    expect(reel.fb_video_id).toBe('VID1');
  });

  it('holds a ready reel when its page waits for a person', async () => {
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
    expect(getReel(reelId)!.status).toBe('ready');
  });

  it('holds a reel that has no page rather than guessing one', async () => {
    const { reelId } = seed({ autoPublish: true, withPage: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
    expect(getReel(reelId)!.status).toBe('ready');
  });

  it('publishes a held reel when a person releases it', async () => {
    // The Publish button and the scheduler take the same path, so a reel
    // released by hand goes out exactly as an automatic one does.
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await publishReel(getReel(reelId) as ReelView, deps);

    expect(getReel(reelId)!.status).toBe('published');
  });

  it('records a publishing failure against the reel and the page', async () => {
    const { reelId, pageId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    deps.facebook.publishReel = vi.fn(async () => {
      throw new Error('Facebook rejected reel VID1 during processing');
    });

    const result = await tickReels(settingsWith(true), deps);

    expect(result.failed).toBe(1);
    expect(getReel(reelId)!.status).toBe('failed');
    expect(pageId).toBeGreaterThan(0);
  });

  it('retries a reel left publishing by a process that died', async () => {
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'publishing', videoUrl: 'https://cdn/video.mp4' });

    await tickReels(settingsWith(true), fakeDeps());

    // Back to ready, not straight out to Facebook: the page still decides.
    expect(getReel(reelId)!.status).toBe('ready');
  });

  it('never uploads a reel that has no video', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'ready', videoUrl: null });

    const deps = fakeDeps();
    const result = await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(getReel(reelId)!.status).toBe('failed');
  });

  it('leaves published reels alone on later ticks', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, {
      status: 'published',
      videoUrl: 'https://cdn/video.mp4',
      fbVideoId: 'VID1',
    });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
    expect(getReel(reelId)!.status).toBe('published');
  });

  it('a notification failure does not unpublish a published reel', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    deps.telegram.sendMessage = vi.fn(async () => {
      throw new Error('Telegram is down');
    });

    await tickReels(settingsWith(true), deps);

    expect(getReel(reelId)!.status).toBe('published');
  });
});
