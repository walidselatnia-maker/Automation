import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, get as dbGet, openDatabase, run } from '../src/db/index.js';
import {
  bulkSetKeywordStatus,
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

    it('keeps deployment wiring off the settings page', async () => {
      // These resolve from their defaults and their environment overrides
      // exactly as before. They are simply not questions worth asking: the
      // image service URL is always the container next door, and the poll
      // numbers are a timeout nobody has needed to move.
      const response = await get('/settings');

      for (const key of [
        'timezone',
        'llm_base_url',
        'image_base_url',
        'image_poll_interval_seconds',
        'image_poll_max_attempts',
      ]) {
        expect(response.body).not.toContain(`name="${key}"`);
      }
    });

    it('still resolves the hidden values', async () => {
      const { Settings } = await import('../src/settings.js');
      const settings = new Settings(KEY);

      expect(settings.get('image_base_url')).toContain('imagegen');
      expect(settings.getNumber('image_poll_max_attempts')).toBe(40);
      expect(settings.get('timezone')).not.toBe('');
    });

    it('still asks for the things that are real decisions', async () => {
      const response = await get('/settings');

      expect(response.body).toContain('name="automation_enabled"');
      expect(response.body).toContain('name="flow_project_id"');
      expect(response.body).toContain('name="tick_minutes"');
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

  /* -- the view picker --------------------------------------------------- */

  describe('choosing a view', () => {
    let siteId: number;

    beforeEach(() => {
      siteId = seedSite('bitespoon.com');
      const going = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      insertKeyword({ seed_keyword: 'beef stew', status: 'done' });
      // Set to go and linked to nothing — supply on paper, nothing in practice.
      insertKeyword({ seed_keyword: 'lemon tart', status: 'go' });
      setLink(going, siteId, 'go');
    });

    it('defaults to everything', async () => {
      const response = await get('/keywords');
      expect(response.body).toContain('chicken soup');
      expect(response.body).toContain('beef stew');
      expect(response.body).toContain('lemon tart');
    });

    it('shows only what will actually publish', async () => {
      const response = await get('/keywords?view=queued');
      expect(response.body).toContain('chicken soup');
      expect(response.body).not.toContain('beef stew');
      expect(response.body).not.toContain('lemon tart');
    });

    it('finds the keywords that are going nowhere', async () => {
      // The state that counts as supply on the dashboard and publishes
      // nothing. It gets a view of its own precisely because it is invisible.
      const response = await get('/keywords?view=stuck');
      expect(response.body).toContain('lemon tart');
      expect(response.body).not.toContain('chicken soup');
    });

    it('shows the finished ones', async () => {
      const response = await get('/keywords?view=done');
      expect(response.body).toContain('beef stew');
      expect(response.body).not.toContain('chicken soup');
    });

    it('narrows a view to one site', async () => {
      const other = seedSite('longlivo.com');
      const response = await get(`/keywords?view=queued&site=${other}`);
      expect(response.body).not.toContain('chicken soup');
      expect(response.body).toContain('longlivo.com');
    });

    it('searches the words', async () => {
      const response = await get('/keywords?q=chicken');
      expect(response.body).toContain('chicken soup');
      expect(response.body).not.toContain('beef stew');
    });

    it('explains what the chosen view means', async () => {
      const response = await get('/keywords?view=stuck');
      expect(response.body).toContain('no site is set to go for it');
    });

    it('keeps the search on the form after a reload', async () => {
      const response = await get('/keywords?q=chicken');
      expect(response.body).toContain('value="chicken"');
    });

    it('falls back to everything for a view it does not know', async () => {
      const response = await get('/keywords?view=nonsense');
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('beef stew');
    });
  });

  /* -- bulk actions ------------------------------------------------------- */

  describe('bulk actions', () => {
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

    it('publishes the ticked keywords on every site', async () => {
      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'publish-on',
        site_id: '',
        back: '/keywords',
      });

      const grid = loadLinkGrid().filter((l) => l.keywordId === one);
      expect(grid).toHaveLength(2);
      expect(grid.every((l) => l.status === 'go')).toBe(true);
    });

    it('publishes on only the site that was chosen', async () => {
      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'publish-on',
        site_id: String(siteA),
        back: '/keywords',
      });

      const grid = loadLinkGrid().filter((l) => l.keywordId === one);
      expect(grid).toHaveLength(1);
      expect(grid[0]?.siteId).toBe(siteA);
    });

    it('switches a keyword back on when publishing it', async () => {
      // Setting the cell alone would leave a keyword whose own status is `no`
      // looking correct on the page and still never being offered.
      bulkSetKeywordStatus([one], 'no');

      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'publish-on',
        site_id: String(siteA),
        back: '/keywords',
      });

      expect(getKeyword(one)?.status).toBe('go');
    });

    it('stops the ticked keywords on a site', async () => {
      setLink(one, siteA, 'go');

      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'stop-on',
        site_id: String(siteA),
        back: '/keywords',
      });

      expect(loadLinkGrid().find((l) => l.keywordId === one)?.status).toBe('no');
    });

    it('marks them finished', async () => {
      await post('/keywords/bulk', {
        ids: [String(one), String(two)],
        action: 'finish',
        back: '/keywords',
      });

      expect(getKeyword(one)?.status).toBe('done');
      expect(getKeyword(two)?.status).toBe('done');
    });

    it('turns them off', async () => {
      await post('/keywords/bulk', { ids: [String(one)], action: 'off', back: '/keywords' });
      expect(getKeyword(one)?.status).toBe('no');
    });

    it('switches image reuse off', async () => {
      setLink(one, siteA, 'go');
      setLink(one, siteB, 'go');

      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'share-off',
        site_id: '',
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

    it('says so rather than acting when nothing is ticked', async () => {
      const response = await post('/keywords/bulk', { action: 'delete', back: '/keywords' });

      expect(response.headers.location).toContain('Nothing%20was%20ticked');
      expect(getKeyword(one)).toBeDefined();
    });

    it('refuses an action it does not have', async () => {
      const response = await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'drop-database',
        back: '/keywords',
      });

      expect(response.headers.location).toContain('error=');
      expect(getKeyword(one)?.status).toBe('go');
    });

    it('refuses to be redirected off this app', async () => {
      const response = await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'off',
        back: 'https://example.com/evil',
      });

      expect(response.headers.location).toMatch(/^\/keywords/);
    });

    it('returns to the view it came from', async () => {
      const response = await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'off',
        back: '/keywords?view=queued',
      });

      expect(response.headers.location).toContain('/keywords?view=queued');
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

    it('keeps site credentials out of the ordinary export', () => {
      // The columns are present and empty on purpose, so the file round-trips
      // through the importer without wiping the tokens it does not carry.
      // What matters is that no *value* is a credential.
      const sites = exportDataset('sites');
      const header = sites.rows[0]!;
      const api = header.indexOf('api_token');
      const buffer = header.indexOf('buffer_token');

      expect(api).toBeGreaterThan(-1);
      expect(buffer).toBeGreaterThan(-1);

      for (const row of sites.rows.slice(1)) {
        expect(row[api]).toBe('');
        expect(row[buffer]).toBe('');
      }
    });

    it('rejects an unknown dataset', async () => {
      const response = await get('/data/export/settings');
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain('error=');
    });
  });
});
