import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { layout } from './views/layout.js';
import { passwordAccepted, registerAuth, type AuthOptions } from './auth.js';
import { rejectionReason, storePassword, storedPasswordHash } from './password.js';
import { registerBrowserProxy } from './browser-proxy.js';
import {
  dashboardPage,
  dataPage,
  eventsPage,
  accountPage,
  keysPage,
  keywordsPage,
  promptEditPage,
  promptsPage,
  runDetailPage,
  runsPage,
  settingsPage,
  siteEditPage,
  sitesPage,
} from './views/pages.js';
import type { KeywordFilterView } from './views/pages.js';
import { importKeywordsCsv } from './import.js';
import {
  bulkDeleteKeywords,
  bulkSetKeywordStatus,
  bulkSetLinks,
  bulkSetShareImages,
  countKeywords,
  countKeywordsMatching,
  countRuns,
  deleteKeyword,
  deleteSite,
  getKeyword,
  getSite,
  getSiteByDomain,
  listDecisions,
  listEvents,
  listRecentCycles,
  listRuns,
  listSites,
  listSteps,
  searchKeywords,
  deletePromptOverride,
  getPromptOverride,
  loadLinkGrid,
  loadSiteViews,
  setPromptOverride,
  getRun,
  setKeywordShareImages,
  setKeywordStatus,
  setLink,
  setLinkShareImages,
  upsertSite,
} from '../db/repos.js';
import { get } from '../db/index.js';
import {
  clearHistory,
  forgetAllSharedImages,
  compactDatabase,
  dataCounts,
  exportDataset,
  type Dataset,
} from '../db/maintenance.js';
import {
  deleteEndpoint,
  listEndpoints,
  resetEndpointHealth,
  upsertEndpoint,
} from '../llm/pool.js';
import { evaluateSite, localDateKey } from '../core/selector.js';
import { readSupply, supplyWarning } from '../core/supply.js';
import { listPromptFiles } from '../pipeline/prompt-files.js';
import { invalidatePromptCache, PROMPT_MODELS, readShippedPrompt } from '../pipeline/prompts.js';
import { unknownVariables, variablesFor } from '../pipeline/prompt-contexts.js';
import { SETTING_SPECS, type Settings } from '../settings.js';
import { lockStatus, resumeRun, tick } from '../scheduler/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { normaliseDomain } from '../lib/domain.js';

const log = createLogger('web');

type Flash = { kind: 'ok' | 'error' | 'warn'; message: string } | null;

/** Flash messages are passed through the query string; there are no sessions. */
function readFlash(query: unknown): Flash {
  const q = query as { ok?: string; error?: string; warn?: string };
  if (q.ok) return { kind: 'ok', message: q.ok };
  if (q.error) return { kind: 'error', message: q.error };
  if (q.warn) return { kind: 'warn', message: q.warn };
  return null;
}

const redirect = (reply: FastifyReply, path: string, flash?: Flash): FastifyReply => {
  const url = flash ? `${path}?${flash.kind}=${encodeURIComponent(flash.message)}` : path;
  return reply.redirect(url, 303);
};

/**
 * A form body that is always an object.
 *
 * Fastify leaves `request.body` undefined when nothing parsed it — a POST with
 * no content-type, or a client that sent none. Reading a field off that throws,
 * and the user gets a 500 stack page for what is really "that submission was
 * malformed". Every handler here reads fields, so they all go through this.
 */
const formBody = (request: FastifyRequest): Record<string, unknown> =>
  (request.body as Record<string, unknown> | undefined) ?? {};

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function buildServer(
  settings: Settings,
  encryptionKey: Buffer,
  auth: AuthOptions,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });

  void app.register(formbody);
  void app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  void app.register(fastifyStatic, {
    root: resolve(dirname(fileURLToPath(import.meta.url)), 'public'),
    prefix: '/static/',
  });

  // Must come after formbody so the login form body is parsed.
  registerAuth(app, auth);

  // The live Chrome session, behind the same login as everything else.
  registerBrowserProxy(app, {
    targetUrl: process.env.IMAGEGEN_VNC_URL ?? 'http://imagegen:6080',
    secret: auth.secret,
  });

  const page = (
    reply: FastifyReply,
    title: string,
    active: string,
    body: ReturnType<typeof dashboardPage>,
    flash: Flash = null,
  ): FastifyReply =>
    reply.type('text/html; charset=utf-8').send(
      layout({
        title,
        active,
        body,
        flash,
        automationOn: settings.getBool('automation_enabled'),
      }),
    );

  /* -- Dashboard --------------------------------------------------------- */

  app.get('/', async (request, reply) => {
    const timezone = settings.get('timezone');
    const now = new Date();
    const dayKey = localDateKey(now, timezone);
    const views = loadSiteViews(dayKey, timezone);

    const eligibility = views.map((site) => {
      const verdict = evaluateSite(site, { now, timezone });
      return { domain: site.domain, eligible: verdict.eligible, reason: verdict.reason };
    });

    const published =
      get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs WHERE status = 'published' AND date(published_at) = date('now')`,
      )?.n ?? 0;
    const failed =
      get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs WHERE status = 'failed' AND date(started_at) = date('now')`,
      )?.n ?? 0;
    // Not "keywords with status go": one of those linked to nothing is not
    // work. See src/core/supply.ts.
    const supply = readSupply();

    const lock = lockStatus();

    // The Decisions page used to live at /decisions. It is one table, and the
    // question it answers ("why did nothing publish?") is asked while looking
    // at these counters, so it is a section here instead.
    const cycles = listRecentCycles(20);
    const requested = (request.query as { cycle?: string }).cycle;
    const selectedCycle = requested ?? cycles[0]?.cycle_id ?? null;

    return page(
      reply,
      'Dashboard',
      '/',
      dashboardPage({
        sites: views,
        eligibility,
        publishedToday: published,
        failedToday: failed,
        supply,
        recentRuns: listRuns(10),
        automationOn: settings.getBool('automation_enabled'),
        problems: problemsFor(settings),
        busy: Boolean(lock?.locked_at),
        lockedAt: lock?.locked_at ?? null,
        cycles,
        selectedCycle,
        decisions: selectedCycle ? listDecisions(selectedCycle) : [],
      }),
      readFlash(request.query),
    );
  });

  app.post('/run-now', async (_request, reply) => {
    try {
      const result = await tick(settings, encryptionKey);
      const messages: Record<string, string> = {
        published: 'Published successfully.',
        failed: `Run failed: ${result.detail ?? 'see the run detail page'}`,
        'spy-rejected': 'Spy source rejected; the keyword was marked unusable.',
        'no-task': `Nothing to publish: ${result.detail ?? ''}`,
        busy: 'A run is already in progress.',
        disabled: 'Automation is disabled. Enable it in Settings first.',
        misconfigured: `Configuration incomplete: ${result.detail ?? ''}`,
      };
      const kind = result.outcome === 'published' ? 'ok' : result.outcome === 'failed' ? 'error' : 'warn';
      return redirect(reply, '/', { kind, message: messages[result.outcome] ?? result.outcome });
    } catch (err) {
      return redirect(reply, '/', { kind: 'error', message: errorMessage(err) });
    }
  });

  /* -- Runs -------------------------------------------------------------- */

  app.get('/runs', async (request, reply) => {
    const q = request.query as { page?: string };
    const pageNum = Math.max(1, asNumber(q.page, 1));
    return page(
      reply,
      'Runs',
      '/runs',
      runsPage(listRuns(50, (pageNum - 1) * 50), pageNum, countRuns()),
      readFlash(request.query),
    );
  });

  app.get('/runs/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const run = getRun(id);
    if (!run) return redirect(reply, '/runs', { kind: 'error', message: `Run ${id} not found` });

    return page(
      reply,
      `Run ${id}`,
      '/runs',
      runDetailPage(
        run,
        listSteps(id),
        run.site_id ? getSite(run.site_id) : undefined,
        run.keyword_id ? getKeyword(run.keyword_id) : undefined,
      ),
      readFlash(request.query),
    );
  });

  app.post('/runs/:id/resume', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      const result = await resumeRun(id, settings, encryptionKey);
      return redirect(reply, `/runs/${id}`, {
        kind: result.outcome === 'published' ? 'ok' : 'error',
        message:
          result.outcome === 'published'
            ? 'Resumed and published.'
            : `Resume ended as "${result.outcome}": ${result.detail ?? ''}`,
      });
    } catch (err) {
      return redirect(reply, `/runs/${id}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  /* -- Sites ------------------------------------------------------------- */

  app.get('/sites', async (request, reply) => {
    const timezone = settings.get('timezone');
    const views = loadSiteViews(localDateKey(new Date(), timezone), timezone);
    return page(reply, 'Sites', '/sites', sitesPage(listSites(), views), readFlash(request.query));
  });

  app.get('/sites/:id', async (request, reply) => {
    const site = getSite(asNumber((request.params as { id: string }).id, 0));
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });
    return page(reply, site.domain, '/sites', siteEditPage(site), readFlash(request.query));
  });

  /** Convert the form's amount + unit pair into stored minutes. */
  const readIntervalMinutes = (body: Record<string, unknown>): number => {
    const amount = Math.max(0, asNumber(body.interval_amount, 8));
    const unit = asString(body.interval_unit, 'hours');
    const factor = unit === 'minutes' ? 1 : unit === 'days' ? 1440 : 60;
    return Math.round(amount * factor);
  };

  const saveSite = (body: Record<string, unknown>, id?: number): number =>
    upsertSite(
      {
        name: asString(body.name).trim(),
        domain: normaliseDomain(asString(body.domain)),
        status: asString(body.status) === 'active' ? 'active' : 'paused',
        pin_username: asString(body.pin_username).trim(),
        project_id: asString(body.project_id).trim(),
        daily_target: Math.max(0, asNumber(body.daily_target, 0)),
        interval_minutes: readIntervalMinutes(body),
        // Blank means "keep the stored credential".
        apiToken: asString(body.api_token),
        bufferToken: asString(body.buffer_token),
      },
      encryptionKey,
      id,
    );

  app.post('/sites', async (request, reply) => {
    try {
      saveSite(formBody(request));
      return redirect(reply, '/sites', { kind: 'ok', message: 'Site added.' });
    } catch (err) {
      return redirect(reply, '/sites', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/sites/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    const body = formBody(request);
    const newDomain = normaliseDomain(asString(body.domain));

    // Renaming onto a domain another site already owns would violate the
    // UNIQUE constraint; say so plainly instead of surfacing a SQL error.
    if (newDomain !== site.domain) {
      const clash = getSiteByDomain(newDomain);
      if (clash && clash.id !== id) {
        return redirect(reply, `/sites/${id}`, {
          kind: 'error',
          message: `Another site already uses ${newDomain}.`,
        });
      }
    }

    try {
      saveSite(body, id);
      const renamed = newDomain !== site.domain;
      return redirect(reply, '/sites', {
        kind: 'ok',
        message: renamed ? `Renamed ${site.domain} to ${newDomain}.` : `${newDomain} updated.`,
      });
    } catch (err) {
      return redirect(reply, `/sites/${id}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/sites/:id/delete', async (request, reply) => {
    deleteSite(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/sites', { kind: 'ok', message: 'Site deleted.' });
  });

  /* -- Keywords ---------------------------------------------------------- */

  /** The filter the keywords page was asked for, normalised. */
  const readKeywordFilter = (query: unknown): KeywordFilterView => {
    const q = query as { q?: string; status?: string; site?: string; link?: string };
    const status = asString(q.status);
    const link = asString(q.link);
    return {
      q: asString(q.q).trim(),
      status: status === 'go' || status === 'done' || status === 'no' ? status : '',
      siteId: Math.max(0, asNumber(q.site, 0)),
      linkStatus:
        link === 'go' || link === 'done' || link === 'no' || link === 'none' ? link : '',
    };
  };

  app.get('/keywords', async (request, reply) => {
    const q = request.query as { page?: string };
    const pageNum = Math.max(1, asNumber(q.page, 1));
    const filter = readKeywordFilter(request.query);
    const links = new Map(
      loadLinkGrid().map(
        (l) =>
          [`${l.keywordId}:${l.siteId}`, { status: l.status, shareImages: l.shareImages }] as const,
      ),
    );

    return page(
      reply,
      'Keywords',
      '/keywords',
      keywordsPage(
        searchKeywords(filter, 100, (pageNum - 1) * 100),
        listSites(),
        links,
        pageNum,
        countKeywords(),
        countKeywordsMatching(filter),
        filter,
      ),
      readFlash(request.query),
    );
  });

  /**
   * Edit every ticked keyword in one submission.
   *
   * Each control on the bulk bar has an explicit "leave as is", so a stray
   * Apply with nothing chosen changes nothing rather than silently rewriting
   * the grid. The form carries the filtered URL it came from, so you land back
   * on the same rows.
   */
  app.post('/keywords/bulk', async (request, reply) => {
    const body = formBody(request);

    // Fastify's form parser gives a single string for one checkbox and an
    // array for several; a submission with none ticked gives nothing.
    const raw = body.ids;
    const ids = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .map((value) => asNumber(value, 0))
      .filter((id) => id > 0);

    // Only ever back to a path on this app.
    const backRaw = asString(body.back, '/keywords');
    const back = backRaw.startsWith('/keywords') ? backRaw : '/keywords';

    if (ids.length === 0) {
      return redirect(reply, back, {
        kind: 'warn',
        message: 'Nothing was ticked, so nothing changed.',
      });
    }

    if (asString(body.action) === 'delete') {
      const removed = bulkDeleteKeywords(ids);
      return redirect(reply, back, {
        kind: 'ok',
        message: `Deleted ${removed} keyword(s).`,
      });
    }

    const siteId = Math.max(0, asNumber(body.site_id, 0));
    const siteIds = siteId ? [siteId] : [];
    const keywordStatus = asString(body.keyword_status);
    const linkStatus = asString(body.link_status);
    const share = asString(body.share);

    const done: string[] = [];

    if (keywordStatus === 'go' || keywordStatus === 'done' || keywordStatus === 'no') {
      const n = bulkSetKeywordStatus(ids, keywordStatus);
      done.push(`set ${n} keyword(s) to ${keywordStatus}`);
    }

    if (linkStatus === 'go' || linkStatus === 'done' || linkStatus === 'no') {
      const n = bulkSetLinks(ids, siteIds, linkStatus);
      const where = siteId ? 'on that site' : 'across every site';
      done.push(`set ${n} cell(s) ${where} to ${linkStatus}`);
    }

    if (share === '1' || share === '0') {
      const n = bulkSetShareImages(ids, siteIds, share === '1');
      done.push(`turned image sharing ${share === '1' ? 'on' : 'off'} for ${n} cell(s)`);
    }

    if (done.length === 0) {
      return redirect(reply, back, {
        kind: 'warn',
        message: `${ids.length} keyword(s) ticked, but every control said "leave as is".`,
      });
    }

    return redirect(reply, back, { kind: 'ok', message: `${done.join(', ')}.` });
  });

  app.post('/keywords/import', async (request, reply) => {
    try {
      const file = await request.file();
      if (!file) {
        return redirect(reply, '/keywords', { kind: 'error', message: 'No file received.' });
      }

      const report = importKeywordsCsv((await file.toBuffer()).toString('utf8'));

      if (report.errors.length > 0 && report.imported === 0) {
        return redirect(reply, '/keywords', {
          kind: 'error',
          message: report.errors.slice(0, 3).join(' '),
        });
      }

      const parts: string[] = [];
      if (report.imported) parts.push(`${report.imported} keyword(s) added`);
      if (report.updated) parts.push(`${report.updated} updated`);
      parts.push(`${report.linksSet} site link(s) set`);
      if (report.skipped) parts.push(`${report.skipped} row(s) skipped`);

      let message = `${parts.join(', ')}.`;

      // A keyword linked to no site is not work — it will sit there looking
      // like supply and publish nothing. Say so plainly rather than reporting
      // a successful import and leaving the queue empty.
      if (report.matchedDomains === 0) {
        message +=
          ' No column matched a site, so nothing will publish yet.' +
          (report.unknownDomains.length
            ? ` These headings match no site you have configured: ${report.unknownDomains.join(', ')}.` +
              ' Check the domains under Sites, or download the template — its columns always match.'
            : ' Add one column per site domain.');
      } else if (report.linksSet === 0) {
        message +=
          ` ${report.matchedDomains} site column(s) matched, but every cell was empty.` +
          ' Put go, done or no in the cells to say where each keyword should run.';
      } else if (report.unknownDomains.length) {
        message += ` Columns matching no site were ignored: ${report.unknownDomains.join(', ')}.`;
      }

      const wrong = report.matchedDomains === 0 || report.linksSet === 0;

      return redirect(reply, '/keywords', {
        kind: wrong ? 'warn' : report.unknownDomains.length ? 'warn' : 'ok',
        message,
      });
    } catch (err) {
      return redirect(reply, '/keywords', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/keywords/:id/status', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const status = asString(formBody(request).status, 'no');
    if (status === 'go' || status === 'done' || status === 'no') setKeywordStatus(id, status);
    return redirect(reply, '/keywords');
  });

  app.post('/keywords/:id/link', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const body = formBody(request);
    const siteId = asNumber(body.site_id, 0);
    const status = asString(body.status, 'no');
    if (siteId && (status === 'go' || status === 'done' || status === 'no')) {
      setLink(id, siteId, status);
      // An unchecked checkbox submits nothing at all, so absence means off.
      setLinkShareImages(id, siteId, body.share_images === '1');
    }
    return redirect(reply, '/keywords');
  });

  app.post('/keywords/:id/share', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const share = asString(formBody(request).share, '1') === '1';
    setKeywordShareImages(id, share);
    return redirect(reply, '/keywords');
  });

  app.post('/keywords/:id/delete', async (request, reply) => {
    deleteKeyword(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/keywords', { kind: 'ok', message: 'Keyword deleted.' });
  });

  /* -- CSV templates ------------------------------------------------------ */

  /** Byte order mark, so Excel reads the file as UTF-8. */
  const BOM = '﻿';

  const csvCell = (value: string): string =>
    /["\r\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const csvFile = (reply: FastifyReply, filename: string, rows: string[][]): FastifyReply =>
    reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      // A BOM makes Excel open UTF-8 correctly instead of mangling accents.
      // CRLF line endings for the same reason.
      .send(BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');

  app.get('/keywords/template.csv', async (_request, reply) => {
    const domains = listSites().map((s) => s.domain);
    const headers = [
      'seed_keyword', 'spy_title', 'spy_description', 'annotation', 'status', ...domains,
    ];

    const example = (
      keyword: string,
      title: string,
      status: string,
      per: (i: number) => string,
    ): string[] => [
      keyword, title, 'Short description of the source article.',
      'Comma, separated, pinterest, annotations', status,
      ...domains.map((_, i) => per(i)),
    ];

    return csvFile(reply, 'keywords-template.csv', [
      headers,
      example('Chicken Breast Recipe', 'Oven Baked Chicken Breast', 'go', (i) => (i === 0 ? 'go' : 'no')),
      example('Slow Cooker Beef', 'Slow Cooker Beef Stew', 'go', () => 'go'),
      example('Already Published', 'A keyword that is finished', 'done', () => 'done'),
    ]);
  });

  app.get('/sites/template.csv', async (_request, reply) =>
    csvFile(reply, 'sites-template.csv', [
      ['Website Name', 'Domain', 'status', 'daily_target', 'hours_between', 'Pin username', 'Project ID'],
      ['bitespoon', 'bitespoon.com', 'active', '3', '8', 'cookwithbitespoon', ''],
      ['longlivo', 'longlivo.com', 'paused', '0', '8', 'prepplat', ''],
    ]),
  );

  /* -- History and storage ------------------------------------------------ */

  /**
   * Runs, steps, decisions and events grow one row per attempt forever.
   *
   * None of it is derived state — the counters are all computed from `runs` at
   * read time — so deleting history changes nothing about what publishes next.
   * It is still the only record of what happened, which is why every clear on
   * this page sits next to the export of the same table.
   */
  app.get('/settings/data', async (request, reply) =>
    page(
      reply,
      'History & storage',
      '/settings',
      dataPage(dataCounts(), settings.getNumber('retention_days')),
      readFlash(request.query),
    ),
  );

  const DATASETS: Dataset[] = ['runs', 'steps', 'decisions', 'events', 'keywords', 'sites'];

  app.get('/data/export/:dataset', async (request, reply) => {
    const name = asString((request.params as { dataset: string }).dataset) as Dataset;
    if (!DATASETS.includes(name)) {
      return redirect(reply, '/settings/data', {
        kind: 'error',
        message: `There is nothing called "${name}" to export.`,
      });
    }

    const data = exportDataset(name);
    return csvFile(reply, data.filename, data.rows);
  });

  app.post('/data/clear', async (request, reply) => {
    const body = formBody(request);
    const what = asString(body.what);

    if (what === 'shared-images') {
      const n = forgetAllSharedImages();
      return redirect(reply, '/settings/data', {
        kind: 'ok',
        message:
          `Forgot ${n} shared image set(s). No image was deleted — the next site ` +
          'to publish those keywords will generate fresh ones.',
      });
    }

    if (what !== 'runs' && what !== 'decisions' && what !== 'events') {
      return redirect(reply, '/settings/data', {
        kind: 'error',
        message: 'Nothing was cleared: that is not something this page manages.',
      });
    }

    // "0" from the dropdown means everything, which is null to clearHistory.
    const days = asNumber(body.days, 30);
    const cutoff = days <= 0 ? null : days;

    try {
      const removed = clearHistory(what, cutoff);
      const scope = cutoff === null ? 'all' : `older than ${cutoff} day(s)`;
      return redirect(reply, '/settings/data', {
        kind: 'ok',
        message:
          removed === 0
            ? `Nothing to clear — no ${what} ${scope}.`
            : `Cleared ${removed} ${what} row(s) ${scope}.` +
              (what === 'runs' ? ' Their steps went with them.' : ''),
      });
    } catch (err) {
      return redirect(reply, '/settings/data', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/data/compact', async (_request, reply) => {
    try {
      compactDatabase();
      return redirect(reply, '/settings/data', {
        kind: 'ok',
        message: 'Database compacted. The file on disk is now its true size.',
      });
    } catch (err) {
      return redirect(reply, '/settings/data', { kind: 'error', message: errorMessage(err) });
    }
  });

  /* -- Prompts ----------------------------------------------------------- */

  /**
   * Editing the prompts is editing the product, so it gets a real page rather
   * than a note telling someone to rebuild the image.
   */
  const promptFile = (name: string): string | null => {
    // Only files that actually ship. Without this the name is a path fragment
    // reaching anywhere on disk.
    const allowed = listPromptFiles().map((p) => p.file);
    return allowed.includes(name) ? name : null;
  };

  app.get('/settings/prompts', async (request, reply) =>
    page(reply, 'Prompts', '/settings', promptsPage(listPromptFiles()), readFlash(request.query)),
  );

  app.get('/settings/prompts/:file', async (request, reply) => {
    const file = promptFile(asString((request.params as { file: string }).file));
    if (!file) {
      return redirect(reply, '/settings/prompts', { kind: 'error', message: 'No such prompt file.' });
    }

    const override = getPromptOverride(file);
    const shipped = readShippedPrompt(file);
    const body = override ?? shipped;
    const promptName = file.replace(/\.(system|user)\.txt$/, '').replace(/\.txt$/, '');

    return page(
      reply,
      file,
      '/settings',
      promptEditPage(file, body, {
        model: PROMPT_MODELS[promptName]?.model ?? '',
        variables: variablesFor(promptName),
        unknown: unknownVariables(promptName, body),
        edited: override !== undefined,
        shipped,
      }),
      readFlash(request.query),
    );
  });

  app.post('/settings/prompts/:file', async (request, reply) => {
    const file = promptFile(asString((request.params as { file: string }).file));
    if (!file) {
      return redirect(reply, '/settings/prompts', { kind: 'error', message: 'No such prompt file.' });
    }

    const body = formBody(request);

    if (asString(body.action) === 'revert') {
      deletePromptOverride(file);
      invalidatePromptCache();
      return redirect(reply, `/settings/prompts/${file}`, {
        kind: 'ok',
        message: 'Reverted to the shipped prompt.',
      });
    }

    const text = asString(body.body);
    if (text.trim() === '') {
      return redirect(reply, `/settings/prompts/${file}`, {
        kind: 'error',
        message: 'An empty prompt would silently produce nothing. Revert instead if that is what you want.',
      });
    }

    setPromptOverride(file, text);
    invalidatePromptCache();

    const promptName = file.replace(/\.(system|user)\.txt$/, '').replace(/\.txt$/, '');
    const unknown = unknownVariables(promptName, text);

    return redirect(reply, `/settings/prompts/${file}`, {
      kind: unknown.length ? 'warn' : 'ok',
      message: unknown.length
        ? `Saved, but ${unknown.join(', ')} is not supplied by any step and will render empty.`
        : 'Saved. It applies to the next run.',
    });
  });

  /* -- Decisions --------------------------------------------------------- */

  // It is a section of the dashboard now. Kept as a redirect because it was a
  // page for long enough to be bookmarked.
  app.get('/decisions', async (request, reply) => {
    const cycle = asString((request.query as { cycle?: string }).cycle);
    return redirect(reply, cycle ? `/?cycle=${encodeURIComponent(cycle)}#decisions` : '/');
  });

  /* -- Events ------------------------------------------------------------ */

  app.get('/events', async (request, reply) =>
    page(reply, 'Events', '/events', eventsPage(listEvents(200)), readFlash(request.query)),
  );

  /* -- Settings ---------------------------------------------------------- */

  /**
   * The image service's own health, refreshed in the background.
   *
   * Checked off the request path on purpose: the dashboard should not wait on
   * a container that might be restarting, and Chrome takes about a minute to
   * come up. Stale by up to a minute is the right trade for a page that always
   * renders.
   */
  let imageServiceProblem: string | null = null;

  /**
   * Ask the image service whether it accepts the settings as they now stand.
   *
   * Deliberately reports the key being wrong differently from the service being
   * down: one is something you just did, the other is something that happened
   * to you.
   */
  const checkImageService = async (): Promise<{ ok: boolean; detail: string }> => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) return { ok: false, detail: 'no image service URL is set' };

    try {
      const response = await fetch(`${base}/flow/status`, {
        headers: { 'X-API-Key': settings.get('image_api_key') },
        signal: AbortSignal.timeout(8_000),
      });

      if (response.status === 401) {
        return {
          ok: false,
          detail:
            'the API key was rejected. It has to match IMAGE_API_KEY in the deployment ' +
            'environment — changing it here alone is not enough.',
        };
      }
      if (!response.ok) return { ok: false, detail: `it answered HTTP ${response.status}` };
      return { ok: true, detail: 'accepted' };
    } catch (err) {
      return { ok: false, detail: `it could not be reached (${errorMessage(err)})` };
    }
  };

  const refreshImageServiceHealth = async (): Promise<void> => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) return;

    try {
      const response = await fetch(`${base}/flow/status`, {
        headers: { 'X-API-Key': settings.get('image_api_key') },
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        imageServiceProblem = `Image service answered HTTP ${response.status} — check it is running.`;
        return;
      }

      const status = (await response.json()) as { connected?: boolean };
      imageServiceProblem = status.connected
        ? null
        : 'The image service browser is not signed in to Google. Open Browser to sign in.';
    } catch {
      imageServiceProblem =
        'Image service unreachable — no images can be generated until it is back.';
    }
  };

  void refreshImageServiceHealth();
  const healthTimer = setInterval(() => void refreshImageServiceHealth(), 60_000);
  healthTimer.unref();

  /**
   * Configuration problems, including ones that live outside the settings
   * table: no API keys, or sites missing their own credentials.
   */
  const problemsFor = (s: Settings): string[] => {
    const problems = s.validate();

    if (listEndpoints(encryptionKey).filter((e) => e.enabled).length === 0) {
      problems.push('No LLM API keys added — nothing can be generated.');
    }

    if (imageServiceProblem) problems.push(imageServiceProblem);

    const supplyProblem = supplyWarning(readSupply());
    if (supplyProblem) problems.push(supplyProblem);

    const sitesMissingToken = listSites()
      .filter((site) => site.status === 'active' && !site.api_token_encrypted.trim())
      .map((site) => site.domain);
    if (sitesMissingToken.length > 0) {
      problems.push(
        `Active site(s) without an API token: ${sitesMissingToken.join(', ')}.`,
      );
    }

    return problems;
  };

  app.get('/settings', async (request, reply) => {
    const values = new Map(SETTING_SPECS.map((s) => [s.key, settings.get(s.key)] as const));
    return page(
      reply,
      'Settings',
      '/settings',
      settingsPage(SETTING_SPECS, values, problemsFor(settings)),
      readFlash(request.query),
    );
  });

  app.get('/settings/keys', async (request, reply) =>
    page(
      reply,
      'LLM API keys',
      '/settings',
      keysPage(
        listEndpoints(encryptionKey, settings.get('llm_base_url')),
        settings.get('llm_base_url'),
      ),
      readFlash(request.query),
    ),
  );

  app.get('/settings/account', async (request, reply) =>
    page(
      reply,
      'Password',
      '/settings',
      accountPage(auth.generated && !storedPasswordHash(encryptionKey)),
      readFlash(request.query),
    ),
  );

  app.post('/settings/account', async (request, reply) => {
    const body = formBody(request);
    const current = asString(body.current);
    const next = asString(body.next);
    const confirm = asString(body.confirm);

    const fail = (message: string): FastifyReply =>
      redirect(reply, '/settings/account', { kind: 'error', message });

    // Checked even though the caller already holds a session: a session that
    // was left open on a shared machine should not be able to lock the owner
    // out of their own platform.
    if (!passwordAccepted(current, auth)) {
      await new Promise((r) => setTimeout(r, 400));
      return fail('That is not the current password.');
    }

    const reason = rejectionReason(next, confirm);
    if (reason) return fail(reason);

    storePassword(next, encryptionKey);
    log.info('admin password changed');

    return redirect(reply, '/settings/account', {
      kind: 'ok',
      message: 'Password changed. It applies to the next sign-in; this session stays open.',
    });
  });

  /**
   * Add several keys at once.
   *
   * Pasting twenty keys one form at a time is the kind of chore that ends with
   * someone giving up at six, so the whole point is that the input is whatever
   * the provider's dashboard put on the clipboard.
   */
  app.post('/settings/endpoints/bulk', async (request, reply) => {
    const text = asString(formBody(request).keys);

    const existing = listEndpoints(encryptionKey);
    const takenNames = new Set(existing.map((e) => e.name.toLowerCase()));
    const seenKeys = new Set<string>();

    let counter = 0;
    const nextName = (): string => {
      // Continue the numbering rather than restarting it, so a second paste
      // does not collide with the first and silently replace those keys.
      let candidate: string;
      do {
        counter += 1;
        candidate = `key-${String(counter).padStart(2, '0')}`;
      } while (takenNames.has(candidate));
      takenNames.add(candidate);
      return candidate;
    };

    let added = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const [index, rawLine] of text.split('\n').entries()) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;

      // "label = key", "label, key", or a bare key.
      const separated = /^(.+?)\s*[=,]\s*(.+)$/.exec(line);
      const name = separated ? separated[1]!.trim() : '';
      const apiKey = (separated ? separated[2]! : line).trim();

      if (!apiKey) continue;
      if (seenKeys.has(apiKey)) {
        skipped += 1;
        continue;
      }
      seenKeys.add(apiKey);

      try {
        upsertEndpoint(
          { name: name || nextName(), baseUrl: '', apiKey, models: [], enabled: true },
          encryptionKey,
        );
        added += 1;
      } catch (err) {
        errors.push(`line ${index + 1}: ${errorMessage(err)}`);
      }
    }

    if (added === 0 && errors.length === 0) {
      return redirect(reply, '/settings/keys', {
        kind: 'warn',
        message: 'Nothing to add — no keys found in that text.',
      });
    }

    const parts = [`Added ${added} key(s).`];
    if (skipped) parts.push(`${skipped} duplicate(s) skipped.`);
    if (errors.length) parts.push(`Failed: ${errors.slice(0, 3).join('; ')}`);

    return redirect(reply, '/settings/keys', {
      kind: errors.length ? 'warn' : 'ok',
      message: parts.join(' '),
    });
  });

  app.post('/settings', async (request, reply) => {
    const body = formBody(request);
    let imagesChanged = false;

    for (const spec of SETTING_SPECS) {
      const submitted = body[spec.key];
      if (submitted === undefined) continue;

      const value = asString(submitted).trim();
      // A blank secret means "keep what is stored", not "erase it".
      if (spec.secret && value === '') continue;

      settings.set(spec.key, value);
      if (spec.group === 'images') imagesChanged = true;
    }

    if (!imagesChanged) {
      return redirect(reply, '/settings', { kind: 'ok', message: 'Settings saved.' });
    }

    // The image service checks the key against its own environment, so a key
    // changed here alone is accepted by the form and then rejected on every
    // generation. Silently. Test it now rather than at 3am mid-run.
    const reachable = await checkImageService();
    void refreshImageServiceHealth();

    return redirect(reply, '/settings', {
      kind: reachable.ok ? 'ok' : 'warn',
      message: reachable.ok
        ? 'Settings saved. The image service accepted the key.'
        : `Settings saved, but the image service refused them: ${reachable.detail}`,
    });
  });

  app.post('/settings/endpoints', async (request, reply) => {
    const body = formBody(request);
    const name = asString(body.name).trim();
    const apiKey = asString(body.api_key).trim();

    if (!name) {
      return redirect(reply, '/settings', { kind: 'error', message: 'A label is required.' });
    }
    if (!apiKey) {
      return redirect(reply, '/settings', { kind: 'error', message: 'An API key is required.' });
    }

    try {
      upsertEndpoint(
        {
          name,
          // Blank means "use the shared base URL from settings".
          baseUrl: asString(body.base_url).trim(),
          apiKey,
          models: asString(body.models)
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean),
          enabled: true,
        },
        encryptionKey,
      );
      return redirect(reply, '/settings', { kind: 'ok', message: `API key "${name}" saved.` });
    } catch (err) {
      return redirect(reply, '/settings', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/endpoints/:id/delete', async (request, reply) => {
    deleteEndpoint(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/settings', { kind: 'ok', message: 'API key deleted.' });
  });

  app.post('/settings/endpoints/:id/reset', async (request, reply) => {
    resetEndpointHealth(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/settings', { kind: 'ok', message: 'Key health reset.' });
  });

  /* -- Health ------------------------------------------------------------ */

  app.get('/healthz', async (_request, reply) => {
    const lock = lockStatus();
    return reply.send({
      ok: true,
      automation: settings.getBool('automation_enabled'),
      busy: Boolean(lock?.locked_at),
      problems: problemsFor(settings),
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    log.error('unhandled request error', errorMessage(error));
    void reply.status(500).type('text/html').send(
      layout({
        title: 'Error',
        active: '',
        body: { value: `<h1>Something went wrong</h1><pre>${errorMessage(error)}</pre>` } as never,
        flash: { kind: 'error', message: 'Unexpected error' },
      }),
    );
  });

  return app;
}
