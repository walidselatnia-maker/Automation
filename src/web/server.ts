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
        problems: settings.validate(),
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

  const saveSite = (body: Record<string, unknown>, domainOverride?: string): void => {
    upsertSite({
      name: asString(body.name).trim(),
      domain: (domainOverride ?? asString(body.domain))
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, ''),
      status: asString(body.status) === 'active' ? 'active' : 'paused',
      pin_username: asString(body.pin_username).trim(),
      project_id: asString(body.project_id).trim(),
      buffer_channel_id: asString(body.buffer_channel_id).trim(),
      daily_target: Math.max(0, asNumber(body.daily_target, 0)),
      hours_between: Math.max(0, asNumber(body.hours_between, 8)),
    });
  };

  app.post('/sites', async (request, reply) => {
    try {
      saveSite(request.body as Record<string, unknown>);
      return redirect(reply, '/sites', { kind: 'ok', message: 'Site added.' });
    } catch (err) {
      return redirect(reply, '/sites', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/sites/:id', async (request, reply) => {
    const site = getSite(asNumber((request.params as { id: string }).id, 0));
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    try {
      saveSite(request.body as Record<string, unknown>, site.domain);
      return redirect(reply, '/sites', { kind: 'ok', message: `${site.domain} updated.` });
    } catch (err) {
      return redirect(reply, `/sites/${site.id}`, { kind: 'error', message: errorMessage(err) });
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

  app.get('/settings', async (request, reply) => {
    const values = new Map(SETTING_SPECS.map((s) => [s.key, settings.get(s.key)] as const));
    return page(
      reply,
      'Settings',
      '/settings',
      settingsPage(SETTING_SPECS, values, listEndpoints(encryptionKey), settings.validate()),
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
    const baseUrl = asString(body.base_url).trim();

    if (!name || !baseUrl) {
      return redirect(reply, '/settings', {
        kind: 'error',
        message: 'Endpoint name and base URL are required.',
      });
    }

    try {
      upsertEndpoint(
        {
          name,
          baseUrl,
          apiKey: asString(body.api_key).trim(),
          models: asString(body.models)
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean),
          enabled: true,
        },
        encryptionKey,
      );
      return redirect(reply, '/settings', { kind: 'ok', message: `Endpoint "${name}" saved.` });
    } catch (err) {
      return redirect(reply, '/settings', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/endpoints/:id/delete', async (request, reply) => {
    deleteEndpoint(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/settings', { kind: 'ok', message: 'Endpoint deleted.' });
  });

  app.post('/settings/endpoints/:id/reset', async (request, reply) => {
    resetEndpointHealth(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/settings', { kind: 'ok', message: 'Endpoint health reset.' });
  });

  /* -- Health ------------------------------------------------------------ */

  app.get('/healthz', async (_request, reply) => {
    const lock = lockStatus();
    return reply.send({
      ok: true,
      automation: settings.getBool('automation_enabled'),
      busy: Boolean(lock?.locked_at),
      problems: settings.validate(),
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
