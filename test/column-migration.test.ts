import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  getLinkShare,
  insertKeyword,
  listFbRoutes,
  resolveFbPage,
  setLink,
  upsertFbPage,
  upsertFbRoute,
} from '../src/db/repos.js';

/**
 * schema.sql is CREATE TABLE IF NOT EXISTS throughout, so a column added to one
 * of those definitions never reaches a database that already exists. The
 * symptom is not a migration error — it is a query failing at run time on a
 * column the code is certain is there.
 *
 * These tests build a database the way an earlier deploy left it, then open it
 * with the current code.
 */

let directory: string | null = null;

function databaseFromOldSchema(): string {
  directory = mkdtempSync(join(tmpdir(), 'migration-'));
  const path = join(directory, 'platform.db');

  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seed_keyword TEXT NOT NULL,
      spy_title TEXT NOT NULL DEFAULT '',
      spy_description TEXT NOT NULL DEFAULT '',
      spy_image_url TEXT NOT NULL DEFAULT '',
      spy_article_url TEXT NOT NULL DEFAULT '',
      spy_pin_image TEXT NOT NULL DEFAULT '',
      annotation TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'go',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      domain TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'paused',
      pin_username TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      api_token_encrypted TEXT NOT NULL DEFAULT '',
      buffer_token_encrypted TEXT NOT NULL DEFAULT '',
      daily_target INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 480,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- The table as it shipped before share_images existed.
    CREATE TABLE keyword_sites (
      keyword_id INTEGER NOT NULL REFERENCES keywords (id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'no',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (keyword_id, site_id)
    );
    INSERT INTO sites (name, domain, status, daily_target)
      VALUES ('bitespoon', 'bitespoon.com', 'active', 3);
    INSERT INTO keywords (seed_keyword) VALUES ('existing keyword');
    INSERT INTO keyword_sites (keyword_id, site_id, status) VALUES (1, 1, 'go');
  `);
  db.close();

  return path;
}

describe('opening a database from an earlier deploy', () => {
  afterEach(() => {
    closeDatabase();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it('adds a column the shipped schema cannot', () => {
    const path = databaseFromOldSchema();

    const db = openDatabase(path);

    const columns = db.prepare('PRAGMA table_info(keyword_sites)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('share_images');
  });

  it('keeps the rows that were already there', () => {
    const path = databaseFromOldSchema();

    const db = openDatabase(path);

    const rows = db.prepare('SELECT * FROM keyword_sites').all() as { status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('go');
  });

  it('gives existing links the new default rather than null', () => {
    const path = databaseFromOldSchema();

    openDatabase(path);

    // Sharing is on by default, and a row written before the column existed
    // has to land on that default or the pipeline reads null and shares
    // nothing.
    expect(getLinkShare(1, 1)).toBe(true);
  });

  it('is safe to open twice', () => {
    const path = databaseFromOldSchema();

    openDatabase(path);
    closeDatabase();
    const db = openDatabase(path);

    const columns = db.prepare('PRAGMA table_info(keyword_sites)').all() as { name: string }[];
    expect(columns.filter((c) => c.name === 'share_images')).toHaveLength(1);
  });

  it('still works for writes made after the upgrade', () => {
    const path = databaseFromOldSchema();
    openDatabase(path);

    const keywordId = insertKeyword({ seed_keyword: 'new one' });
    setLink(keywordId, 1, 'go');

    expect(getLinkShare(keywordId, 1)).toBe(true);
  });

  it('creates the reels tables on a database that predates them', () => {
    const path = databaseFromOldSchema();
    const db = openDatabase(path);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);

    expect(tables).toContain('fb_pages');
    expect(tables).toContain('fb_page_routes');
    expect(tables).toContain('reels');
  });

  it('routes a niche on a migrated database, not only a fresh one', () => {
    // The tables existing is not the same as them working: the unique index
    // over COALESCE(site_id, 0) is the part that a plain CREATE TABLE would
    // leave out, and without it two fallback routes both insert.
    const path = databaseFromOldSchema();
    openDatabase(path);

    const page = upsertFbPage({
      pageId: '111',
      name: 'Slow Cooker',
      autoPublish: false,
      enabled: true,
    });

    upsertFbRoute({ siteId: null, seedKeyword: 'slow cooker', fbPageId: page });
    upsertFbRoute({ siteId: null, seedKeyword: 'slow cooker', fbPageId: page });

    expect(listFbRoutes()).toHaveLength(1);
    expect(resolveFbPage(1, 'slow cooker')?.page.page_id).toBe('111');
  });

  it('applies the reels migration exactly once', () => {
    const path = databaseFromOldSchema();

    openDatabase(path);
    closeDatabase();
    const db = openDatabase(path);

    const applied = (
      db
        .prepare('SELECT id FROM schema_migrations WHERE id = ?')
        .all('009-facebook-reels') as { id: string }[]
    ).length;

    expect(applied).toBe(1);
  });
});
