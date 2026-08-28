import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, get as dbGet, openDatabase, run } from '../src/db/index.js';
import {
  getLinkShare,
  getKeyword,
  insertKeyword,
  loadLinkGrid,
  setLink,
  upsertSite,
} from '../src/db/repos.js';
import { dataCounts, exportDataset } from '../src/db/maintenance.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * The pages that changed shape: the rail lost Prompts, Decisions and Browser;
 * the keywords table gained bulk editing; and history became something you can
 * export and delete. The last of those destroys data, so it is tested the way
 * anything destructive should be — including the case where it must refuse.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

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

describe('web UI after the layout changes', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    app = buildServer(new Settings(KEY), KEY, {
      password: PASSWORD,
      secret: KEY,
      generated: false,
    });
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const header = login.headers['set-cookie'];
    cookie = Array.isArray(header) ? header[0]! : String(header);
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  const post = (url: string, fields: Record<string, string | string[]>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      for (const one of Array.isArray(value) ? value : [value]) params.append(key, one);
    }
    return app.inject({
      method: 'POST',
      url,
      payload: params.toString(),
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });
  };

  /* -- navigation ------------------------------------------------------- */

  describe('navigation', () => {
    it('puts the browser behind a button that opens its own tab', async () => {
      const response = await get('/');
      expect(response.body).toContain('class="button browser"');
      expect(response.body).toContain('target="_blank"');
    });

    it('no longer lists prompts, decisions or the browser in the rail', async () => {
      const response = await get('/');
      const rail = response.body.slice(
        response.body.indexOf('<nav>'),
        response.body.indexOf('</nav>'),
      );
      expect(rail).not.toContain('/settings/prompts');
      expect(rail).not.toContain('/decisions');
      expect(rail).not.toContain('/browser');
      expect(rail).toContain('/keywords');
    });

    it('sends the old decisions URL to the dashboard section', async () => {
      const response = await get('/decisions?cycle=abc');
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe('/?cycle=abc#decisions');
    });

    it('serves the prompts editor from under settings', async () => {
      const response = await get('/settings/prompts');
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Prompts');
    });

    it('links prompts and history from the settings page', async () => {
      const response = await get('/settings');
      expect(response.body).toContain('href="/settings/prompts"');
      expect(response.body).toContain('href="/settings/data"');
    });
  });

  /* -- dashboard -------------------------------------------------------- */

  describe('dashboard', () => {
    it('shows the decisions section with the reasons for a check', async () => {
      run(
        `INSERT INTO decisions (cycle_id, subject_type, subject_label, decision, reason)
         VALUES ('cycle-1', 'site', 'bitespoon.com', 'rejected', 'Daily publishing limit reached')`,
      );

      const response = await get('/');
      expect(response.body).toContain('Decisions');
      expect(response.body).toContain('Daily publishing limit reached');
    });

    it('bounds the recent runs table instead of letting it grow', async () => {
      const response = await get('/');
      expect(response.body).toContain('table-wrap scroll-y');
    });
  });

  /* -- keyword filtering ------------------------------------------------ */

  describe('keyword filtering', () => {
    beforeEach(() => {
      const site = seedSite('bitespoon.com');
      const a = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      insertKeyword({ seed_keyword: 'beef stew', status: 'done' });
      setLink(a, site, 'go');
    });

    it('narrows the table to matching keywords', async () => {
      const response = await get('/keywords?q=chicken');
      expect(response.body).toContain('chicken soup');
      expect(response.body).not.toContain('beef stew');
      expect(response.body).toContain('1 of 2 keyword(s) match');
    });

    it('filters on the keyword-global status', async () => {
      const response = await get('/keywords?status=done');
      expect(response.body).toContain('beef stew');
      expect(response.body).not.toContain('chicken soup');
    });

    it('finds keywords not linked to a site at all', async () => {
      const response = await get('/keywords?site=1&link=none');
      expect(response.body).toContain('beef stew');
      expect(response.body).not.toContain('chicken soup');
    });

    it('keeps the filter on the pagination links', async () => {
      const response = await get('/keywords?q=chicken');
      // Nothing paginates at this size, but the filter must survive a reload.
      expect(response.body).toContain('value="chicken"');
    });
  });

  /* -- bulk editing ------------------------------------------------------ */

  describe('bulk editing', () => {
    let siteA: number;
    let siteB: number;
    let one: number;
    let two: number;

    beforeEach(() => {
      siteA = seedSite('bitespoon.com');
      siteB = seedSite('longlivo.com');
      one = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      two = insertKeyword({ seed_keyword: 'beef stew', status: 'go' });
    });

    it('sets the keyword status on every ticked row', async () => {
      await post('/keywords/bulk', {
        ids: [String(one), String(two)],
        action: 'apply',
        keyword_status: 'done',
        back: '/keywords',
      });

      expect(getKeyword(one)?.status).toBe('done');
      expect(getKeyword(two)?.status).toBe('done');
    });

    it('sets a link status across every site when no site is chosen', async () => {
      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'apply',
        site_id: '',
        link_status: 'go',
        back: '/keywords',
      });

      const grid = loadLinkGrid().filter((l) => l.keywordId === one);
      expect(grid).toHaveLength(2);
      expect(grid.every((l) => l.status === 'go')).toBe(true);
    });

    it('touches only the chosen site when one is picked', async () => {
      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'apply',
        site_id: String(siteA),
        link_status: 'go',
        back: '/keywords',
      });

      const grid = loadLinkGrid().filter((l) => l.keywordId === one);
      expect(grid).toHaveLength(1);
      expect(grid[0]?.siteId).toBe(siteA);
    });

    it('turns image sharing off in bulk', async () => {
      setLink(one, siteA, 'go');
      setLink(one, siteB, 'go');

      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'apply',
        site_id: '',
        share: '0',
        back: '/keywords',
      });

      expect(getLinkShare(one, siteA)).toBe(false);
      expect(getLinkShare(one, siteB)).toBe(false);
    });

    it('deletes every ticked keyword', async () => {
      await post('/keywords/bulk', {
        ids: [String(one), String(two)],
        action: 'delete',
        back: '/keywords',
      });

      expect(getKeyword(one)).toBeUndefined();
      expect(getKeyword(two)).toBeUndefined();
    });

    it('changes nothing when every control says leave as is', async () => {
      const response = await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'apply',
        keyword_status: '',
        link_status: '',
        share: '',
        back: '/keywords',
      });

      expect(response.headers.location).toContain('leave%20as%20is');
      expect(getKeyword(one)?.status).toBe('go');
      expect(loadLinkGrid()).toHaveLength(0);
    });

    it('says so rather than acting when nothing is ticked', async () => {
      const response = await post('/keywords/bulk', {
        action: 'delete',
        back: '/keywords',
      });

      expect(response.headers.location).toContain('Nothing%20was%20ticked');
      expect(getKeyword(one)).toBeDefined();
    });

    it('refuses to be redirected off this app', async () => {
      const response = await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'apply',
        keyword_status: 'no',
        back: 'https://example.com/evil',
      });

      expect(response.headers.location).toMatch(/^\/keywords/);
    });

    it('returns to the filtered view it came from', async () => {
      const response = await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'apply',
        keyword_status: 'no',
        back: '/keywords?q=chicken',
      });

      expect(response.headers.location).toContain('/keywords?q=chicken');
    });
  });

  /* -- history and storage ---------------------------------------------- */

  describe('history and storage', () => {
    beforeEach(() => {
      const site = seedSite('bitespoon.com');
      const keyword = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });

      run(
        `INSERT INTO runs (keyword_id, site_id, status, started_at)
         VALUES (?, ?, 'published', datetime('now', '-60 days'))`,
        keyword,
        site,
      );
      run(
        `INSERT INTO runs (keyword_id, site_id, status, started_at)
         VALUES (?, ?, 'failed', datetime('now'))`,
        keyword,
        site,
      );
      run(
        `INSERT INTO runs (keyword_id, site_id, status, started_at)
         VALUES (?, ?, 'running', datetime('now', '-90 days'))`,
        keyword,
        site,
      );
      run(
        `INSERT INTO decisions (cycle_id, subject_type, subject_label, decision, reason)
         VALUES ('old', 'site', 'bitespoon.com', 'rejected', 'too soon')`,
      );
      run("INSERT INTO events (level, source, message) VALUES ('error', 'test', 'boom')");
    });

    it('counts what has piled up', () => {
      const counts = dataCounts();
      expect(counts.runs).toBe(3);
      expect(counts.decisions).toBe(1);
      expect(counts.events).toBe(1);
      expect(counts.oldestRunAt).not.toBeNull();
    });

    it('renders the page with those counts', async () => {
      const response = await get('/settings/data');
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('History &amp; storage');
      expect(response.body).toContain('Forget shared images');
    });

    it('clears only history older than the cutoff', async () => {
      await post('/data/clear', { what: 'runs', days: '30' });
      expect(dataCounts().runs).toBe(2);
    });

    it('never deletes a run that is still going', async () => {
      await post('/data/clear', { what: 'runs', days: '0' });

      // Everything is cleared except the one the scheduler lock points at.
      expect(dataCounts().runs).toBe(1);
      expect(
        dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'")?.n,
      ).toBe(1);
    });

    it('reports a no-op instead of claiming success', async () => {
      await post('/data/clear', { what: 'events', days: '0' });
      const again = await post('/data/clear', { what: 'events', days: '0' });
      expect(again.headers.location).toContain('Nothing%20to%20clear');
    });

    it('refuses a table it does not manage', async () => {
      const response = await post('/data/clear', { what: 'sites', days: '0' });
      expect(response.headers.location).toContain('error=');
      expect(dataCounts().runs).toBe(3);
    });

    it('forgets shared images without touching anything else', async () => {
      const response = await post('/data/clear', { what: 'shared-images' });
      expect(response.headers.location).toContain('ok=');
      expect(dataCounts().runs).toBe(3);
    });

    it('exports runs as CSV with a filename', async () => {
      const response = await get('/data/export/runs');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('runs.csv');
      expect(response.body).toContain('bitespoon.com');
    });

    it('exports keywords in the shape the importer reads back', () => {
      const data = exportDataset('keywords');
      expect(data.rows[0]).toEqual([
        'seed_keyword', 'spy_title', 'spy_description', 'annotation', 'status',
        'bitespoon.com',
      ]);
    });

    it('keeps site credentials out of every export', () => {
      const sites = exportDataset('sites');
      expect(sites.rows[0]?.join(',')).not.toContain('token');
    });

    it('rejects an unknown dataset', async () => {
      const response = await get('/data/export/settings');
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain('error=');
    });
  });
});
