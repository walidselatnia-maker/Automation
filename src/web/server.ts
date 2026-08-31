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
  keywordAddPage,
  keywordDetailPage,
  keywordsPage,
  promptEditPage,
  promptsPage,
  runDetailPage,
  runsPage,
  settingsPage,
  siteEditPage,
  sitesPage,
} from './views/pages.js';
import type { KeywordFilterView, SiteMark } from './views/pages.js';
import { importKeywordsCsv, importSitesCsv } from './import.js';
import {
  activateSite,
  setAutoPublish,
  bulkDeleteKeywords,
  bulkSetKeywordStatus,
  bulkSetLinks,
  bulkSetShareImages,
  countKeywords,
  countKeywordsMatching,
  keywordViewCounts,
  countRuns,
  deleteKeyword,
  deleteSite,
  getKeyword,
  getSite,
  getSiteByDomain,
  listDecisions,
  listEvents,
  listRecentCycles,
  listHeldRuns,
  listPromptVersions,
  listRuns,
  listSites,
  listSteps,
  getPromptVersion,
  dailyActivity,
  createRun,
  discardRun,
  getLinkShare,
  listRunsForKeyword,
  publishedTitles,
  replaceStepOutput,
  setRunTitle,
  type StepRow,
  clearSharedImages,
  getLinksForKeyword,
  keywordImageCounts,
  keywordsInGroup,
  sharedImageInfo,
  pauseSite,
  runUsage,
  savePromptVersion,
  setModelOverride,
  searchKeywords,
  deletePromptOverride,
  getPromptOverride,
  loadLinkGrid,
  loadKeywordViews,
  loadLinkViews,
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
  backupTo,
  clearHistory,
  exportSitesWithCredentials,
  forgetAllSharedImages,
  compactDatabase,
  dataCounts,
  exportDataset,
  type Dataset,
} from '../db/maintenance.js';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteEndpoint,
  listEndpoints,
  resetEndpointHealth,
  upsertEndpoint,
} from '../llm/pool.js';
import { executePipeline, PipelineContext } from '../pipeline/index.js';
import { evaluateSite, localDateKey } from '../core/selector.js';
import { diagnoseKeyword } from '../core/diagnosis.js';
import { findDuplicate } from '../core/similar-title.js';
import { readSupply, supplyWarning } from '../core/supply.js';
import { listPromptFiles } from '../pipeline/prompt-files.js';
import {
  invalidatePromptCache,
  KNOWN_MODELS,
  modelChoices,
  modelFor,
  PROMPT_MODELS,
  readShippedPrompt,
} from '../pipeline/prompts.js';
import { unknownVariables, variablesFor } from '../pipeline/prompt-contexts.js';
import { SETTING_SPECS, type Settings } from '../settings.js';
import { lockStatus, resumeRun, setImageServiceProblem, tick } from '../scheduler/index.js';
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
        keywords: loadKeywordViews(),
        links: loadLinkViews(),
        cycles,
        selectedCycle,
        decisions: selectedCycle ? listDecisions(selectedCycle) : [],
        held: listHeldRuns(20),
        activity: dailyActivity(30, timezone),
      }),
      readFlash(request.query),
    );
  });

  /** Turn a tick's outcome into something worth reading on the dashboard. */
  const describeTick = (result: {
    outcome: string;
    detail?: string;
    runId?: number;
    hold?: string;
  }): Flash => {
    const messages: Record<string, string> = {
      published: 'Published successfully.',
      failed: `Run failed: ${result.detail ?? 'see the run detail page'}`,
      'spy-rejected': 'Spy source rejected; the keyword was marked unusable.',
      held:
        result.hold === 'dry'
          ? 'Dry run finished. The article is written and nothing was published — open the run to read it.'
          : 'Article written and waiting for approval — open the run to read it.',
      'no-task': `Nothing to publish: ${result.detail ?? ''}`,
      busy: 'A run is already in progress.',
      disabled: 'Automation is disabled. Enable it in Settings first.',
      misconfigured: `Configuration incomplete: ${result.detail ?? ''}`,
    };

    return {
      kind:
        result.outcome === 'published'
          ? 'ok'
          : result.outcome === 'failed'
            ? 'error'
            : result.outcome === 'held'
              ? 'ok'
              : 'warn',
      message: messages[result.outcome] ?? result.outcome,
    };
  };

  app.post('/run-now', async (request, reply) => {
    // A dry run exercises the whole pipeline and stops before posting, which
    // is the only way to see what a prompt change does without a live site
    // finding out first.
    const body = formBody(request);
    const mode = asString(body.mode) === 'dry' ? 'dry' : 'live';

    // A hand-picked pair runs immediately: no eligibility check, no waiting
    // for the next scheduler tick, no queued retry taking the slot. Both ids
    // or neither — half a pair would silently fall back to the selector and
    // publish something the person did not ask for.
    const siteId = asNumber(body.site_id, 0);
    const keywordId = asNumber(body.keyword_id, 0);
    const pick = siteId > 0 && keywordId > 0 ? { siteId, keywordId } : undefined;

    if ((siteId > 0) !== (keywordId > 0)) {
      return redirect(reply, '/', {
        kind: 'error',
        message: 'Pick both a site and a keyword, or neither.',
      });
    }

    try {
      const result = await tick(settings, encryptionKey, { mode, pick });
      const flash = describeTick(result);
      return redirect(reply, result.runId ? `/runs/${result.runId}` : '/', flash);
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

    const steps = listSteps(id);
    const article = storedArticle(steps);

    return page(
      reply,
      run.title || `Run ${id}`,
      '/runs',
      runDetailPage({
        run,
        steps,
        site: run.site_id ? getSite(run.site_id) : undefined,
        keyword: run.keyword_id ? getKeyword(run.keyword_id) : undefined,
        usage: runUsage(id),
        article,
        // Only worth computing where it will be read: on a held run, next to
        // the decision about whether to publish it.
        duplicate:
          run.hold && run.site_id && run.title
            ? findDuplicate(run.title, publishedTitles(run.site_id).filter((t) => t.title !== run.title))
            : null,
      }),
      readFlash(request.query),
    );
  });

  /** The generated article, read back out of its checkpoint. */
  const storedArticle = (steps: StepRow[]): Record<string, unknown> | null => {
    const step = steps.find((s) => s.step === 'generate-article' && s.status === 'ok');
    if (!step?.output_json) return null;

    try {
      const parsed = JSON.parse(step.output_json) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      // A truncated checkpoint is not worth a 500 on the page that would show
      // you it was truncated.
      return null;
    }
  };

  /**
   * Edit the generated article before it is published.
   *
   * Writes over the step's stored output, which is what a resume replays — so
   * approving after an edit publishes exactly what was on screen. Refused
   * unless it parses, because saving a malformed document here would turn a
   * held article into a failure at the post step later.
   */
  app.post('/runs/:id/article', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const run = getRun(id);
    if (!run) return redirect(reply, '/runs', { kind: 'error', message: 'Run not found' });

    if (!run.hold) {
      return redirect(reply, `/runs/${id}`, {
        kind: 'error',
        message: 'This run is not waiting for anything, so its article is not editable.',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(asString(formBody(request).article));
    } catch (err) {
      return redirect(reply, `/runs/${id}`, {
        kind: 'error',
        message: `That is not valid JSON, so it was not saved: ${errorMessage(err)}`,
      });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return redirect(reply, `/runs/${id}`, {
        kind: 'error',
        message: 'The article has to be a JSON object.',
      });
    }

    const article = parsed as Record<string, unknown>;
    replaceStepOutput(id, 'generate-article', article);

    const title = typeof article.title === 'string' ? article.title.trim() : '';
    if (title) setRunTitle(id, title);

    return redirect(reply, `/runs/${id}`, {
      kind: 'ok',
      message: 'Saved. Approving now publishes what you edited.',
    });
  });

  /**
   * Throw away a held article and let the keyword be written again.
   *
   * The link goes back to `go` deliberately: discarding means "this attempt
   * was not good enough", not "never publish this keyword here". Leaving it
   * `done` would quietly retire the keyword for a rejection.
   */
  app.post('/runs/:id/discard', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const run = getRun(id);
    if (!run) return redirect(reply, '/runs', { kind: 'error', message: 'Run not found' });

    if (!run.hold) {
      return redirect(reply, `/runs/${id}`, {
        kind: 'error',
        message: 'Only an article waiting for approval can be discarded.',
      });
    }

    discardRun(id);
    if (run.keyword_id && run.site_id) setLink(run.keyword_id, run.site_id, 'go');

    return redirect(reply, '/', {
      kind: 'ok',
      message: 'Discarded. The keyword is back to go, so it will be written again.',
    });
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
        // Absent, not blank. The site form no longer carries these — pausing
        // and publishing mode are their own controls on the site page — and
        // upsertSite reads undefined as "keep what is stored". Reading them
        // off the body regardless would make every save of the settings form
        // silently clear the pause reason and switch approval back on.
        paused_reason: 'paused_reason' in body ? asString(body.paused_reason).trim() : undefined,
        auto_publish:
          'auto_publish' in body ? asString(body.auto_publish, '1') !== '0' : undefined,
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

  /**
   * Pause a site with a note and, usually, an end.
   *
   * The quick control on the site page rather than the full form, because
   * pausing is something you do in a hurry when a site starts misbehaving —
   * and the reason is worth capturing exactly then, while you still know it.
   */
  app.post('/sites/:id/pause', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    const body = formBody(request);
    const reason = asString(body.reason).trim() || 'No reason given';
    const hours = Math.max(0, asNumber(body.hours, 24));
    const until = hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;

    pauseSite(id, reason, until);

    return redirect(reply, `/sites/${id}`, {
      kind: 'ok',
      message: until
        ? `${site.domain} is paused and will resume by itself in ${hours} hour(s).`
        : `${site.domain} is paused until you resume it.`,
    });
  });

  /**
   * Whether this site publishes on its own or holds each article for you.
   *
   * Its own control beside Pause rather than a field in the settings form:
   * both answer "what is this site doing right now", and neither means
   * anything on a site that does not exist yet.
   */
  app.post('/sites/:id/publishing', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    const auto = asString(formBody(request).auto_publish, '1') !== '0';
    setAutoPublish(id, auto);

    return redirect(reply, `/sites/${id}`, {
      kind: 'ok',
      message: auto
        ? `${site.domain} publishes automatically again.`
        : `${site.domain} will hold every article until you approve it.`,
    });
  });

  app.post('/sites/:id/activate', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    activateSite(id);
    return redirect(reply, `/sites/${id}`, {
      kind: 'ok',
      message: `${site.domain} is publishing again.`,
    });
  });

  /**
   * Bulk site entry from a spreadsheet.
   *
   * Matched on the domain, so importing the same file twice corrects rather
   * than duplicates. A blank token keeps whatever is stored, which is what
   * makes the credential-free export safe to edit and import back.
   */
  app.post('/sites/import', async (request, reply) => {
    try {
      const file = await request.file();
      if (!file) {
        return redirect(reply, '/sites', { kind: 'error', message: 'No file received.' });
      }

      const report = importSitesCsv((await file.toBuffer()).toString('utf8'), encryptionKey);

      if (report.errors.length > 0 && report.added + report.updated === 0) {
        return redirect(reply, '/sites', {
          kind: 'error',
          message: report.errors.slice(0, 3).join(' '),
        });
      }

      const parts: string[] = [];
      if (report.added) parts.push(`${report.added} site(s) added`);
      if (report.updated) parts.push(`${report.updated} updated`);
      if (report.skipped) parts.push(`${report.skipped} row(s) skipped with no domain`);

      let message = parts.length ? `${parts.join(', ')}.` : 'Nothing in that file to import.';

      // Saying which happened matters: a file with no token columns leaves the
      // stored credentials alone, and somebody expecting it to have set them
      // would otherwise find out at the next run.
      message +=
        report.withCredentials > 0
          ? ` ${report.withCredentials} row(s) carried credentials.`
          : ' No credentials in that file, so the stored ones were left untouched.';

      if (report.errors.length) {
        message += ` Failed: ${report.errors.slice(0, 3).join('; ')}`;
      }

      return redirect(reply, '/sites', {
        kind: report.errors.length ? 'warn' : 'ok',
        message,
      });
    } catch (err) {
      return redirect(reply, '/sites', { kind: 'error', message: errorMessage(err) });
    }
  });

  /**
   * Every site with its tokens in plain text.
   *
   * Its own route rather than a flag on /data/export/sites, because the two
   * files are not the same kind of thing: one is safe to attach to a message
   * and the other can publish to every site you own. That difference should
   * cost a separate deliberate click.
   */
  app.get('/sites/export/credentials', async (_request, reply) => {
    const data = exportSitesWithCredentials(encryptionKey);
    log.warn('site credentials exported in plain text');
    return csvFile(reply, data.filename, data.rows);
  });

  app.post('/sites/:id/delete', async (request, reply) => {
    deleteSite(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/sites', { kind: 'ok', message: 'Site deleted.' });
  });

  /* -- Keywords ---------------------------------------------------------- */

  /** The view the keywords page was asked for, normalised. */
  const readKeywordFilter = (query: unknown): KeywordFilterView => {
    const q = query as { q?: string; view?: string; site?: string };
    const view = asString(q.view);

    return {
      q: asString(q.q).trim(),
      view:
        view === 'queued' || view === 'stuck' || view === 'done' || view === 'off'
          ? view
          : 'all',
      siteId: Math.max(0, asNumber(q.site, 0)),
    };
  };

  app.get('/keywords', async (request, reply) => {
    const q = request.query as { page?: string };
    const pageNum = Math.max(1, asNumber(q.page, 1));
    const filter = readKeywordFilter(request.query);

    const sites = listSites();
    const rows = searchKeywords(filter, 100, (pageNum - 1) * 100);

    // One dot per site, per keyword. Built from the whole grid in memory
    // rather than a query each: it is one small table and this is the only
    // page that needs it laid out this way.
    const grid = loadLinkGrid();
    const marks = new Map<number, SiteMark[]>();

    for (const keyword of rows) {
      marks.set(
        keyword.id,
        sites.map((site) => {
          const cell = grid.find((l) => l.keywordId === keyword.id && l.siteId === site.id);
          return { domain: site.domain, status: cell?.status ?? ('unlinked' as const) };
        }),
      );
    }

    return page(
      reply,
      'Keywords',
      '/keywords',
      keywordsPage(
        rows,
        sites,
        marks,
        pageNum,
        countKeywords(),
        countKeywordsMatching(filter),
        keywordViewCounts(filter.siteId),
        filter,
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

      const parts: string[] = [];
      if (report.imported) parts.push(`${report.imported} keyword(s) added`);
      if (report.updated) parts.push(`${report.updated} updated`);
      parts.push(`${report.linksSet} site link(s) set`);
      if (report.skipped) parts.push(`${report.skipped} row(s) skipped`);

      let message = `${parts.join(', ')}.`;

      // A keyword linked to no site is not work â€” it will sit there looking
      // like supply and publish nothing. Say so plainly rather than reporting
      // a successful import and leaving the queue empty.
      if (report.matchedDomains === 0) {
        message +=
          ' No column matched a site, so nothing will publish yet.' +
          (report.unknownDomains.length
            ? ` These headings match no site you have configured: ${report.unknownDomains.join(', ')}.` +
              ' Check the domains under Sites, or download the template â€” its columns always match.'
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

  app.get('/keywords/add', async (request, reply) =>
    page(reply, 'Add keywords', '/keywords', keywordAddPage(), readFlash(request.query)),
  );

  /**
   * Act on every ticked keyword.
   *
   * Each action is a verb that does one thing, because the bar this replaced
   * read "Status [leave as is] On [all sites] set to [leave as is]" — two
   * identical-looking dropdowns meaning different things, in a sentence with
   * no verb in it. Nobody could predict what Apply would do, so nobody used it.
   */
  app.post('/keywords/bulk', async (request, reply) => {
    const body = formBody(request);

    // Fastify's form parser gives a single string for one checkbox and an
    // array for several; a submission with none ticked gives nothing.
    const picked = body.ids;
    const ids = (Array.isArray(picked) ? picked : picked === undefined ? [] : [picked])
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

    const action = asString(body.action);
    const siteId = Math.max(0, asNumber(body.site_id, 0));
    const siteIds = siteId ? [siteId] : [];
    const where = siteId
      ? (getSite(siteId)?.domain ?? 'that site')
      : 'every site';

    const done = (message: string): FastifyReply =>
      redirect(reply, back, { kind: 'ok', message });

    switch (action) {
      case 'publish-on': {
        // Setting the cells alone is not enough: a keyword whose own status is
        // done or no would still never be offered, and the row would sit there
        // looking correct. Turning it on is what the operator meant.
        const cells = bulkSetLinks(ids, siteIds, 'go');
        bulkSetKeywordStatus(ids, 'go');
        return done(
          `${ids.length} keyword(s) will now publish on ${where} (${cells} cell(s) set), ` +
            'and they are switched on.',
        );
      }

      case 'stop-on': {
        const cells = bulkSetLinks(ids, siteIds, 'no');
        return done(`${ids.length} keyword(s) will no longer publish on ${where} (${cells} cell(s)).`);
      }

      case 'finish':
        bulkSetKeywordStatus(ids, 'done');
        return done(`${ids.length} keyword(s) marked finished.`);

      case 'off':
        bulkSetKeywordStatus(ids, 'no');
        return done(`${ids.length} keyword(s) turned off.`);

      case 'share-on': {
        const cells = bulkSetShareImages(ids, siteIds, true);
        return done(`${cells} cell(s) will reuse existing article images on ${where}.`);
      }

      case 'share-off': {
        const cells = bulkSetShareImages(ids, siteIds, false);
        return done(`${cells} cell(s) will generate fresh article images on ${where}.`);
      }

      case 'delete': {
        const removed = bulkDeleteKeywords(ids);
        return done(`Deleted ${removed} keyword(s).`);
      }

      default:
        return redirect(reply, back, {
          kind: 'error',
          message: 'That is not something this page can do.',
        });
    }
  });

  /**
   * One keyword, and why it is or is not publishing.
   *
   * Decisions answer that question per cycle. This answers it per keyword,
   * which is the direction it is actually asked in — "this one has never gone
   * out, why?" — and reuses the selector's own evaluateSite, so a verdict here
   * and a verdict in the scheduler cannot drift apart.
   */
  app.get('/keywords/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const keyword = getKeyword(id);
    if (!keyword) {
      return redirect(reply, '/keywords', { kind: 'error', message: 'Keyword not found' });
    }

    const timezone = settings.get('timezone');
    const now = new Date();
    const sites = loadSiteViews(localDateKey(now, timezone), timezone);

    const diagnosis = diagnoseKeyword(
      { id: keyword.id, seedKeyword: keyword.seed_keyword, status: keyword.status },
      sites,
      getLinksForKeyword(id).map((l) => ({
        siteId: l.site_id,
        status: l.status as 'go' | 'done' | 'no',
      })),
      { now, timezone },
    );

    return page(
      reply,
      keyword.seed_keyword,
      '/keywords',
      keywordDetailPage(
        keyword,
        diagnosis,
        listRunsForKeyword(id),
        new Map(loadLinkGrid().filter((l) => l.keywordId === id).map((l) => [l.siteId, l.shareImages])),
        sharedImageInfo(id),
        keywordImageCounts(id),
        keywordsInGroup(keyword.seed_keyword, id),
      ),
      readFlash(request.query),
    );
  });

  /**
   * Write this keyword's article now, without publishing it.
   *
   * The scheduler picks its own pair, so "dry run" on the dashboard exercises
   * whatever is next in the queue. Here the keyword is already chosen, which
   * is what you want when the question is about this article rather than about
   * the pipeline.
   */
  app.post('/keywords/:id/dry-run', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const keyword = getKeyword(id);
    if (!keyword) {
      return redirect(reply, '/keywords', { kind: 'error', message: 'Keyword not found' });
    }

    const timezone = settings.get('timezone');
    const now = new Date();
    const sites = loadSiteViews(localDateKey(now, timezone), timezone);

    // Whichever linked site would take it, ignoring the daily target and the
    // interval: a dry run publishes nothing, so neither limit is protecting
    // anything here.
    const linked = getLinksForKeyword(id).filter((l) => l.status === 'go');
    const target =
      linked.map((l) => sites.find((s) => s.id === l.site_id)).find((s) => s?.status === 'active') ??
      linked.map((l) => sites.find((s) => s.id === l.site_id)).find(Boolean);

    if (!target) {
      return redirect(reply, `/keywords/${id}`, {
        kind: 'warn',
        message:
          'This keyword is not set to go on any site, so there is no site to write it for. ' +
          'Set a cell to go first.',
      });
    }

    const site = getSite(target.id);
    if (!site) {
      return redirect(reply, `/keywords/${id}`, { kind: 'error', message: 'That site vanished.' });
    }

    try {
      const runId = createRun(id, site.id, 'dry');
      const ctx = new PipelineContext({
        runId,
        site,
        keyword,
        settings,
        encryptionKey,
        shareImages: getLinkShare(id, site.id),
        mode: 'dry',
      });

      const outcome = await executePipeline(ctx);
      return redirect(reply, `/runs/${runId}`, {
        kind: outcome.status === 'failed' ? 'error' : 'ok',
        message:
          outcome.status === 'held'
            ? `Written for ${site.domain} and not published. Read it below.`
            : outcome.status === 'failed'
              ? `The dry run failed: ${outcome.error ?? ''}`
              : `Dry run ended as "${outcome.status}".`,
      });
    } catch (err) {
      return redirect(reply, `/keywords/${id}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/keywords/:id/delete', async (request, reply) => {
    deleteKeyword(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/keywords', { kind: 'ok', message: 'Keyword deleted.' });
  });

  app.post('/keywords/:id/status', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const status = asString(formBody(request).status, 'no');
    if (status === 'go' || status === 'done' || status === 'no') setKeywordStatus(id, status);
    return redirect(reply, `/keywords/${id}`);
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
    return redirect(reply, `/keywords/${id}`);
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
      ['name', 'domain', 'status', 'daily_target', 'interval_minutes', 'pin_username',
        'project_id', 'auto_publish', 'paused_reason', 'api_token', 'buffer_token'],
      ['bitespoon', 'bitespoon.com', 'active', '3', '480', 'cookwithbitespoon', '',
        'yes', '', 'paste-the-site-token', 'paste-the-buffer-token'],
      ['longlivo', 'longlivo.com', 'paused', '0', '480', 'prepplat', '',
        'no', 'waiting on their API', '', ''],
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

  /**
   * The whole database as one file.
   *
   * Written to a temporary directory with VACUUM INTO, streamed, then removed.
   * A plain copy of the .db would be missing every write still in the WAL
   * sidecar, which is the kind of backup you only discover is wrong when you
   * restore it.
   */
  app.get('/data/backup', async (_request, reply) => {
    const directory = await mkdtemp(join(tmpdir(), 'platform-backup-'));
    const file = join(directory, 'platform.db');

    try {
      backupTo(file);
    } catch (err) {
      await rm(directory, { recursive: true, force: true });
      return redirect(reply, '/settings/data', { kind: 'error', message: errorMessage(err) });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const stream = createReadStream(file);

    // Cleaned up once the response is done, however it ends — a client that
    // disconnects mid-download should not leave a copy of the database in the
    // container's temp directory.
    const cleanup = (): void => {
      void rm(directory, { recursive: true, force: true });
    };
    stream.once('close', cleanup);
    stream.once('error', cleanup);

    return reply
      .type('application/octet-stream')
      .header('content-disposition', `attachment; filename="platform-${stamp}.db"`)
      .send(stream);
  });

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
    page(
      reply,
      'Prompts',
      '/settings',
      promptsPage(listPromptFiles(), modelChoices(), KNOWN_MODELS),
      readFlash(request.query),
    ),
  );

  /**
   * Point one prompt at a different model.
   *
   * Blank puts it back on the shipped default rather than storing an empty
   * string, so "undo" is the same gesture as "leave it alone".
   */
  app.post('/settings/prompts/model', async (request, reply) => {
    const body = formBody(request);
    const prompt = asString(body.prompt).trim();
    const model = asString(body.model).trim();

    if (!PROMPT_MODELS[prompt]) {
      return redirect(reply, '/settings/prompts', {
        kind: 'error',
        message: `There is no prompt called "${prompt}".`,
      });
    }

    setModelOverride(prompt, model);
    invalidatePromptCache();

    return redirect(reply, '/settings/prompts', {
      kind: 'ok',
      message: model
        ? `"${prompt}" now goes to ${model}. It applies to the next run.`
        : `"${prompt}" is back on its shipped model, ${PROMPT_MODELS[prompt].model}.`,
    });
  });

  /** Put an earlier version of a prompt back, as a new save. */
  app.post('/settings/prompts/:file/restore', async (request, reply) => {
    const file = promptFile(asString((request.params as { file: string }).file));
    if (!file) {
      return redirect(reply, '/settings/prompts', {
        kind: 'error',
        message: 'No such prompt file.',
      });
    }

    const version = getPromptVersion(asNumber(formBody(request).version, 0));
    if (!version || version.name !== file) {
      return redirect(reply, `/settings/prompts/${file}`, {
        kind: 'error',
        message: 'That version is not one of this prompt&#39;s.',
      });
    }

    // Saved as a new version rather than rewinding, so restoring is itself
    // undoable — going back should never destroy what you were on.
    savePromptVersion(file, getPromptOverride(file) ?? readShippedPrompt(file));
    setPromptOverride(file, version.body);
    invalidatePromptCache();

    return redirect(reply, `/settings/prompts/${file}`, {
      kind: 'ok',
      message: `Restored the version saved ${version.created_at}. The one it replaced is still in the list.`,
    });
  });

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
        model: modelFor(promptName),
        variables: variablesFor(promptName),
        unknown: unknownVariables(promptName, body),
        edited: override !== undefined,
        shipped,
        versions: listPromptVersions(file),
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

    // The version *before* this edit, so the list is "what I could go back
    // to" rather than "what I have already got".
    savePromptVersion(file, getPromptOverride(file) ?? readShippedPrompt(file));
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
    } finally {
      // The scheduler notifies on this but must not poll it: a second poller
      // would double the traffic to a container that is, by definition,
      // already having a hard time.
      setImageServiceProblem(imageServiceProblem);
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
