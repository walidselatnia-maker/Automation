import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import {
  clearSharedImages,
  getLinkShare,
  getSharedImages,
  insertKeyword,
  loadLinkGrid,
  saveSharedImages,
  setKeywordShareImages,
  setLink,
  setLinkShareImages,
  upsertSite,
  type SharedImageUrls,
} from '../src/db/repos.js';
import { generateArticleImages } from '../src/pipeline/steps/images.js';
import type { PipelineContext } from '../src/pipeline/context.js';
import type { ImagePromptSet } from '../src/pipeline/steps/content.js';

const KEY = randomBytes(32);

const seedSite = (domain: string): number =>
  upsertSite(
    {
      name: domain.split('.')[0]!,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 3,
      interval_minutes: 60,
    },
    KEY,
  );

const URLS = {
  feature: 'https://bitespoon.com/uploads/recipes/a.webp',
  topShot: 'https://bitespoon.com/uploads/recipes/b.webp',
  textureMacro: 'https://bitespoon.com/uploads/recipes/c.webp',
  beforeAfter: 'https://bitespoon.com/uploads/recipes/d.webp',
};

describe('shared article image storage', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('returns nothing before any images are recorded', () => {
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    expect(getSharedImages(keywordId)).toBeUndefined();
  });

  it('round-trips the four urls', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    saveSharedImages(keywordId, siteId, URLS);
    expect(getSharedImages(keywordId)).toEqual(URLS);
  });

  it('overwrites rather than duplicating on a second save', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    saveSharedImages(keywordId, siteId, URLS);
    saveSharedImages(keywordId, siteId, { ...URLS, feature: 'https://x.com/new.webp' });

    expect(getSharedImages(keywordId)?.feature).toBe('https://x.com/new.webp');
  });

  it('clears a stale row', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    saveSharedImages(keywordId, siteId, URLS);
    clearSharedImages(keywordId);

    expect(getSharedImages(keywordId)).toBeUndefined();
  });

  it('drops the row when the keyword is deleted', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    saveSharedImages(keywordId, siteId, URLS);

    run('DELETE FROM keywords WHERE id = ?', keywordId);

    expect(getSharedImages(keywordId)).toBeUndefined();
  });

  it('survives the source site being deleted, since the urls are public', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    saveSharedImages(keywordId, siteId, URLS);

    run('DELETE FROM sites WHERE id = ?', siteId);

    expect(getSharedImages(keywordId)).toEqual(URLS);
  });
});

describe('the per-link sharing flag', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('defaults a new link to sharing on', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    setLink(keywordId, siteId, 'go');
    expect(getLinkShare(keywordId, siteId)).toBe(true);
  });

  it('turns sharing off for one link without touching its status', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    setLink(keywordId, siteId, 'go');

    setLinkShareImages(keywordId, siteId, false);

    const row = loadLinkGrid().find((l) => l.siteId === siteId)!;
    expect(row.shareImages).toBe(false);
    expect(row.status).toBe('go');
  });

  it('does not reset sharing when the status changes', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    setLink(keywordId, siteId, 'go');
    setLinkShareImages(keywordId, siteId, false);

    setLink(keywordId, siteId, 'done');

    expect(getLinkShare(keywordId, siteId)).toBe(false);
  });

  it('sets sharing across every site for one keyword', () => {
    const a = seedSite('a.com');
    const b = seedSite('b.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    setLink(keywordId, a, 'go');
    setLink(keywordId, b, 'go');

    setKeywordShareImages(keywordId, false);
    expect(loadLinkGrid().every((l) => l.shareImages === false)).toBe(true);

    setKeywordShareImages(keywordId, true);
    expect(loadLinkGrid().every((l) => l.shareImages === true)).toBe(true);
  });

  it('leaves other keywords alone when setting one keyword', () => {
    const siteId = seedSite('a.com');
    const mine = insertKeyword({ seed_keyword: 'mine' });
    const theirs = insertKeyword({ seed_keyword: 'theirs' });
    setLink(mine, siteId, 'go');
    setLink(theirs, siteId, 'go');

    setKeywordShareImages(mine, false);

    expect(getLinkShare(mine, siteId)).toBe(false);
    expect(getLinkShare(theirs, siteId)).toBe(true);
  });

  it('reports false for a pair that has no link at all', () => {
    const siteId = seedSite('a.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    expect(getLinkShare(keywordId, siteId)).toBe(false);
  });
});

/* =========================================================================
 * The step itself.
 *
 * Driven with a hand-built context rather than a real PipelineContext: the
 * step touches six properties, and a fake makes the call counts observable,
 * which is the entire point of the feature.
 * ====================================================================== */

interface Recorder {
  generated: string[];
  downloaded: string[];
  saved: { keywordId: number; siteId: number; urls: SharedImageUrls }[];
  cleared: number[];
}

function fakeContext(
  options: {
    shareImages?: boolean;
    cached?: SharedImageUrls;
    downloadFails?: boolean;
  } = {},
): { ctx: PipelineContext; rec: Recorder } {
  const rec: Recorder = { generated: [], downloaded: [], saved: [], cleared: [] };
  let counter = 0;

  const ctx = {
    keyword: { id: 1, seed_keyword: 'chicken' },
    site: { id: 7, domain: 'bitespoon.com' },
    shareImages: options.shareImages ?? false,
    sharedImages: {
      get: () => options.cached,
      save: (keywordId: number, siteId: number, urls: SharedImageUrls) =>
        rec.saved.push({ keywordId, siteId, urls }),
      clear: (keywordId: number) => rec.cleared.push(keywordId),
    },
    images: {
      generate: async (prompt: string) => {
        rec.generated.push(prompt);
        return { data: Buffer.from('img'), contentType: 'image/webp', jobId: 'job' };
      },
      download: async (url: string) => {
        if (options.downloadFails) throw new Error('HTTP 404');
        rec.downloaded.push(url);
        return { data: Buffer.from('img'), contentType: 'image/webp' };
      },
    },
    siteApi: {
      uploadImage: async () => ({ url: `/uploads/recipes/${++counter}.webp` }),
      absoluteUrl: (p: string) => `https://bitespoon.com${p}`,
    },
  };

  return { ctx: ctx as unknown as PipelineContext, rec };
}

const PROMPTS = {
  feature: 'p-feature',
  topShot: 'p-top',
  textureMacro: 'p-texture',
  beforeAfter: 'p-before',
} as ImagePromptSet;

const CACHED: SharedImageUrls = {
  feature: 'https://a.com/1.webp',
  topShot: 'https://a.com/2.webp',
  textureMacro: 'https://a.com/3.webp',
  beforeAfter: 'https://a.com/4.webp',
};

describe('generateArticleImages sharing behaviour', () => {
  it('generates all four when sharing is off', async () => {
    const { ctx, rec } = fakeContext({ shareImages: false });

    await generateArticleImages.run(ctx, PROMPTS);

    expect(rec.generated).toHaveLength(4);
    expect(rec.downloaded).toHaveLength(0);
  });

  it('records nothing when sharing is off, so it does not seed other sites', async () => {
    const { ctx, rec } = fakeContext({ shareImages: false });

    await generateArticleImages.run(ctx, PROMPTS);

    expect(rec.saved).toHaveLength(0);
  });

  it('ignores a warm cache when sharing is off for this link', async () => {
    const { ctx, rec } = fakeContext({ shareImages: false, cached: CACHED });

    await generateArticleImages.run(ctx, PROMPTS);

    expect(rec.generated).toHaveLength(4);
    expect(rec.downloaded).toHaveLength(0);
  });

  it('records the four absolute urls when sharing is on and the cache is empty', async () => {
    const { ctx, rec } = fakeContext({ shareImages: true });

    await generateArticleImages.run(ctx, PROMPTS);

    expect(rec.generated).toHaveLength(4);
    expect(rec.saved).toHaveLength(1);
    expect(rec.saved[0]).toEqual({
      keywordId: 1,
      siteId: 7,
      urls: {
        feature: 'https://bitespoon.com/uploads/recipes/1.webp',
        topShot: 'https://bitespoon.com/uploads/recipes/2.webp',
        textureMacro: 'https://bitespoon.com/uploads/recipes/3.webp',
        beforeAfter: 'https://bitespoon.com/uploads/recipes/4.webp',
      },
    });
  });

  it('downloads instead of generating when the cache is warm', async () => {
    const { ctx, rec } = fakeContext({ shareImages: true, cached: CACHED });

    const result = await generateArticleImages.run(ctx, PROMPTS);

    expect(rec.generated).toHaveLength(0);
    expect(rec.downloaded).toEqual(Object.values(CACHED));
    expect(rec.saved).toHaveLength(0);
    expect(result.feature).toBe('/uploads/recipes/1.webp');
  });

  it('returns this site own paths, never the source site urls', async () => {
    const { ctx } = fakeContext({ shareImages: true, cached: CACHED });

    const result = await generateArticleImages.run(ctx, PROMPTS);

    for (const path of Object.values(result)) {
      expect(path.startsWith('/uploads/recipes/')).toBe(true);
    }
  });

  it('falls back to generating when a cached url cannot be downloaded', async () => {
    const { ctx, rec } = fakeContext({
      shareImages: true,
      cached: CACHED,
      downloadFails: true,
    });

    const result = await generateArticleImages.run(ctx, PROMPTS);

    expect(rec.cleared).toEqual([1]);
    expect(rec.generated).toHaveLength(4);
    expect(result.feature).toBe('/uploads/recipes/1.webp');
  });

  it('re-records after a fallback, so the next site gets a working cache', async () => {
    const { ctx, rec } = fakeContext({
      shareImages: true,
      cached: CACHED,
      downloadFails: true,
    });

    await generateArticleImages.run(ctx, PROMPTS);

    expect(rec.saved).toHaveLength(1);
    expect(rec.saved[0]!.urls.feature).toBe('https://bitespoon.com/uploads/recipes/1.webp');
  });
});

/* =========================================================================
 * The migration.
 *
 * schema.sql only runs CREATE TABLE IF NOT EXISTS, so a database that predates
 * share_images would never gain the column from it. This is the only path that
 * adds it, and it runs against real user data — worth a test.
 * ====================================================================== */

describe('share_images migration', () => {
  const dbPath = join(tmpdir(), `share-images-${randomUUID()}.db`);

  /**
   * The real schema as it stood before the column existed: schema.sql with the
   * share_images line removed. Hand-writing a smaller fixture does not work —
   * schema.sql builds indexes over columns a stripped-down table would lack,
   * and the point is to migrate the shape real databases actually have.
   */
  const schemaWithoutShareImages = (): string => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(resolve(here, '../src/db/schema.sql'), 'utf8');
    return sql
      .split('\n')
      .filter((line) => !line.includes('share_images'))
      .join('\n');
  };

  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${suffix}`);
      } catch {
        /* not every sidecar exists */
      }
    }
  });

  it('adds the column to an existing table and defaults its rows to on', () => {
    const old = new DatabaseSync(dbPath);
    old.exec('PRAGMA journal_mode = WAL;');
    old.exec(schemaWithoutShareImages());
    old.exec("INSERT INTO keywords (seed_keyword) VALUES ('legacy')");
    old.exec("INSERT INTO sites (name, domain) VALUES ('bitespoon', 'bitespoon.com')");
    old.exec("INSERT INTO keyword_sites (keyword_id, site_id, status) VALUES (1, 1, 'go')");
    expect(
      (old.prepare('PRAGMA table_info(keyword_sites)').all() as { name: string }[]).some(
        (c) => c.name === 'share_images',
      ),
    ).toBe(false);
    old.close();

    openDatabase(dbPath);

    const row = loadLinkGrid()[0]!;
    expect(row.shareImages).toBe(true);
    expect(row.status).toBe('go');
  });

  it('is safe to run twice', () => {
    const old = new DatabaseSync(dbPath);
    old.exec(schemaWithoutShareImages());
    old.close();

    openDatabase(dbPath);
    closeDatabase();

    expect(() => openDatabase(dbPath)).not.toThrow();
  });
});
