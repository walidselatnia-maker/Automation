import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { layout } from './views/layout.js';
import { registerAuth, type AuthOptions } from './auth.js';
import {
  dashboardPage,
  decisionsPage,
  eventsPage,
  keywordsPage,
  runDetailPage,
  runsPage,
  settingsPage,
  siteEditPage,
  sitesPage,
} from './views/pages.js';
import { importKeywordsCsv } from './import.js';
import {
  countKeywords,
  countRuns,
  deleteKeyword,
  deleteSite,
  getKeyword,
  getSite,
  getSiteByDomain,
  listDecisions,
  listEvents,
  listKeywords,
  listRecentCycles,
  listRuns,
  listSites,
  listSteps,
  loadLinkViews,
  loadSiteViews,
  getRun,
  setKeywordStatus,
  setLink,
  upsertSite,
} from '../db/repos.js';
import { get } from '../db/index.js';
import {
  deleteEndpoint,
  listEndpoints,
  resetEndpointHealth,
  upsertEndpoint,
} from '../llm/pool.js';
import { evaluateSite, localDateKey } from '../core/selector.js';
import { SETTING_SPECS, type Settings } from '../settings.js';
import { lockStatus, resumeRun, tick } from '../scheduler/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';

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
    const ready =
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM keywords WHERE status = 'go'`)?.n ?? 0;

    const lock = lockStatus();

    return page(
      reply,
      'Dashboard',
      '/',
      dashboardPage({
        sites: views,
        eligibility,
        publishedToday: published,
        failedToday: failed,
        keywordsReady: ready,
        recentRuns: listRuns(10),
        automationOn: settings.getBool('automation_enabled'),
        problems: problemsFor(settings),
        busy: Boolean(lock?.locked_at),
        lockedAt: lock?.locked_at ?? null,
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

  const normaliseDomain = (value: string): string =>
    value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');

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
      saveSite(request.body as Record<string, unknown>);
      return redirect(reply, '/sites', { kind: 'ok', message: 'Site added.' });
    } catch (err) {
      return redirect(reply, '/sites', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/sites/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    const body = request.body as Record<string, unknown>;
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

  app.get('/keywords', async (request, reply) => {
    const q = request.query as { page?: string };
    const pageNum = Math.max(1, asNumber(q.page, 1));
    const links = new Map(
      loadLinkViews().map((l) => [`${l.keywordId}:${l.siteId}`, l.status] as const),
    );

    return page(
      reply,
      'Keywords',
      '/keywords',
      keywordsPage(
        listKeywords(100, (pageNum - 1) * 100),
        listSites(),
        links,
        pageNum,
        countKeywords(),
      ),
      readFlash(request.query),
    );
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

      let message = `Imported ${report.imported} keyword(s) and ${report.linksSet} site link(s).`;
      if (report.skipped) message += ` Skipped ${report.skipped}.`;
      if (report.unknownDomains.length) {
        message += ` Unrecognised columns ignored: ${report.unknownDomains.join(', ')}.`;
      }

      return redirect(reply, '/keywords', {
        kind: report.unknownDomains.length ? 'warn' : 'ok',
        message,
      });
    } catch (err) {
      return redirect(reply, '/keywords', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/keywords/:id/status', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const status = asString((request.body as Record<string, unknown>).status, 'no');
    if (status === 'go' || status === 'done' || status === 'no') setKeywordStatus(id, status);
    return redirect(reply, '/keywords');
  });

  app.post('/keywords/:id/link', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const body = request.body as Record<string, unknown>;
    const siteId = asNumber(body.site_id, 0);
    const status = asString(body.status, 'no');
    if (siteId && (status === 'go' || status === 'done' || status === 'no')) {
      setLink(id, siteId, status);
    }
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

  /* -- Decisions --------------------------------------------------------- */

  app.get('/decisions', async (request, reply) => {
    const q = request.query as { cycle?: string };
    const cycles = listRecentCycles(20);
    const selected = q.cycle ?? cycles[0]?.cycle_id ?? null;

    return page(
      reply,
      'Decisions',
      '/decisions',
      decisionsPage(cycles, selected, selected ? listDecisions(selected) : []),
      readFlash(request.query),
    );
  });

  /* -- Events ------------------------------------------------------------ */

  app.get('/events', async (request, reply) =>
    page(reply, 'Events', '/events', eventsPage(listEvents(200)), readFlash(request.query)),
  );

  /* -- Settings ---------------------------------------------------------- */

  /**
   * Configuration problems, including ones that live outside the settings
   * table: no API keys, or sites missing their own credentials.
   */
  const problemsFor = (s: Settings): string[] => {
    const problems = s.validate();

    if (listEndpoints(encryptionKey).filter((e) => e.enabled).length === 0) {
      problems.push('No LLM API keys added — nothing can be generated.');
    }

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
      settingsPage(
        SETTING_SPECS,
        values,
        listEndpoints(encryptionKey, settings.get('llm_base_url')),
        problemsFor(settings),
      ),
      readFlash(request.query),
    );
  });

  app.post('/settings', async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    for (const spec of SETTING_SPECS) {
      const submitted = body[spec.key];
      if (submitted === undefined) continue;

      const value = asString(submitted).trim();
      // A blank secret means "keep what is stored", not "erase it".
      if (spec.secret && value === '') continue;

      settings.set(spec.key, value);
    }

    return redirect(reply, '/settings', { kind: 'ok', message: 'Settings saved.' });
  });

  app.post('/settings/endpoints', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
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
