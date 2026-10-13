import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  checkMediaToken,
  linkDays,
  mediaPath,
  pictureMediaUrl,
  publicBaseUrlProblem,
  reelMediaUrl,
  DEFAULT_LINK_DAYS,
  MAX_LINK_DAYS,
  MIN_LINK_DAYS,
} from '../src/core/media-links.js';
import { rangeOf } from '../src/web/media.js';
import { createReel, insertKeyword, upsertSite, type ReelView } from '../src/db/repos.js';
import { bufferReelDeps } from '../src/reels/buffer.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { run } from '../src/db/index.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { pictureDir } from '../src/newsite/pictures.js';
import { resolveDataDir } from '../src/config.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Reel videos are served straight from this platform, to fetchers that cannot
 * log in: Buffer downloads the file itself, from its own servers, when the
 * queued post goes out.
 *
 * That makes this the one route the password does not guard, so what is
 * pinned here is everything standing in its place. A link that was edited, a
 * link signed with the wrong key, a link past its expiry and a link to a reel
 * that does not exist must all fail -- and the exemption must be narrow
 * enough that nothing else on the platform came open with it.
 */

const SECRET = randomBytes(32);
const VIDEO = Buffer.from('not really an mp4, but bytes are bytes');

const signatureIn = (path: string): string =>
  path.split('/').pop()!.replace(/\.mp4$/, '');

describe('signing a media link', () => {
  const link = (over: Partial<{ id: number; expiresAt: number }> = {}) => {
    const id = over.id ?? 7;
    const expiresAt = over.expiresAt ?? Date.now() + 60_000;
    return { id, expiresAt, signature: signatureIn(mediaPath('reel', id, expiresAt, SECRET)) };
  };

  it('accepts the link it just made', () => {
    expect(checkMediaToken({ kind: 'reel', ...link() }, SECRET)).toEqual({ ok: true });
  });

  it('refuses a link whose reel id was edited', () => {
    // The whole point: one link opens one video, not the next id along.
    const original = link({ id: 7 });

    expect(checkMediaToken({ kind: 'reel', ...original, id: 8 }, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a link whose expiry was pushed out', () => {
    const original = link({ expiresAt: Date.now() + 60_000 });
    const extended = { ...original, expiresAt: original.expiresAt + 86_400_000 };

    expect(checkMediaToken({ kind: 'reel', ...extended }, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a link signed with another platform secret', () => {
    const expiresAt = Date.now() + 60_000;
    const signature = signatureIn(mediaPath('reel', 7, expiresAt, randomBytes(32)));

    expect(checkMediaToken({ kind: 'reel', id: 7, expiresAt, signature }, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('says expired only for a link that was genuinely ours', () => {
    // Order matters. Telling a guesser "expired" for an unsigned link would
    // be telling them the rest of what they sent was right.
    const dead = link({ expiresAt: Date.now() - 1 });

    expect(checkMediaToken({ kind: 'reel', ...dead }, SECRET)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(checkMediaToken({ ...dead, kind: 'reel', signature: 'rubbish' }, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses nonsense in the numbers rather than trusting them', () => {
    const bad = { kind: 'reel' as const, signature: 'x', expiresAt: Date.now() + 1000 };

    expect(checkMediaToken({ ...bad, id: 0 }, SECRET).ok).toBe(false);
    expect(checkMediaToken({ ...bad, id: -1 }, SECRET).ok).toBe(false);
    expect(checkMediaToken({ ...bad, id: 1.5 }, SECRET).ok).toBe(false);
    expect(checkMediaToken({ ...bad, id: Number.NaN }, SECRET).ok).toBe(false);
  });
});

describe('how long a link lasts', () => {
  it('clamps to a range a queue can actually reach', () => {
    expect(linkDays(0)).toBe(MIN_LINK_DAYS);
    expect(linkDays(-5)).toBe(MIN_LINK_DAYS);
    expect(linkDays(9999)).toBe(MAX_LINK_DAYS);
    expect(linkDays(undefined)).toBe(DEFAULT_LINK_DAYS);
    expect(linkDays('')).toBe(DEFAULT_LINK_DAYS);
    expect(linkDays('7')).toBe(7);
  });

  it('is measured from now, and said in the url itself', () => {
    const now = 1_700_000_000_000;
    const url = reelMediaUrl('https://reels.example.com/', 3, 2, SECRET, now);

    expect(url).toContain(`/media/reel/3/${now + 2 * 86_400_000}/`);
    // The trailing slash on the base is not doubled into the path.
    expect(url.startsWith('https://reels.example.com/media/')).toBe(true);
  });
});

describe('the public address someone typed', () => {
  it('accepts an ordinary https host', () => {
    expect(publicBaseUrlProblem('https://reels.example.com')).toBeNull();
    expect(publicBaseUrlProblem('')).toBeNull();
  });

  it('refuses what Buffer could never fetch', () => {
    // Every one of these fails silently in production: Buffer takes the post,
    // cannot reach the video, and the reel never appears anywhere.
    expect(publicBaseUrlProblem('http://reels.example.com')).toMatch(/https/i);
    expect(publicBaseUrlProblem('https://localhost:8080')).toMatch(/open internet/i);
    expect(publicBaseUrlProblem('https://127.0.0.1')).toMatch(/open internet/i);
    expect(publicBaseUrlProblem('https://192.168.1.10')).toMatch(/open internet/i);
    expect(publicBaseUrlProblem('https://10.0.0.4')).toMatch(/open internet/i);
    expect(publicBaseUrlProblem('https://172.16.4.4')).toMatch(/open internet/i);
    expect(publicBaseUrlProblem('reels.example.com')).toMatch(/not a url/i);
    expect(publicBaseUrlProblem('https://reels.example.com/reels')).toMatch(/path/i);
  });
});

describe('a range request', () => {
  it('reads the piece that was asked for', () => {
    expect(rangeOf('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(rangeOf('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(rangeOf('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('never reads past the end of the file', () => {
    expect(rangeOf('bytes=900-99999', 1000)).toEqual({ start: 900, end: 999 });
    expect(rangeOf('bytes=-99999', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('is nothing at all when none was asked for', () => {
    expect(rangeOf(undefined, 1000)).toBeNull();
    expect(rangeOf('bytes=-', 1000)).toBeNull();
    // Several ranges at once: answered with the whole file, which is allowed.
    expect(rangeOf('bytes=0-10,20-30', 1000)).toBeNull();
    expect(rangeOf('items=0-10', 1000)).toBeNull();
  });

  it('refuses one that starts past the end', () => {
    expect(rangeOf('bytes=1000-1100', 1000)).toBe('unsatisfiable');
    expect(rangeOf('bytes=800-700', 1000)).toBe('unsatisfiable');
  });
});

describe('fetching a reel video without logging in', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let clipsDir: string;
  let reelId: number;
  const previousDbPath = process.env.DB_PATH;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'media-'));
    // What the server reads to work out where clips live.
    process.env.DB_PATH = join(dataDir, 'platform.db');
    clipsDir = join(dataDir, 'reels');
    mkdirSync(clipsDir, { recursive: true });
  });

  afterAll(() => {
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');

    const siteId = upsertSite(
      {
        name: 'bitespoon', domain: 'bitespoon.com', status: 'active', daily_target: 1,
        interval_minutes: 60, pin_username: '', project_id: '', paused_reason: '',
      },
      SECRET,
    );
    const keywordId = insertKeyword({ seed_keyword: 'soup' });
    reelId = createReel({
      runId: null, siteId, keywordId, fbPageId: null,
      prompt: 'p', caption: 'c', references: [], stage: 'done',
    });
    writeFileSync(join(clipsDir, `${reelId}.mp4`), VIDEO);

    app = buildServer(new Settings(SECRET), SECRET, {
      password: 'correct-horse-battery-staple',
      secret: SECRET,
      generated: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  const pathFor = (over: { id?: number; expiresAt?: number } = {}): string =>
    mediaPath('reel', over.id ?? reelId, over.expiresAt ?? Date.now() + 60_000, SECRET);

  it('hands over the video to a request with no cookie at all', async () => {
    const response = await app.inject({ method: 'GET', url: pathFor() });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('video/mp4');
    expect(response.headers['content-length']).toBe(String(VIDEO.byteLength));
    expect(response.rawPayload.equals(VIDEO)).toBe(true);
  });

  it('never lets anything cache or index it', async () => {
    // A url that carries its own authorisation must not end up in a shared
    // cache or a search index.
    const response = await app.inject({ method: 'GET', url: pathFor() });

    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-robots-tag']).toContain('noindex');
  });

  it('answers a range request with that range and nothing more', async () => {
    // Facebook's fetcher pulls a video in pieces; answering with the whole
    // file from byte zero hands it something corrupt after the first piece.
    const response = await app.inject({
      method: 'GET',
      url: pathFor(),
      headers: { range: 'bytes=4-9' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 4-9/${VIDEO.byteLength}`);
    expect(response.rawPayload.equals(VIDEO.subarray(4, 10))).toBe(true);
  });

  it('says a range may be asked for, so a fetcher knows it can', async () => {
    const response = await app.inject({ method: 'HEAD', url: pathFor() });

    expect(response.statusCode).toBe(200);
    expect(response.headers['accept-ranges']).toBe('bytes');
  });

  it('refuses a link whose signature was not ours', async () => {
    const forged = pathFor().replace(/\/[^/]+\.mp4$/, `/${'A'.repeat(43)}.mp4`);
    const response = await app.inject({ method: 'GET', url: forged });

    expect(response.statusCode).toBe(404);
    // Not the login page either: a fetcher must never be handed HTML in
    // place of a video and take it for one.
    expect(response.body).not.toContain('<form');
  });

  it('refuses a link edited to point at another reel', async () => {
    const edited = pathFor().replace(`/media/reel/${reelId}/`, `/media/reel/${reelId + 1}/`);

    expect((await app.inject({ method: 'GET', url: edited })).statusCode).toBe(404);
  });

  it('says gone, not found, once the link has expired', async () => {
    // Worth telling apart: this one means a queued post outlived its video,
    // which is a setting to change rather than someone at the door.
    const response = await app.inject({
      method: 'GET',
      url: pathFor({ expiresAt: Date.now() - 1000 }),
    });

    expect(response.statusCode).toBe(410);
  });

  it('refuses a signed link to a reel that no longer exists', async () => {
    const response = await app.inject({ method: 'GET', url: pathFor({ id: reelId + 500 }) });

    expect(response.statusCode).toBe(404);
  });

  it('opens nothing else on the platform', async () => {
    // The exemption is for signed reads under /media only. Every other path,
    // and every write, still meets the password.
    expect((await app.inject({ method: 'GET', url: '/settings/reels' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: pathFor() })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/media/reel/1/1/x.mp4' })).statusCode).toBe(404);
  });

  describe('a new-website picture (pins, image posts through Buffer)', () => {
    const PICTURE = Buffer.from('not really a png');
    let pictureId: number;

    beforeEach(() => {
      const websiteId = createNewWebsite(
        {
          name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '',
          persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
          bufferToken: '', pinUsername: '', projectId: '',
        },
        SECRET,
      );
      const planId = saveKeywordPlan(websiteId, 'strawberry cake', [], 'recipe');
      queuePlanSeo(planId, 'strawberry cake', [], 'recipe');
      const seoId = listPlanSeo(planId)[0]!.id;
      pictureId = Number(
        run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, file) VALUES (?, 'pin-1', 0, 'p', 'a', 'done', 'pin-1.png')`, seoId).lastInsertRowid,
      );
      mkdirSync(pictureDir(seoId, resolveDataDir()), { recursive: true });
      writeFileSync(join(pictureDir(seoId, resolveDataDir()), 'pin-1.png'), PICTURE);
    });

    const picturePath = (id = pictureId, expiresAt = Date.now() + 60_000, secret = SECRET) =>
      new URL(pictureMediaUrl('https://dash.example.com', id, 'png', 1, secret, expiresAt - 86_400_000)).pathname;

    it('hands the picture to a request with no cookie, by its signed link', async () => {
      const response = await app.inject({ method: 'GET', url: picturePath() });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('image/png');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.rawPayload.equals(PICTURE)).toBe(true);
    });

    it('refuses an edited, foreign or expired link', async () => {
      const good = picturePath();
      expect((await app.inject({ method: 'GET', url: good.replace(`/picture/${pictureId}/`, `/picture/${pictureId + 1}/`) })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: picturePath(pictureId, Date.now() + 60_000, randomBytes(32)) })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: picturePath(pictureId, Date.now() - 1000) })).statusCode).toBe(410);
      // A reel's signature does not open a picture with the same id.
      const reelSig = mediaPath('reel', pictureId, Date.now() + 60_000, SECRET).split('/').slice(-3).join('/').replace('.mp4', '.png');
      expect((await app.inject({ method: 'GET', url: `/media/picture/${reelSig}` })).statusCode).toBe(404);
    });
  });
});

describe('what Buffer is handed', () => {
  let dataDir: string;

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    dataDir = mkdtempSync(join(tmpdir(), 'media-deps-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const reel = (id: number, siteId: number | null): ReelView =>
    ({ id, site_id: siteId }) as ReelView;

  it('is a link to this platform once it has a public address', async () => {
    const settings = new Settings(SECRET);
    settings.set('public_base_url', 'https://reels.example.com');
    settings.set('reel_media_link_days', '5');

    const deps = bufferReelDeps(settings, SECRET, async () => VIDEO, dataDir);

    expect(await deps.hostVideo(reel(12, 1), VIDEO)).toMatch(
      /^https:\/\/reels\.example\.com\/media\/reel\/12\//,
    );
  });

  it('writes the video where the route will look for it', async () => {
    // A reel whose video came from a url has nothing on disk here yet, and
    // the link would otherwise point at a file that does not exist.
    const settings = new Settings(SECRET);
    settings.set('public_base_url', 'https://reels.example.com');

    const deps = bufferReelDeps(settings, SECRET, async () => VIDEO, dataDir);
    await deps.hostVideo(reel(34, 1), VIDEO);

    expect(readFileSync(join(dataDir, '34.mp4')).equals(VIDEO)).toBe(true);
  });

  it('says what is missing rather than posting a reel with a dead url', async () => {
    const deps = bufferReelDeps(new Settings(SECRET), SECRET, async () => VIDEO, dataDir);

    await expect(deps.hostVideo(reel(56, null), VIDEO)).rejects.toThrow(/public address/i);
  });
});
