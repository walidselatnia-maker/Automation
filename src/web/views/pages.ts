import {
  emptyState,
  formatCount,
  formatDuration,
  formatTokens,
  html,
  Html,
  raw,
  runBadge,
  sparkline,
  statusBadge,
  timeAgo,
} from './layout.js';
import { hasSecret } from '../../db/repos.js';
import type {
  DecisionRow,
  EventRow,
  KeywordRow,
  RunListRow,
  RunRow,
  SiteRow,
  StepRow,
} from '../../db/repos.js';
import type { SiteView } from '../../core/types.js';
import { formatMinutes } from '../../core/selector.js';
import type { Endpoint } from '../../llm/pool.js';
import type { SettingSpec } from '../../settings.js';
import type { Supply } from '../../core/supply.js';
import type { RunUsage, StepCost } from '../../db/repos.js';
import type { KeywordDiagnosis } from '../../core/diagnosis.js';
import type { Candidate } from '../url-import.js';
import type { DataCounts } from '../../db/maintenance.js';

/* =========================================================================
 * Dashboard
 * ====================================================================== */

export interface DashboardData {
  sites: SiteView[];
  eligibility: { domain: string; eligible: boolean; reason: string }[];
  publishedToday: number;
  failedToday: number;
  supply: Supply;
  recentRuns: RunListRow[];
  automationOn: boolean;
  problems: string[];
  busy: boolean;
  lockedAt: string | null;
  /** Scheduler checks, newest first — the Decisions page, folded in here. */
  cycles: { cycle_id: string; created_at: string; n: number }[];
  selectedCycle: string | null;
  decisions: DecisionRow[];
  /** Articles written and stopped before publishing, waiting for a person. */
  held: RunListRow[];
  /** Published and failed per day, oldest first. */
  activity: { day: string; published: number; failed: number }[];
}

export function dashboardPage(data: DashboardData): Html {
  const problems = data.problems.length
    ? html`<div class="flash warn">
        <strong>Configuration needs attention</strong>
        <ul>
          ${data.problems.map((p) => html`<li>${p}</li>`)}
        </ul>
      </div>`
    : raw('');

  const busy = data.busy
    ? html`<div class="flash ok">A run is in progress (started ${timeAgo(data.lockedAt)}).</div>`
    : raw('');

  return html`
    <div class="spread">
      <div>
        <h1>Dashboard</h1>
        <p class="subtitle">
          ${data.automationOn
            ? 'Automation is running. The scheduler publishes at most one article per check.'
            : 'Automation is off. Turn it on in Settings when you are ready.'}
        </p>
      </div>
      <div class="row">
        <form method="post" action="/run-now">
          <input type="hidden" name="mode" value="dry" />
          <button type="submit" ${data.busy ? raw('disabled') : raw('')}
                  title="Run the whole pipeline and stop before publishing, so you can read the article first">
            Dry run
          </button>
        </form>
        <form method="post" action="/run-now">
          <button class="primary" type="submit" ${data.busy ? raw('disabled') : raw('')}>
            Run once now
          </button>
        </form>
      </div>
    </div>

    ${problems} ${busy}

    <div class="grid">
      <div class="stat"><div class="value">${data.publishedToday}</div><div class="label">Published today</div></div>
      <div class="stat"><div class="value">${data.failedToday}</div><div class="label">Failed today</div></div>
      <div class="stat"><div class="value">${data.eligibility.filter((e) => e.eligible).length}</div><div class="label">Sites eligible now</div></div>
      <div class="stat ${data.supply.level === 'ok' ? '' : `supply-${data.supply.level}`}">
        <div class="value">${data.supply.readyPairs}</div>
        <div class="label">Articles queued</div>
        <div class="muted small">
          ${data.supply.daysRemaining === null
            ? 'no active demand'
            : data.supply.daysRemaining >= 1
              ? `~${Math.floor(data.supply.daysRemaining)} day(s) left`
              : 'less than a day left'}
        </div>
      </div>
    </div>

    ${data.activity.length
      ? html`<div class="card">
          <div class="spread" style="align-items:center">
            <h3 style="margin:0">Last ${data.activity.length} days</h3>
            <span class="muted small">
              <span class="key brand"></span> published
              <span class="key red"></span> failed
            </span>
          </div>
          <div class="chart">${sparkline(data.activity, { width: 720, height: 52 })}</div>
        </div>`
      : raw('')}

    ${heldSection(data.held)}

    <h2>Site status</h2>
    <div class="card table-wrap">
      ${data.sites.length === 0
        ? emptyState('No sites yet. Add one under Sites.')
        : html`<table>
            <thead>
              <tr><th>Site</th><th>Status</th><th>Today</th><th>Last publish</th><th>Eligible now?</th></tr>
            </thead>
            <tbody>
              ${data.sites.map((site) => {
                const verdict = data.eligibility.find((e) => e.domain === site.domain);
                return html`<tr>
                  <td><a href="/sites">${site.domain}</a><div class="muted small">${site.name}</div></td>
                  <td>${statusBadge(site.status)}</td>
                  <td class="nowrap">${site.publishedToday} / ${site.dailyTarget}</td>
                  <td class="nowrap muted">${timeAgo(site.lastPublishAt)}</td>
                  <td>
                    ${verdict?.eligible
                      ? html`<span class="badge ok">yes</span>`
                      : html`<span class="badge muted">no</span>
                          <div class="muted small">${verdict?.reason ?? ''}</div>`}
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </div>

    <h2>Recent runs <a class="button small" href="/runs">All runs</a></h2>
    <div class="card table-wrap scroll-y">
      ${data.recentRuns.length === 0
        ? emptyState('No runs yet.')
        : runTable(data.recentRuns)}
    </div>

    ${decisionsSection(data.cycles, data.selectedCycle, data.decisions)}
  `;
}

/**
 * Articles that are finished and waiting for a person.
 *
 * Deliberately above the site table: an article sitting here is work already
 * paid for that is doing nothing, and it is the one thing on this page that
 * only moves when someone acts.
 */
function heldSection(held: RunListRow[]): Html {
  if (held.length === 0) return raw('');

  return html`
    <h2>Waiting for you</h2>
    <div class="card table-wrap">
      <table>
        <thead>
          <tr><th>Article</th><th>Site</th><th>Why it stopped</th><th>Written</th><th></th></tr>
        </thead>
        <tbody>
          ${held.map(
            (run) => html`<tr>
              <td>
                <strong>${run.title || run.seed_keyword || `Run #${run.id}`}</strong>
                ${run.title ? html`<div class="muted small">${run.seed_keyword ?? ''}</div>` : raw('')}
              </td>
              <td class="mono small">${run.site_domain ?? '—'}</td>
              <td>${runBadge(run)}</td>
              <td class="nowrap muted small">${timeAgo(run.started_at)}</td>
              <td class="nowrap"><a class="button small primary" href="/runs/${run.id}">Read it</a></td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Why the scheduler did what it did.
 *
 * This had its own page, which meant leaving the dashboard to answer a
 * question the dashboard had just raised — "why is nothing publishing?". It is
 * one table and a row of buttons, so it belongs under the numbers it explains.
 */
function decisionsSection(
  cycles: { cycle_id: string; created_at: string; n: number }[],
  selected: string | null,
  rows: DecisionRow[],
): Html {
  if (cycles.length === 0) {
    return html`
      <h2>Decisions</h2>
      <div class="card">
        ${emptyState('No scheduler checks recorded yet. Every skip will be explained here.')}
      </div>
    `;
  }

  return html`
    <h2>Decisions</h2>
    <p class="subtitle">
      Every site checked and every keyword skipped, with the reason recorded at
      the moment the choice was made. Pick a check to read it.
    </p>

    <div class="card">
      <div class="row wrap">
        ${cycles.map(
          (c) => html`<a class="button small ${c.cycle_id === selected ? 'primary' : ''}"
            href="/?cycle=${c.cycle_id}#decisions">${timeAgo(c.created_at)} (${c.n})</a>`,
        )}
      </div>
    </div>

    ${selected
      ? html`<div class="card table-wrap scroll-y" id="decisions">
          <table>
            <thead><tr><th>Type</th><th>Subject</th><th>Decision</th><th>Reason</th></tr></thead>
            <tbody>
              ${rows.map(
                (r) => html`<tr>
                  <td class="muted small">${r.subject_type}</td>
                  <td>${r.subject_label || '—'}</td>
                  <td>${statusBadge(r.decision)}</td>
                  <td class="small">${r.reason}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`
      : raw('')}
  `;
}

/* =========================================================================
 * Runs
 * ====================================================================== */

function runTable(runs: RunListRow[]): Html {
  return html`<table>
    <thead>
      <tr><th>Started</th><th>Site</th><th>Keyword</th><th>Status</th><th>Detail</th><th></th></tr>
    </thead>
    <tbody>
      ${runs.map(
        (r) => html`<tr>
          <td class="nowrap muted">${timeAgo(r.started_at)}</td>
          <td>${r.site_domain ?? '—'}</td>
          <td>${r.seed_keyword ?? '—'}</td>
          <td>${runBadge(r)}</td>
          <td class="small">
            ${r.status === 'published'
              ? html`<a href="${r.post_url ?? '#'}" target="_blank" rel="noopener">view article</a>`
              : r.hold
                ? html`<span class="muted">${r.title || 'written, not published'}</span>`
                : html`<span class="muted"
                    >${r.failed_step ? `${r.failed_step}: ` : ''}${(r.error ?? '').slice(0, 120)}</span
                  >
                  ${r.retry_after
                    ? html`<div class="badge warn">retrying ${timeAgo(r.retry_after)}</div>`
                    : raw('')}`}
          </td>
          <td class="nowrap"><a class="button small" href="/runs/${r.id}">Open</a></td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

export function runsPage(runs: RunListRow[], page: number, total: number): Html {
  const pages = Math.max(1, Math.ceil(total / 50));
  return html`
    <h1>Runs</h1>
    <p class="subtitle">${total} run(s) recorded.</p>
    <div class="card table-wrap">
      ${runs.length === 0 ? emptyState('No runs yet.') : runTable(runs)}
    </div>
    ${pages > 1
      ? html`<div class="row">
          ${page > 1 ? html`<a class="button small" href="/runs?page=${page - 1}">Previous</a>` : raw('')}
          <span class="muted small">Page ${page} of ${pages}</span>
          ${page < pages ? html`<a class="button small" href="/runs?page=${page + 1}">Next</a>` : raw('')}
        </div>`
      : raw('')}
  `;
}

export interface RunDetailData {
  run: RunRow;
  steps: StepRow[];
  site: SiteRow | undefined;
  keyword: KeywordRow | undefined;
  usage: RunUsage;
  /** The generated article, when one has been produced. */
  article: Record<string, unknown> | null;
  /** An existing article on this site with almost the same title. */
  duplicate: { title: string; url: string | null; similarity: number } | null;
}

export function runDetailPage(data: RunDetailData): Html {
  const { run, steps, site, keyword } = data;

  return html`
    <div class="spread">
      <div>
        <h1>${run.title || `Run #${run.id}`}</h1>
        <p class="subtitle">
          ${site?.domain ?? 'unknown site'} · ${keyword?.seed_keyword ?? 'unknown keyword'} ·
          started ${timeAgo(run.started_at)}
          ${run.mode === 'dry' ? html` · <span class="badge brand">dry run</span>` : raw('')}
        </p>
      </div>
      <div class="row">
        ${runBadge(run)}
        ${run.status === 'failed'
          ? html`<form method="post" action="/runs/${run.id}/resume">
              <button class="primary" type="submit">Resume from failed step</button>
            </form>`
          : raw('')}
      </div>
    </div>

    ${run.hold ? approvalBar(run, data.duplicate) : raw('')}

    ${run.error
      ? html`<div class="flash error">
          <strong>Failed at "${run.failed_step ?? 'unknown'}"</strong>
          <div class="mono" style="margin-top:6px">${run.error}</div>
          ${run.retry_after
            ? html`<div class="small" style="margin-top:8px">
                Scheduled to retry by itself ${timeAgo(run.retry_after)} — attempt
                ${run.attempts + 1}. Resuming it here does the same thing sooner.
              </div>`
            : run.attempts > 0
              ? html`<div class="small" style="margin-top:8px">
                  Retried automatically ${run.attempts} time(s) and still failing, so it is
                  waiting for you.
                </div>`
              : raw('')}
        </div>`
      : raw('')}
    ${run.post_url
      ? html`<div class="flash ok">
          Published: <a href="${run.post_url}" target="_blank" rel="noopener">${run.post_url}</a>
        </div>`
      : raw('')}

    ${usageRow(data.usage)}

    ${data.article ? articlePreview(data.article, Boolean(run.hold), run.id) : raw('')}

    <h2>Steps</h2>
    ${steps.length === 0
      ? html`<div class="card">${emptyState('No steps recorded yet.')}</div>`
      : html`${steps.map(
          (step) => html`
            <div class="card step-${step.status}">
              <div class="spread">
                <div>
                  <strong>${step.step}</strong> ${statusBadge(step.status)}
                  <div class="muted small">
                    ${formatDuration(step.duration_ms)}
                    ${step.attempt > 1 ? html` · attempt ${step.attempt}` : raw('')}
                    ${step.endpoint ? html` · endpoint: ${step.endpoint}` : raw('')}
                    ${step.model ? html` · ${step.model}` : raw('')}
                    ${step.tokens_in + step.tokens_out > 0
                      ? html` · ${formatTokens(step.tokens_in)} in / ${formatTokens(step.tokens_out)} out`
                      : raw('')}
                    ${step.images > 0 ? html` · ${step.images} image(s)` : raw('')}
                  </div>
                </div>
                <span class="muted small nowrap">${timeAgo(step.started_at)}</span>
              </div>
              ${step.error
                ? html`<div class="flash error" style="margin-top:10px">${step.error}</div>`
                : raw('')}
              ${step.output_json
                ? html`<details>
                    <summary>Output</summary>
                    <pre>${prettyJson(step.output_json)}</pre>
                  </details>`
                : raw('')}
            </div>
          `,
        )}`}
  `;
}

/**
 * The decision bar on a held run.
 *
 * Approving is a resume: the article, the images and every other step are
 * already stored, so releasing it costs one HTTP post rather than a second
 * pipeline. That is also why discarding is offered here — the alternative to
 * "publish" should be visible in the same place, not hidden behind the run
 * list.
 */
function approvalBar(
  run: RunRow,
  duplicate: { title: string; url: string | null; similarity: number } | null,
): Html {
  return html`
    <div class="flash warn">
      <strong>
        ${run.hold === 'dry'
          ? 'Dry run — nothing was published'
          : 'Written and waiting for your approval'}
      </strong>
      <div class="small" style="margin-top:6px">
        ${run.hold === 'dry'
          ? html`This ran the whole pipeline against ${run.title ? 'the keyword' : 'a keyword'} and
              stopped before posting. The images were generated and uploaded; only the article
              itself was not published. Publish it anyway if you like what you see.`
          : html`This site has automatic publishing turned off, so every article stops here.
              Approving publishes it and continues to Pinterest exactly as a normal run would.`}
      </div>

      ${duplicate
        ? html`<div class="small" style="margin-top:10px">
            <span class="badge error">possible duplicate</span>
            ${Math.round(duplicate.similarity * 100)}% of the words overlap with
            &ldquo;${duplicate.title}&rdquo;, already on this site.
            ${duplicate.url
              ? html`<a href="${duplicate.url}" target="_blank" rel="noopener">Read the existing one</a>.`
              : raw('')}
          </div>`
        : raw('')}

      <div class="row wrap" style="margin-top:12px">
        <form method="post" action="/runs/${run.id}/resume">
          <button class="primary" type="submit">
            ${run.hold === 'dry' ? 'Publish it anyway' : 'Approve and publish'}
          </button>
        </form>
        <form method="post" action="/runs/${run.id}/discard"
              onsubmit="return confirm('Discard this article? The keyword goes back to go so it can be written again.')">
          <button class="danger" type="submit">Discard</button>
        </form>
      </div>
    </div>
  `;
}

/** What this run cost, from the tokens the provider reported per step. */
function usageRow(usage: RunUsage): Html {
  if (usage.tokensIn + usage.tokensOut + usage.images === 0) return raw('');

  return html`
    <div class="grid">
      <div class="stat">
        <div class="value">${formatTokens(usage.tokensIn + usage.tokensOut)}</div>
        <div class="label">Tokens</div>
        <div class="muted small">
          ${formatCount(usage.tokensIn)} in / ${formatCount(usage.tokensOut)} out
        </div>
      </div>
      <div class="stat">
        <div class="value">${usage.llmCalls}</div>
        <div class="label">Model calls</div>
      </div>
      <div class="stat">
        <div class="value">${usage.images}</div>
        <div class="label">Images generated</div>
      </div>
      <div class="stat">
        <div class="value">${formatDuration(usage.durationMs)}</div>
        <div class="label">Time in steps</div>
      </div>
    </div>
  `;
}

/**
 * The generated article, as prose rather than as JSON.
 *
 * The step output was always here in a <pre>, which is unreadable at article
 * length and impossible to judge — and judging it is the entire point of
 * holding it. The fields come from the prompts, so this renders what it
 * recognises and lists the rest rather than assuming a fixed shape.
 */
function articlePreview(
  article: Record<string, unknown>,
  editable: boolean,
  runId: number,
): Html {
  const text = (key: string): string => {
    const value = article[key];
    return typeof value === 'string' ? value : '';
  };

  const title = text('title') || text('name');
  const known = new Set(['title', 'name', 'description', 'intro', 'summary']);

  const body = Object.entries(article)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => html`
      <section class="article-block">
        <h4>${key.replace(/[_-]/g, ' ')}</h4>
        ${renderValue(value)}
      </section>
    `);

  return html`
    <h2>The article</h2>
    <div class="card article">
      ${title ? html`<h3 class="article-title">${title}</h3>` : raw('')}
      ${text('description') || text('intro') || text('summary')
        ? html`<p class="muted">${text('description') || text('intro') || text('summary')}</p>`
        : raw('')}
      ${body}
    </div>

    ${editable
      ? html`<details class="card">
          <summary>Edit the article before publishing</summary>
          <p class="muted small" style="margin-top:10px">
            This is the exact document that will be posted. Editing it here replaces the stored
            step output, so approving afterwards publishes what you see. It has to stay valid
            JSON — a malformed edit is refused rather than saved.
          </p>
          <form method="post" action="/runs/${runId}/article">
            <div class="field">
              <textarea name="article" rows="22" spellcheck="false"
                        class="mono">${JSON.stringify(article, null, 2)}</textarea>
            </div>
            <button class="primary" type="submit">Save the edit</button>
          </form>
        </details>`
      : raw('')}
  `;
}

/** Render one article field, whatever shape the prompt produced. */
function renderValue(value: unknown): Html {
  if (typeof value === 'string') {
    return html`${value
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((paragraph) => html`<p>${paragraph}</p>`)}`;
  }

  if (Array.isArray(value)) {
    return html`<ul>
      ${value.map(
        (item) =>
          html`<li>${typeof item === 'string' ? item : raw(escapeForPre(JSON.stringify(item)))}</li>`,
      )}
    </ul>`;
  }

  if (value && typeof value === 'object') {
    return html`<dl>
      ${Object.entries(value as Record<string, unknown>).map(
        ([key, inner]) => html`<dt>${key.replace(/[_-]/g, ' ')}</dt>
          <dd>${typeof inner === 'string' ? inner : raw(escapeForPre(JSON.stringify(inner)))}</dd>`,
      )}
    </dl>`;
  }

  return html`<p>${String(value ?? '')}</p>`;
}

/** JSON dropped into markup still has to be escaped. */
function escapeForPre(json: string): string {
  return json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/* =========================================================================
 * Sites
 * ====================================================================== */

export function sitesPage(sites: SiteRow[], views: SiteView[]): Html {
  return html`
    <h1>Sites</h1>
    <p class="subtitle">
      Daily counts and last-publish times are computed from the run history, not stored, so
      they can never drift out of step with reality.
    </p>

    <div class="card table-wrap">
      ${sites.length === 0
        ? emptyState('No sites yet. Add your first one below.')
        : html`<table>
            <thead>
              <tr>
                <th>Name</th><th>Domain</th><th>Status</th><th>Publishing</th><th>Target</th>
                <th>Interval</th><th>Credentials</th><th>Today</th><th>Last publish</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${sites.map((s) => {
                const v = views.find((x) => x.id === s.id);
                return html`<tr>
                  <td>${s.name}</td>
                  <td class="mono">${s.domain}</td>
                  <td>
                    ${statusBadge(s.status)}
                    ${s.status === 'paused' && s.paused_reason
                      ? html`<div class="muted small">${s.paused_reason}</div>`
                      : raw('')}
                    ${s.status === 'paused' && s.paused_until
                      ? html`<div class="muted small">resumes ${timeAgo(s.paused_until)}</div>`
                      : raw('')}
                  </td>
                  <td>
                    ${s.auto_publish === 0
                      ? html`<span class="badge warn">needs approval</span>`
                      : html`<span class="badge muted">automatic</span>`}
                  </td>
                  <td>${s.daily_target}</td>
                  <td class="nowrap">${formatMinutes(s.interval_minutes)}</td>
                  <td class="nowrap small">
                    ${hasSecret(s.api_token_encrypted)
                      ? html`<span class="badge ok">API</span>`
                      : html`<span class="badge error">API</span>`}
                    ${hasSecret(s.buffer_token_encrypted)
                      ? html`<span class="badge ok">Buffer</span>`
                      : html`<span class="badge muted">Buffer</span>`}
                  </td>
                  <td>${v?.publishedToday ?? 0}</td>
                  <td class="nowrap muted">${timeAgo(v?.lastPublishAt ?? null)}</td>
                  <td class="nowrap"><a class="button small" href="/sites/${s.id}">Edit</a></td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </div>

    <h2>Add a site</h2>
    <div class="card">${siteForm(null)}</div>
  `;
}

/**
 * An ISO timestamp as <input type="datetime-local"> wants it.
 *
 * That control speaks local wall-clock time with no zone, so the stored UTC
 * instant is shifted into the browser's day before it is shown. Round-tripping
 * it back is the server's job — see readPausedUntil.
 */
function forDatetimeInput(iso: string | null): string {
  if (!iso) return '';

  const at = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(at.getTime())) return '';

  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

export function siteEditPage(site: SiteRow): Html {
  return html`
    <div class="spread">
      <div>
        <h1>${site.domain}</h1>
        <p class="subtitle">Edit site configuration.</p>
      </div>
      ${site.status === 'active'
        ? html`<form method="post" action="/sites/${site.id}/pause" class="row wrap">
            <input type="text" name="reason" placeholder="why?" style="width:auto" required />
            <select name="hours" style="width:auto">
              <option value="4">4 hours</option>
              <option value="24" selected>a day</option>
              <option value="72">3 days</option>
              <option value="168">a week</option>
              <option value="0">until I say</option>
            </select>
            <button type="submit">Pause</button>
          </form>`
        : html`<form method="post" action="/sites/${site.id}/activate">
            <button class="primary" type="submit">Resume publishing</button>
          </form>`}
    </div>

    ${site.status === 'paused' && site.paused_reason
      ? html`<div class="flash warn">
          Paused: ${site.paused_reason}
          ${site.paused_until
            ? html` &mdash; resuming by itself ${timeAgo(site.paused_until)}.`
            : html` &mdash; no end set, so it stays paused until you resume it.`}
        </div>`
      : raw('')}

    <div class="card">${siteForm(site)}</div>
    <div class="card">
      <h3>Delete this site</h3>
      <p class="muted small">
        Removes the site and its keyword links. Run history is preserved but detached.
      </p>
      <form method="post" action="/sites/${site.id}/delete"
            onsubmit="return confirm('Delete ${site.domain}? This cannot be undone.')">
        <button class="danger" type="submit">Delete site</button>
      </form>
    </div>
  `;
}

function siteForm(site: SiteRow | null): Html {
  const action = site ? `/sites/${site.id}` : '/sites';

  // Show the interval in the largest unit that divides evenly, so 1440
  // minutes comes back as "1 day" rather than "1440 minutes".
  const minutes = site?.interval_minutes ?? 480;
  const [amount, unit] =
    minutes % 1440 === 0 && minutes >= 1440
      ? [minutes / 1440, 'days']
      : minutes % 60 === 0 && minutes >= 60
        ? [minutes / 60, 'hours']
        : [minutes, 'minutes'];

  const secretField = (
    name: string,
    label: string,
    stored: string,
    help: string,
  ): Html => html`
    <div class="field">
      <label>${label}</label>
      <input type="password" name="${name}" autocomplete="new-password"
             placeholder="${hasSecret(stored) ? 'saved — leave blank to keep' : 'not set'}" />
      <div class="help">
        ${help}
        ${hasSecret(stored)
          ? html`<span class="badge ok" style="margin-left:6px">saved</span>`
          : html`<span class="badge muted" style="margin-left:6px">missing</span>`}
      </div>
    </div>
  `;

  return html`
    <form method="post" action="${action}">
      <div class="field-row">
        <div class="field">
          <label>Name</label>
          <input type="text" name="name" required value="${site?.name ?? ''}" />
          <div class="help">Short label, e.g. bitespoon</div>
        </div>
        <div class="field">
          <label>Domain</label>
          <input type="text" name="domain" required value="${site?.domain ?? ''}"
                 placeholder="example.com" />
          <div class="help">Without https://. Renaming keeps this site's history.</div>
        </div>
        <div class="field">
          <label>Status</label>
          <select name="status">
            <option value="active" ${site?.status === 'active' ? raw('selected') : raw('')}>active</option>
            <option value="paused" ${site?.status !== 'active' ? raw('selected') : raw('')}>paused</option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Why it is paused</label>
          <input type="text" name="paused_reason" value="${site?.paused_reason ?? ''}"
                 placeholder="e.g. their API is down" />
          <div class="help">
            Only used while paused, and cleared when you set it active again. A pause with no
            note is one nobody dares undo a fortnight later.
          </div>
        </div>
        <div class="field">
          <label>Un-pause automatically</label>
          <input type="datetime-local" name="paused_until"
                 value="${forDatetimeInput(site?.paused_until ?? null)}" />
          <div class="help">Leave blank to stay paused until you say otherwise.</div>
        </div>
        <div class="field">
          <label>Publishing</label>
          <select name="auto_publish">
            <option value="1" ${site?.auto_publish !== 0 ? raw('selected') : raw('')}>
              publish automatically
            </option>
            <option value="0" ${site?.auto_publish === 0 ? raw('selected') : raw('')}>
              hold every article for approval
            </option>
          </select>
          <div class="help">
            Holding stops the run after the article is written. Nothing reaches the site until
            you read it and approve.
          </div>
        </div>
      </div>

      <h3>Publishing schedule</h3>
      <div class="field-row">
        <div class="field">
          <label>Daily target</label>
          <input type="number" name="daily_target" min="0" value="${site?.daily_target ?? 3}" />
          <div class="help">Articles per day. 0 means never publish.</div>
        </div>
        <div class="field">
          <label>Minimum gap between posts</label>
          <div class="row" style="flex-wrap:nowrap">
            <input type="number" name="interval_amount" min="0" step="1" value="${amount}"
                   style="flex:1" />
            <select name="interval_unit" style="width:auto">
              <option value="minutes" ${unit === 'minutes' ? raw('selected') : raw('')}>minutes</option>
              <option value="hours" ${unit === 'hours' ? raw('selected') : raw('')}>hours</option>
              <option value="days" ${unit === 'days' ? raw('selected') : raw('')}>days</option>
            </select>
          </div>
          <div class="help">Any cadence: 20 minutes, 90 minutes, 3 days.</div>
        </div>
      </div>

      <h3>Credentials for this site</h3>
      <div class="field-row">
        ${secretField(
          'api_token',
          'Site API token',
          site?.api_token_encrypted ?? '',
          'Bearer token for the /api/recipe, /api/upload and /api/categories endpoints on this domain.',
        )}
        ${secretField(
          'buffer_token',
          'Buffer API token',
          site?.buffer_token_encrypted ?? '',
          'The Buffer account belonging to this site. Its channel is resolved automatically.',
        )}
      </div>
      <div class="field-row">
        <div class="field">
          <label>Pinterest username</label>
          <input type="text" name="pin_username" value="${site?.pin_username ?? ''}" />
          <div class="help">Used to pick the right Buffer channel when there is more than one.</div>
        </div>
        <div class="field">
          <label>Project ID</label>
          <input type="text" name="project_id" value="${site?.project_id ?? ''}" />
        </div>
      </div>

      <button class="primary" type="submit">${site ? 'Save changes' : 'Add site'}</button>
    </form>
  `;
}

/* =========================================================================
 * Keywords
 * ====================================================================== */

export interface KeywordFilterView {
  q: string;
  status: string;
  siteId: number;
  linkStatus: string;
}

/** A <select> of go / done / no, with an explicit "no change" first option. */
function tristate(id: string, name: string, current: string, blank: string): Html {
  return html`
    <select id="${id}" name="${name}">
      <option value="">${blank}</option>
      ${(['go', 'done', 'no'] as const).map(
        (v) => html`<option value="${v}" ${current === v ? raw('selected') : raw('')}>${v}</option>`,
      )}
    </select>
  `;
}

export function keywordsPage(
  keywords: KeywordRow[],
  sites: SiteRow[],
  links: Map<string, { status: string; shareImages: boolean }>,
  page: number,
  total: number,
  matched: number,
  filter: KeywordFilterView,
): Html {
  const pages = Math.max(1, Math.ceil(matched / 100));
  const filtered = filter.q !== '' || filter.status !== '' || filter.siteId !== 0;

  // Carried through the bulk form so applying an edit returns you to the same
  // filtered view rather than dumping you back at page one of everything.
  const back = `/keywords${pageLink(filter, page)}`;

  return html`
    <h1>Keywords</h1>
    <p class="subtitle">
      ${total} keyword(s). Each cell decides whether that keyword may run on that site.
      Tick rows to edit many of them at once.
    </p>

    <form method="get" action="/keywords" class="toolbar">
      <div class="field">
        <label for="q">Search</label>
        <input type="search" id="q" name="q" value="${filter.q}"
               placeholder="keyword or spy title" />
      </div>
      <div class="field">
        <label for="status">Keyword status</label>
        ${tristate('status', 'status', filter.status, 'any')}
      </div>
      <div class="field">
        <label for="site">On site</label>
        <select id="site" name="site">
          <option value="">any site</option>
          ${sites.map(
            (s) =>
              html`<option value="${s.id}" ${filter.siteId === s.id ? raw('selected') : raw('')}>${s.domain}</option>`,
          )}
        </select>
      </div>
      <div class="field">
        <label for="link">Where it stands there</label>
        <select id="link" name="link">
          <option value="">linked, any status</option>
          <option value="go" ${filter.linkStatus === 'go' ? raw('selected') : raw('')}>go</option>
          <option value="done" ${filter.linkStatus === 'done' ? raw('selected') : raw('')}>done</option>
          <option value="no" ${filter.linkStatus === 'no' ? raw('selected') : raw('')}>no</option>
          <option value="none" ${filter.linkStatus === 'none' ? raw('selected') : raw('')}>not linked at all</option>
        </select>
      </div>
      <button class="primary" type="submit">Filter</button>
      ${filtered ? html`<a class="button" href="/keywords">Clear</a>` : raw('')}
    </form>

    ${filtered
      ? html`<p class="muted small" style="margin-top:-4px">
          ${matched} of ${total} keyword(s) match.
        </p>`
      : raw('')}

    <form method="post" action="/keywords/bulk" id="bulk" class="bulkbar">
      <input type="hidden" name="back" value="${back}" />
      <span><span class="count" id="pick-count">0</span> selected</span>

      <label for="bulk-status" style="margin:0">Status</label>
      ${tristate('bulk-status', 'keyword_status', '', 'leave as is')}

      <label for="bulk-site" style="margin:0">On</label>
      <select id="bulk-site" name="site_id">
        <option value="">all sites</option>
        ${sites.map((s) => html`<option value="${s.id}">${s.domain}</option>`)}
      </select>

      <label for="bulk-link" style="margin:0">set to</label>
      ${tristate('bulk-link', 'link_status', '', 'leave as is')}

      <label for="bulk-share" style="margin:0">Share images</label>
      <select id="bulk-share" name="share">
        <option value="">leave as is</option>
        <option value="1">on</option>
        <option value="0">off</option>
      </select>

      <button class="primary" type="submit" name="action" value="apply">Apply</button>
      <button class="danger" type="submit" name="action" value="delete" formnovalidate
              onclick="return confirm('Delete every ticked keyword? This cannot be undone.')">
        Delete
      </button>
    </form>

    <div class="card table-wrap">
      ${keywords.length === 0
        ? emptyState(
            filtered
              ? 'No keyword matches this filter.'
              : 'No keywords yet. Import a CSV below to get started.',
          )
        : html`<table class="matrix">
            <thead>
              <tr>
                <th class="pick">
                  <input type="checkbox" id="pick-all" title="Select every row on this page" />
                </th>
                <th>Keyword</th><th>Status</th>
                ${sites.map((s) => html`<th title="${s.domain}">${s.name}</th>`)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${keywords.map(
                (k) => html`<tr>
                  <td class="pick">
                    <input type="checkbox" form="bulk" name="ids" value="${k.id}" />
                  </td>
                  <td>
                    <a href="/keywords/${k.id}"><strong>${k.seed_keyword}</strong></a>
                    <div class="muted small">${(k.spy_title || '').slice(0, 70)}</div>
                  </td>
                  <td>
                    <form method="post" action="/keywords/${k.id}/status" class="row">
                      <select name="status" onchange="this.form.submit()">
                        ${(['go', 'done', 'no'] as const).map(
                          (v) =>
                            html`<option value="${v}" ${k.status === v ? raw('selected') : raw('')}>${v}</option>`,
                        )}
                      </select>
                    </form>
                  </td>
                  ${sites.map((s) => {
                    const cell = links.get(`${k.id}:${s.id}`);
                    const current = cell?.status ?? 'no';
                    // A pair with no row yet inherits the column default.
                    const shared = cell?.shareImages ?? true;
                    return html`<td>
                      <form method="post" action="/keywords/${k.id}/link">
                        <input type="hidden" name="site_id" value="${s.id}" />
                        <select name="status" onchange="this.form.submit()">
                          ${(['go', 'done', 'no'] as const).map(
                            (v) =>
                              html`<option value="${v}" ${current === v ? raw('selected') : raw('')}>${v}</option>`,
                          )}
                        </select>
                        <label class="muted small"
                               title="Reuse this keyword's article images here instead of generating new ones. The Pinterest graphic is always generated fresh.">
                          <input type="checkbox" name="share_images" value="1"
                                 ${shared ? raw('checked') : raw('')}
                                 onchange="this.form.submit()" />
                          share
                        </label>
                      </form>
                    </td>`;
                  })}
                  <td>
                    <form method="post" action="/keywords/${k.id}/delete"
                          onsubmit="return confirm('Delete this keyword?')">
                      <button class="small danger" type="submit">&times;</button>
                    </form>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>

    ${pages > 1
      ? html`<div class="row">
          ${page > 1
            ? html`<a class="button small" href="/keywords${pageLink(filter, page - 1)}">Previous</a>`
            : raw('')}
          <span class="muted small">Page ${page} of ${pages}</span>
          ${page < pages
            ? html`<a class="button small" href="/keywords${pageLink(filter, page + 1)}">Next</a>`
            : raw('')}
        </div>`
      : raw('')}

    <h2>Add from a page URL</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">
        Paste the address of an article worth competing with. The page's own title,
        description and image are read and turned into a keyword you can check before it is
        saved &mdash; nothing is written until you confirm on the next screen.
      </p>
      <form method="post" action="/keywords/from-url">
        <div class="field">
          <label for="urls">One URL per line</label>
          <textarea id="urls" name="urls" rows="4" required
                    placeholder="https://example.com/best-baked-chicken"></textarea>
          <div class="help">Up to 20 at a time. Only http and https, and no private addresses.</div>
        </div>
        <button class="primary" type="submit">Read these pages</button>
      </form>
    </div>

    <h2>Import from CSV</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">
        Columns: <span class="mono">seed_keyword, spy_title, spy_description, annotation,
        status</span>, then one column per site domain holding go / done / no. Only
        <span class="mono">seed_keyword</span> is required, and a keyword may be set to
        <span class="mono">go</span> on as many sites as you like. Those sites reuse one set
        of article images by default &mdash; untick <span class="mono">share</span> on a cell
        to generate fresh ones there. Pinterest graphics are always generated per site.
      </p>
      <form method="post" action="/keywords/import" enctype="multipart/form-data">
        <div class="field"><input type="file" name="file" accept=".csv,text/csv" required /></div>
        <div class="row wrap">
          <button class="primary" type="submit">Import CSV</button>
          <a class="button" href="/keywords/template.csv" download>Download template</a>
          <a class="button" href="/data/export/keywords" download>Export what is here</a>
        </div>
        <div class="help" style="margin-top:8px">
          The template already has a column for every site you have added. An export uses the
          same columns, so it can be edited in a spreadsheet and imported straight back.
        </div>
      </form>
    </div>

    ${raw(BULK_SELECTION_SCRIPT)}
  `;
}

function pageLink(filter: KeywordFilterView, page: number): string {
  const params = new URLSearchParams();
  if (filter.q) params.set('q', filter.q);
  if (filter.status) params.set('status', filter.status);
  if (filter.siteId) params.set('site', String(filter.siteId));
  if (filter.linkStatus) params.set('link', filter.linkStatus);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Row selection, in the smallest amount of script that does the job.
 *
 * The checkboxes sit in the table but belong to the bulk form above it, via
 * the HTML `form` attribute: a form inside a form is invalid, and every cell
 * of the matrix is already its own form. This script only keeps the counter
 * and the select-all box honest — submitting works with scripting off.
 */
const BULK_SELECTION_SCRIPT = `<script>
(function () {
  var form = document.getElementById('bulk');
  if (!form) return;

  var boxes = Array.prototype.slice.call(document.querySelectorAll('input[name="ids"]'));
  var all = document.getElementById('pick-all');
  var count = document.getElementById('pick-count');

  function sync() {
    var picked = 0;
    boxes.forEach(function (box) {
      if (box.checked) picked++;
      var row = box.closest('tr');
      if (row) row.classList.toggle('picked', box.checked);
    });
    if (count) count.textContent = String(picked);
    if (all) {
      all.checked = picked > 0 && picked === boxes.length;
      all.indeterminate = picked > 0 && picked < boxes.length;
    }
  }

  if (all) {
    all.addEventListener('change', function () {
      boxes.forEach(function (box) { box.checked = all.checked; });
      sync();
    });
  }
  boxes.forEach(function (box) { box.addEventListener('change', sync); });
  sync();
})();
</script>`;

/* =========================================================================
 * Settings
 * ====================================================================== */

export function settingsPage(
  specs: SettingSpec[],
  values: Map<string, string>,
  problems: string[],
): Html {
  const groups: { key: SettingSpec['group']; title: string; blurb?: string }[] = [
    { key: 'general', title: 'General' },
    { key: 'schedule', title: 'Schedule' },
    { key: 'retry', title: 'Retries' },
    { key: 'llm', title: 'LLM' },
    { key: 'images', title: 'Image generation' },
    { key: 'buffer', title: 'Buffer' },
    { key: 'telegram', title: 'Telegram' },
  ];

  return html`
    <h1>Settings</h1>
    <p class="subtitle">
      Everything the platform needs, in one form. Nothing here is edited by hand
      on the server.
    </p>

    <div class="row wrap" style="margin-bottom:16px">
      <a class="button" href="/settings/keys">LLM API keys</a>
      <a class="button" href="/settings/prompts">Prompts &amp; models</a>
      <a class="button" href="/settings/usage">Usage</a>
      <a class="button" href="/settings/account">Change password</a>
      <a class="button" href="/settings/data">History &amp; storage</a>
    </div>

    ${problems.length
      ? html`<div class="flash warn">
          <strong>Not ready to run</strong>
          <ul>${problems.map((p) => html`<li>${p}</li>`)}</ul>
        </div>`
      : html`<div class="flash ok">Configuration is complete.</div>`}

    <form method="post" action="/settings">
      ${groups.map((group) => {
        const fields = specs.filter((s) => s.group === group.key);
        if (fields.length === 0) return raw('');
        return html`
          <h2>${group.title}</h2>
          <div class="card">
            ${fields.map((spec) => settingField(spec, values.get(spec.key) ?? ''))}
          </div>
        `;
      })}

      <!-- Last thing on the page, deliberately: nothing should sit below the
           button that saves the form above it. -->
      <div class="save-bar">
        <button class="primary" type="submit">Save settings</button>
        <span class="muted small">Applies immediately. No restart.</span>
      </div>
    </form>

    <h2>Set where the app is deployed</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">
        These are read once when the image service container starts, so they are
        not on this page &mdash; editing them here would look like it worked and
        change nothing. Set them in your deployment's environment variables and
        redeploy.
      </p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>What it does</th></tr></thead>
        <tbody>
          <tr>
            <td class="mono small nowrap">IMAGE_API_KEY</td>
            <td class="mono small">generated</td>
            <td class="small">
              The shared secret between the two containers. The field above must
              match it &mdash; saving checks that it does.
            </td>
          </tr>
          <tr>
            <td class="mono small nowrap">MAX_CONCURRENT_REQUESTS</td>
            <td class="mono small">2</td>
            <td class="small">Images generated at once. Google's own ceiling is 5.</td>
          </tr>
          <tr>
            <td class="mono small nowrap">API_COOLDOWN</td>
            <td class="mono small">10</td>
            <td class="small">Seconds between calls to Google. Raise it if you see rate limits.</td>
          </tr>
          <tr>
            <td class="mono small nowrap">MAX_RETRIES</td>
            <td class="mono small">5</td>
            <td class="small">Attempts before an image job is given up on.</td>
          </tr>
          <tr>
            <td class="mono small nowrap">WATCHDOG_DISCONNECT_GRACE</td>
            <td class="mono small">120</td>
            <td class="small">
              Seconds the browser may stay disconnected before Chrome is restarted.
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted small" style="margin-bottom:0">
        Everything else in the image service is either wiring inside the container
        (ports, paths) or part of the request shape Google sees, which is
        deliberately not configurable.
      </p>
    </div>
  `;
}

export function keysPage(endpoints: Endpoint[], baseUrl: string): Html {
  return html`
    <h1>LLM API keys</h1>
    <p class="subtitle">
      Every key here talks to the same provider — <span class="mono">${baseUrl}</span>,
      set under Settings &rarr; LLM. Keys exist to spread that provider's rate
      limit, not to pick models. Requests go to the least recently used healthy
      key; on a 429 the same request is retried on the next one, so a throttled
      key never breaks a run.
    </p>

    <div class="card table-wrap">
      ${endpoints.length === 0
        ? emptyState('No API keys yet. Nothing can be generated until you add at least one.')
        : html`<table>
            <thead>
              <tr><th>Name</th><th>Health</th><th>Last success</th><th>Last error</th><th></th></tr>
            </thead>
            <tbody>
              ${endpoints.map(
                (e) => html`<tr>
                  <td>
                    <strong>${e.name}</strong>
                    ${e.enabled ? raw('') : html` <span class="badge muted">disabled</span>`}
                    ${e.models.length
                      ? html`<div class="muted small">only: ${e.models.join(', ')}</div>`
                      : raw('')}
                  </td>
                  <td>
                    ${e.healthy
                      ? html`<span class="badge ok">healthy</span>`
                      : html`<span class="badge error">unhealthy</span>`}
                    ${e.consecutiveFails > 0
                      ? html`<div class="muted small">${e.consecutiveFails} consecutive failure(s)</div>`
                      : raw('')}
                    ${e.cooldownUntil && e.cooldownUntil > new Date()
                      ? html`<div class="muted small">cooling down</div>`
                      : raw('')}
                  </td>
                  <td class="muted small nowrap">${timeAgo(e.lastSuccessAt)}</td>
                  <td class="muted small">${e.lastError ? e.lastError.slice(0, 80) : '—'}</td>
                  <td class="nowrap">
                    <form method="post" action="/settings/endpoints/${e.id}/reset" style="display:inline">
                      <button class="small" type="submit">Reset</button>
                    </form>
                    <form method="post" action="/settings/endpoints/${e.id}/delete" style="display:inline"
                          onsubmit="return confirm('Delete key ${e.name}?')">
                      <button class="small danger" type="submit">&times;</button>
                    </form>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>

    <h2>Add several at once</h2>
    <div class="card">
      <form method="post" action="/settings/endpoints/bulk">
        <div class="field">
          <label for="keys">One key per line</label>
          <textarea id="keys" name="keys" rows="8" required
                    placeholder="paste keys here, one per line"></textarea>
          <div class="help">
            Names are generated for you &mdash; <span class="mono">key-01</span>,
            <span class="mono">key-02</span> and so on, continuing from what is
            already here. To name one yourself, write
            <span class="mono">label = key</span> or
            <span class="mono">label, key</span> on that line. Blank lines and
            lines starting with <span class="mono">#</span> are ignored, and a key
            already stored is skipped rather than duplicated.
          </div>
        </div>
        <button class="primary" type="submit">Add keys</button>
      </form>
    </div>

    <h2>Add one</h2>
    <div class="card">
      <form method="post" action="/settings/endpoints">
        <div class="field-row">
          <div class="field">
            <label>Label</label>
            <input type="text" name="name" required placeholder="key-01" />
            <div class="help">Any name. Reusing one replaces that key.</div>
          </div>
          <div class="field">
            <label>API key</label>
            <input type="password" name="api_key" required autocomplete="new-password"
                   placeholder="paste the key" />
            <div class="help">Stored encrypted. Never displayed again.</div>
          </div>
        </div>
        <details>
          <summary class="muted small">Advanced</summary>
          <div class="field-row" style="margin-top:10px">
            <div class="field">
              <label>Restrict to models</label>
              <input type="text" name="models" placeholder="leave blank for all models" />
              <div class="help">Comma separated. Normally blank &mdash; any key can serve any model.</div>
            </div>
            <div class="field">
              <label>Override base URL</label>
              <input type="text" name="base_url" placeholder="leave blank to use the shared URL" />
              <div class="help">Only for mixing in a self-hosted instance.</div>
            </div>
          </div>
        </details>
        <button class="primary" type="submit">Add key</button>
      </form>
    </div>
  `;
}

export function accountPage(usingGenerated: boolean): Html {
  return html`
    <h1>Password</h1>
    <p class="subtitle">
      One password protects the whole platform: every site token, every API key,
      and a browser signed in to Google.
    </p>

    ${usingGenerated
      ? html`<div class="flash warn">
          You are still on the password generated at first boot. It is printed in
          the container logs on every start, so anyone who can read those can sign
          in. Set your own below.
        </div>`
      : html`<div class="flash ok">A chosen password is in use.</div>`}

    <div class="card" style="max-width:520px">
      <form method="post" action="/settings/account">
        <div class="field">
          <label for="current">Current password</label>
          <input type="password" id="current" name="current" required
                 autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="next">New password</label>
          <input type="password" id="next" name="next" required minlength="10"
                 autocomplete="new-password" />
          <div class="help">At least 10 characters.</div>
        </div>
        <div class="field">
          <label for="confirm">New password again</label>
          <input type="password" id="confirm" name="confirm" required minlength="10"
                 autocomplete="new-password" />
        </div>
        <button class="primary" type="submit">Change password</button>
      </form>
    </div>

    <p class="muted small" style="margin-top:14px">
      Once set, the generated password stops working. Forgotten it? Set
      <span class="mono">AUTH_PASSWORD</span> in the deployment environment and
      restart — that takes over again until you choose a new one here.
    </p>
  `;
}

function settingField(spec: SettingSpec, value: string): Html {
  const isBool = spec.default === 'true' || spec.default === 'false';

  if (isBool) {
    return html`<div class="field">
      <label>${spec.label}</label>
      <select name="${spec.key}">
        <option value="true" ${value === 'true' ? raw('selected') : raw('')}>enabled</option>
        <option value="false" ${value !== 'true' ? raw('selected') : raw('')}>disabled</option>
      </select>
      ${spec.help ? html`<div class="help">${spec.help}</div>` : raw('')}
    </div>`;
  }

  const type = spec.type === 'number' ? 'number' : spec.secret ? 'password' : 'text';
  const placeholder = spec.secret && value ? 'saved — leave blank to keep' : spec.default;

  return html`<div class="field">
    <label>${spec.label}</label>
    <input type="${type}" name="${spec.key}" placeholder="${placeholder}"
           value="${spec.secret ? '' : value}" />
    ${spec.help ? html`<div class="help">${spec.help}</div>` : raw('')}
  </div>`;
}

/* =========================================================================
 * Events
 * ====================================================================== */

export function eventsPage(events: EventRow[]): Html {
  return html`
    <h1>Event log</h1>
    <p class="subtitle">Technical errors and scheduler activity.</p>
    <div class="card table-wrap">
      ${events.length === 0
        ? emptyState('Nothing logged yet.')
        : html`<table>
            <thead><tr><th>When</th><th>Level</th><th>Source</th><th>Message</th></tr></thead>
            <tbody>
              ${events.map(
                (e) => html`<tr>
                  <td class="nowrap muted small">${timeAgo(e.created_at)}</td>
                  <td>${statusBadge(e.level === 'error' ? 'failed' : e.level === 'warn' ? 'pending' : 'ok')}</td>
                  <td class="muted small">${e.source}</td>
                  <td class="small">${e.message}</td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>
  `;
}

/* =========================================================================
 * Prompts
 * ====================================================================== */

export interface PromptSummary {
  /** File name, e.g. "part-1.user.txt". */
  file: string;
  /** Prompt it belongs to, e.g. "part-1". */
  prompt: string;
  /** "system", "user", or "template". */
  half: string;
  model: string;
  edited: boolean;
  lines: number;
}

export interface ModelChoice {
  prompt: string;
  shipped: string;
  effective: string;
  overridden: boolean;
}

export function promptsPage(
  prompts: PromptSummary[],
  models: ModelChoice[],
  knownModels: string[],
): Html {
  const byPrompt = new Map<string, PromptSummary[]>();
  for (const p of prompts) {
    const list = byPrompt.get(p.prompt) ?? [];
    list.push(p);
    byPrompt.set(p.prompt, list);
  }

  const editedCount = prompts.filter((p) => p.edited).length;

  return html`
    <h1>Prompts</h1>
    <p class="subtitle">
      These are the product. Article quality lives here, not in the code that
      sends them. Every edit is stored in the database, so it survives a
      redeploy &mdash; the shipped text stays underneath as the version you can
      always revert to, and the last ${PROMPT_VERSIONS_KEPT} saves of each are
      kept so you can go back to this morning rather than all the way.
    </p>
    <p class="subtitle">
      The model each prompt is sent to is set here too. It has nothing to do
      with API keys: any key can serve any model, keys spread a rate limit, and
      this decides quality.
    </p>

    ${editedCount > 0
      ? html`<div class="flash ok">
          ${editedCount} prompt file(s) edited. The rest are exactly as shipped.
        </div>`
      : raw('')}

    <datalist id="known-models">
      ${knownModels.map((m) => html`<option value="${m}"></option>`)}
    </datalist>

    ${[...byPrompt.entries()].map(([name, parts]) => {
      const choice = models.find((m) => m.prompt === name);
      return html`
        <div class="card">
          <div class="spread">
            <div>
              <strong>${name}</strong>
              ${parts.some((p) => p.edited)
                ? html` <span class="badge ok">edited</span>`
                : raw('')}
              ${choice?.overridden ? html` <span class="badge brand">custom model</span>` : raw('')}
            </div>
            <div class="row wrap">
              ${parts.map(
                (p) => html`<a class="button small" href="/settings/prompts/${p.file}"
                  >${p.half} &middot; ${p.lines} lines</a
                >`,
              )}
            </div>
          </div>

          ${choice
            ? html`<form method="post" action="/settings/prompts/model" class="row wrap"
                    style="margin-top:10px">
                  <input type="hidden" name="prompt" value="${name}" />
                  <label for="model-${name}" class="muted small" style="margin:0">Model</label>
                  <input type="text" id="model-${name}" name="model" list="known-models"
                         value="${choice.overridden ? choice.effective : ''}"
                         placeholder="${choice.shipped}" style="width:auto;min-width:200px" />
                  <button class="small" type="submit">Set</button>
                  ${choice.overridden
                    ? html`<span class="muted small">
                        shipped default is <span class="mono">${choice.shipped}</span> &mdash;
                        clear the box and press Set to go back to it
                      </span>`
                    : raw('')}
                </form>`
            : raw('')}
        </div>
      `;
    })}
  `;
}

/** Mirrors PROMPT_VERSION_LIMIT in repos.ts, for the copy above. */
export const PROMPT_VERSIONS_KEPT = 20;

export function promptEditPage(
  file: string,
  body: string,
  options: {
    model: string;
    variables: string[];
    unknown: string[];
    edited: boolean;
    shipped: string;
    versions: { id: number; created_at: string; body: string }[];
  },
): Html {
  return html`
    <div class="spread">
      <div>
        <h1>${file}</h1>
        <p class="subtitle">
          ${options.model ? html`Sent to <span class="mono">${options.model}</span>. ` : raw('')}
          ${options.edited
            ? 'Edited — the shipped version is still available below.'
            : 'Exactly as shipped.'}
        </p>
      </div>
      <a class="button" href="/settings/prompts">All prompts</a>
    </div>

    ${options.unknown.length
      ? html`<div class="flash warn">
          <strong>Unknown placeholder(s):</strong>
          <span class="mono">${options.unknown.join(', ')}</span>
          <div class="small" style="margin-top:6px">
            Nothing supplies these, so they render as empty text rather than
            failing &mdash; the article just quietly comes out worse. Use one of
            the variables listed below, or add it to the step that renders this
            prompt.
          </div>
        </div>`
      : raw('')}

    <div class="card">
      <form method="post" action="/settings/prompts/${file}">
        <div class="field">
          <textarea name="body" rows="24" spellcheck="false"
                    class="mono" style="width:100%">${body}</textarea>
        </div>
        <div class="row">
          <button class="primary" type="submit">Save</button>
          ${options.edited
            ? html`<button class="danger" type="submit" name="action" value="revert"
                     formnovalidate
                     onclick="return confirm('Discard your edit and restore the shipped prompt?')">
                Revert to shipped
              </button>`
            : raw('')}
        </div>
      </form>
    </div>

    <h2>Variables you can use</h2>
    <div class="card">
      ${options.variables.length === 0
        ? html`<p class="muted small">
            No variable list is defined for this file, so placeholders are not checked here.
          </p>`
        : html`<p class="muted small">
              Write them as <span class="mono">{{name}}</span>. Nothing else is
              interpreted &mdash; no expressions, no conditionals.
            </p>
            <div class="row wrap">
              ${options.variables.map((v) => html`<span class="badge muted mono">${v}</span>`)}
            </div>`}
    </div>

    ${options.versions.length
      ? html`<h2>Earlier versions</h2>
          <p class="subtitle">
            Every save is kept, newest first, up to ${PROMPT_VERSIONS_KEPT}. Restoring one puts
            its text in the editor as a new save &mdash; nothing is lost by trying.
          </p>
          ${options.versions.map(
            (version) => html`
              <div class="card">
                <div class="spread">
                  <div>
                    <strong>Saved ${timeAgo(version.created_at)}</strong>
                    <div class="muted small">
                      ${version.body.split('\n').length} lines, ${version.body.length} characters
                      ${version.body === body ? html` &middot; this is what is live now` : raw('')}
                    </div>
                  </div>
                  <div class="row">
                    <form method="post" action="/settings/prompts/${file}/restore">
                      <input type="hidden" name="version" value="${version.id}" />
                      <button class="small" type="submit"
                              ${version.body === body ? raw('disabled') : raw('')}>
                        Restore
                      </button>
                    </form>
                  </div>
                </div>
                <details>
                  <summary class="muted small">What changed from what is live</summary>
                  ${diffBlock(version.body, body)}
                </details>
              </div>
            `,
          )}`
      : raw('')}

    ${options.edited
      ? html`<h2>As shipped</h2>
          <div class="card">
            <pre class="mono small" style="white-space:pre-wrap;margin:0">${options.shipped}</pre>
          </div>`
      : raw('')}
  `;
}

/**
 * A line-level diff, shown as removed-then-added blocks.
 *
 * Not a real diff algorithm — the useful question here is "which lines are in
 * one and not the other", and for prompt text that is a set comparison. A
 * proper LCS diff would be a dependency and several hundred lines for a
 * marginally nicer rendering of a page that is read rarely.
 */
function diffBlock(older: string, newer: string): Html {
  const oldLines = older.split('\n');
  const newLines = newer.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const removed = oldLines.filter((line) => line.trim() && !newSet.has(line));
  const added = newLines.filter((line) => line.trim() && !oldSet.has(line));

  if (removed.length === 0 && added.length === 0) {
    return html`<p class="muted small">Identical to what is live.</p>`;
  }

  return html`<div class="diff">
    ${removed.map((line) => html`<div class="del">- ${line}</div>`)}
    ${added.map((line) => html`<div class="add">+ ${line}</div>`)}
  </div>`;
}

/* =========================================================================
 * History and storage
 * ====================================================================== */

/**
 * The tables that grow forever, with a way to take them away.
 *
 * Everything on this page is history: runs, the steps under them, the
 * scheduler's reasoning, the event log. None of it is derived state, so
 * deleting any of it changes nothing about what the platform will do next —
 * which is exactly why the export sits beside the delete rather than behind
 * a separate page. Take the copy, then clear.
 */
export function dataPage(counts: DataCounts, retentionDays: number): Html {
  const clearCard = (
    what: 'runs' | 'decisions' | 'events',
    title: string,
    rows: number,
    blurb: Html,
    exportName: string,
  ): Html => html`
    <div class="card">
      <div class="spread">
        <div>
          <h3 style="margin-bottom:4px">${title}</h3>
          <div class="muted small">${rows} row(s) stored</div>
        </div>
        <a class="button small" href="/data/export/${exportName}" download>Export CSV</a>
      </div>
      <p class="muted small">${blurb}</p>
      <form method="post" action="/data/clear" class="row wrap"
            onsubmit="return confirm('Delete this history? The export is the only copy.')">
        <input type="hidden" name="what" value="${what}" />
        <label for="days-${what}" style="margin:0">Older than</label>
        <select id="days-${what}" name="days" style="width:auto">
          <option value="90">90 days</option>
          <option value="30" selected>30 days</option>
          <option value="7">7 days</option>
          <option value="0">everything</option>
        </select>
        <button class="danger" type="submit">Clear</button>
      </form>
    </div>
  `;

  return html`
    <div class="spread">
      <div>
        <h1>History &amp; storage</h1>
        <p class="subtitle">
          What has piled up since the platform started, and how to take it away.
          None of this is used to decide what publishes next, so clearing it is
          safe &mdash; but it is the only record of what happened, so export
          first.
        </p>
      </div>
      <a class="button" href="/settings">Back to settings</a>
    </div>

    <div class="grid">
      <div class="stat"><div class="value">${counts.runs}</div><div class="label">Runs</div></div>
      <div class="stat"><div class="value">${counts.steps}</div><div class="label">Run steps</div></div>
      <div class="stat"><div class="value">${counts.cycles}</div><div class="label">Scheduler checks</div></div>
      <div class="stat"><div class="value">${counts.events}</div><div class="label">Log events</div></div>
    </div>

    <p class="muted small">
      ${counts.oldestRunAt
        ? html`Oldest run recorded ${timeAgo(counts.oldestRunAt)}.`
        : raw('No runs recorded yet.')}
      Decisions and events older than ${retentionDays} day(s) are pruned
      automatically &mdash; that number is <em>Keep logs for</em> under Settings
      &rarr; Schedule. Runs are never pruned automatically, because a run is the
      record of an article you published.
    </p>

    <h2>Clear history</h2>

    ${clearCard(
      'runs',
      'Runs and their steps',
      counts.runs,
      html`One row per publishing attempt, plus every step underneath it &mdash;
        prompts, model outputs, timings. This is the bulk of the database.
        A run still in progress is never deleted.`,
      'runs',
    )}

    ${clearCard(
      'decisions',
      'Scheduler decisions',
      counts.decisions,
      html`Why each site was picked or skipped, written on every check. At one
        check every few minutes this is the fastest-growing table here, and it
        is only useful while you are asking why something did not publish.`,
      'decisions',
    )}

    ${clearCard(
      'events',
      'Event log',
      counts.events,
      html`Technical errors and scheduler activity &mdash; the Events page.`,
      'events',
    )}

    <h2>Shared article images</h2>
    <div class="card">
      <div class="spread">
        <div>
          <h3 style="margin-bottom:4px">Remembered image sets</h3>
          <div class="muted small">${counts.sharedImages} keyword(s) with a stored set</div>
        </div>
      </div>
      <p class="muted small">
        When a keyword runs on several sites, the first site to publish it
        becomes the source of its four article images and the rest copy them
        instead of asking Google again. Clearing this forgets those URLs: no
        image is deleted anywhere, the next site to publish simply generates a
        fresh set. Do it when you want new pictures for keywords you have
        already run.
      </p>
      <form method="post" action="/data/clear"
            onsubmit="return confirm('Forget every shared image set? Future runs will generate new images.')">
        <input type="hidden" name="what" value="shared-images" />
        <button class="danger" type="submit">Forget shared images</button>
      </form>
    </div>

    <h2>Export everything</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">
        Plain CSV, one file per table, nothing encrypted &mdash; site API tokens
        and LLM keys are deliberately not included in any of these.
      </p>
      <div class="row wrap">
        <a class="button" href="/data/export/runs" download>Runs</a>
        <a class="button" href="/data/export/steps" download>Run steps</a>
        <a class="button" href="/data/export/decisions" download>Decisions</a>
        <a class="button" href="/data/export/events" download>Events</a>
        <a class="button" href="/data/export/keywords" download>Keywords</a>
        <a class="button" href="/data/export/sites" download>Sites</a>
      </div>
    </div>

    <h2>Back it all up</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">
        One file holding the whole database: sites, keywords, settings, history. Written with
        <span class="mono">VACUUM INTO</span> rather than copied, because the database runs in
        WAL mode and a plain copy of the file silently omits every recent write.
      </p>
      <p class="muted small">
        Site tokens and API keys inside it stay encrypted with
        <span class="mono">ENCRYPTION_KEY</span>, which lives in the data volume and not in this
        file &mdash; so restoring onto a fresh deployment needs that key as well, and this file
        alone does not hand anyone your credentials.
      </p>
      <a class="button primary" href="/data/backup" download>Download the database</a>
    </div>

    <h2>Reclaim disk space</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">
        SQLite keeps the space a delete frees and reuses it later, so the file
        on disk does not shrink on its own. This rewrites it at its true size.
        It takes a moment and blocks other writes while it runs.
      </p>
      <form method="post" action="/data/compact">
        <button type="submit">Compact the database</button>
      </form>
    </div>
  `;
}

/* =========================================================================
 * One keyword: why it is or is not publishing
 * ====================================================================== */

export function keywordDetailPage(
  keyword: KeywordRow,
  diagnosis: KeywordDiagnosis,
  runs: RunListRow[],
): Html {
  return html`
    <div class="spread">
      <div>
        <h1>${keyword.seed_keyword}</h1>
        <p class="subtitle">${keyword.spy_title || 'No spy title recorded.'}</p>
      </div>
      <div class="row">
        <a class="button" href="/keywords">All keywords</a>
        <form method="post" action="/keywords/${keyword.id}/dry-run">
          <button type="submit"
                  title="Write this article now without publishing it, so you can read it">
            Dry run
          </button>
        </form>
      </div>
    </div>

    <div class="flash ${diagnosis.readyCount > 0 ? 'ok' : 'warn'}">
      ${diagnosis.summary}
    </div>

    <h2>Where it stands, site by site</h2>
    <div class="card table-wrap">
      ${diagnosis.sites.length === 0
        ? emptyState('No sites yet, so there is nowhere for this to publish.')
        : html`<table>
            <thead>
              <tr><th>Site</th><th>Cell</th><th>Ready now?</th><th>Why</th></tr>
            </thead>
            <tbody>
              ${diagnosis.sites.map(
                (verdict) => html`<tr>
                  <td class="mono"><a href="/sites/${verdict.siteId}">${verdict.domain}</a></td>
                  <td>
                    ${verdict.link === 'unlinked'
                      ? html`<span class="badge muted">not linked</span>`
                      : statusBadge(verdict.link)}
                  </td>
                  <td>
                    ${verdict.ready
                      ? html`<span class="badge ok">yes</span>`
                      : html`<span class="badge muted">no</span>`}
                  </td>
                  <td class="small">${verdict.reason}</td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>

    <h2>Its runs</h2>
    <div class="card table-wrap">
      ${runs.length === 0 ? emptyState('This keyword has never run.') : runTable(runs)}
    </div>

    <h2>What was imported</h2>
    <div class="card">
      <dl class="facts">
        <dt>Spy title</dt><dd>${keyword.spy_title || '—'}</dd>
        <dt>Spy description</dt><dd>${keyword.spy_description || '—'}</dd>
        <dt>Annotation</dt><dd>${keyword.annotation || '—'}</dd>
        <dt>Source URL</dt>
        <dd>
          ${keyword.spy_article_url
            ? html`<a href="${keyword.spy_article_url}" target="_blank" rel="noopener"
                >${keyword.spy_article_url}</a
              >`
            : '—'}
        </dd>
      </dl>
    </div>
  `;
}

/* =========================================================================
 * Keyword candidates read from a URL
 * ====================================================================== */

/**
 * The confirm screen between reading a page and saving a keyword.
 *
 * Every field here is editable, because metadata written for search engines is
 * not written to be a keyword — the title carries the site's name, the
 * description is a sales line. Reading the page saves the typing; it does not
 * replace the judgement.
 */
export function urlCandidatesPage(candidates: Candidate[]): Html {
  const usable = candidates.filter((c) => !c.error);
  const failed = candidates.filter((c) => c.error);

  return html`
    <div class="spread">
      <div>
        <h1>Read ${candidates.length} page(s)</h1>
        <p class="subtitle">
          Check what came back, edit anything that reads badly, then untick whatever you do not
          want. Nothing has been saved yet.
        </p>
      </div>
      <a class="button" href="/keywords">Cancel</a>
    </div>

    ${failed.length
      ? html`<div class="flash warn">
          <strong>${failed.length} could not be read</strong>
          <ul>
            ${failed.map((c) => html`<li><span class="mono">${c.url}</span> — ${c.error}</li>`)}
          </ul>
        </div>`
      : raw('')}

    ${usable.length === 0
      ? html`<div class="card">${emptyState('Nothing usable came back from those addresses.')}</div>`
      : html`<form method="post" action="/keywords/from-url/save">
          ${usable.map(
            (candidate, index) => html`
              <div class="card">
                <label class="row" style="gap:8px">
                  <input type="checkbox" name="keep" value="${index}" checked
                         style="width:auto" />
                  <span class="mono small">${candidate.url}</span>
                </label>
                <input type="hidden" name="url_${index}" value="${candidate.url}" />
                <input type="hidden" name="image_${index}" value="${candidate.imageUrl}" />

                <div class="field-row" style="margin-top:12px">
                  <div class="field">
                    <label>Seed keyword</label>
                    <input type="text" name="seed_${index}" value="${candidate.seedKeyword}" />
                    <div class="help">Stripped of the site name and the usual filler words.</div>
                  </div>
                  <div class="field">
                    <label>Spy title</label>
                    <input type="text" name="title_${index}" value="${candidate.title}" />
                  </div>
                </div>
                <div class="field">
                  <label>Spy description</label>
                  <textarea name="description_${index}" rows="2">${candidate.description}</textarea>
                </div>
              </div>
            `,
          )}

          <div class="save-bar">
            <button class="primary" type="submit">Save the ticked keywords</button>
            <span class="muted small">
              Added with status <span class="mono">go</span> and linked to no site — set the
              cells on the Keywords page.
            </span>
          </div>
        </form>`}
  `;
}

/* =========================================================================
 * Usage
 * ====================================================================== */

export function usagePage(costs: StepCost[], days: number): Html {
  const totalTokens = costs.reduce((sum, c) => sum + c.tokensIn + c.tokensOut, 0);

  return html`
    <div class="spread">
      <div>
        <h1>Usage</h1>
        <p class="subtitle">
          What the last ${days} days actually cost, per step, from the token counts the provider
          reported. This is how you find the expensive prompt &mdash; it is rarely the one you
          would guess, and a step that fails after burning its tokens still shows up here.
        </p>
      </div>
      <a class="button" href="/settings">Back to settings</a>
    </div>

    ${costs.length === 0
      ? html`<div class="card">
          ${emptyState(
            'Nothing recorded yet. Token counts are captured from each completion, so this ' +
              'fills in as runs happen.',
          )}
        </div>`
      : html`<div class="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Step</th><th>Runs</th><th>Tokens in</th><th>Tokens out</th>
                <th>Total</th><th>Share</th><th>Average time</th>
              </tr>
            </thead>
            <tbody>
              ${costs.map((cost) => {
                const total = cost.tokensIn + cost.tokensOut;
                const share = totalTokens === 0 ? 0 : (total / totalTokens) * 100;
                return html`<tr>
                  <td><strong>${cost.step}</strong></td>
                  <td>${cost.runs}</td>
                  <td class="nowrap">${formatTokens(cost.tokensIn)}</td>
                  <td class="nowrap">${formatTokens(cost.tokensOut)}</td>
                  <td class="nowrap"><strong>${formatTokens(total)}</strong></td>
                  <td style="min-width:120px">
                    <div class="bar"><span style="width:${share.toFixed(1)}%"></span></div>
                    <div class="muted small">${share.toFixed(0)}%</div>
                  </td>
                  <td class="nowrap muted">${formatDuration(Math.round(cost.avgDurationMs))}</td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>
        <p class="muted small">
          ${formatCount(totalTokens)} tokens across every step. A zero means the provider did
          not report a count for that call, not that it was free.
        </p>`}
  `;
}
