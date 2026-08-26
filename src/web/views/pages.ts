import {
  emptyState,
  formatDuration,
  html,
  Html,
  raw,
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

/* =========================================================================
 * Dashboard
 * ====================================================================== */

export interface DashboardData {
  sites: SiteView[];
  eligibility: { domain: string; eligible: boolean; reason: string }[];
  publishedToday: number;
  failedToday: number;
  keywordsReady: number;
  recentRuns: RunListRow[];
  automationOn: boolean;
  problems: string[];
  busy: boolean;
  lockedAt: string | null;
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
      <form method="post" action="/run-now">
        <button class="primary" type="submit" ${data.busy ? raw('disabled') : raw('')}>
          Run once now
        </button>
      </form>
    </div>

    ${problems} ${busy}

    <div class="grid">
      <div class="stat"><div class="value">${data.publishedToday}</div><div class="label">Published today</div></div>
      <div class="stat"><div class="value">${data.failedToday}</div><div class="label">Failed today</div></div>
      <div class="stat"><div class="value">${data.eligibility.filter((e) => e.eligible).length}</div><div class="label">Sites eligible now</div></div>
      <div class="stat"><div class="value">${data.keywordsReady}</div><div class="label">Keywords ready</div></div>
    </div>

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

    <h2>Recent runs</h2>
    <div class="card table-wrap">
      ${data.recentRuns.length === 0
        ? emptyState('No runs yet.')
        : runTable(data.recentRuns)}
    </div>
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
          <td>${statusBadge(r.status)}</td>
          <td class="small">
            ${r.status === 'published'
              ? html`<a href="${r.post_url ?? '#'}" target="_blank" rel="noopener">view article</a>`
              : html`<span class="muted"
                  >${r.failed_step ? `${r.failed_step}: ` : ''}${(r.error ?? '').slice(0, 120)}</span
                >`}
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

export function runDetailPage(
  run: RunRow,
  steps: StepRow[],
  site: SiteRow | undefined,
  keyword: KeywordRow | undefined,
): Html {
  return html`
    <div class="spread">
      <div>
        <h1>Run #${run.id}</h1>
        <p class="subtitle">
          ${site?.domain ?? 'unknown site'} · ${keyword?.seed_keyword ?? 'unknown keyword'} ·
          started ${timeAgo(run.started_at)}
        </p>
      </div>
      <div class="row">
        ${statusBadge(run.status)}
        ${run.status === 'failed'
          ? html`<form method="post" action="/runs/${run.id}/resume">
              <button class="primary" type="submit">Resume from failed step</button>
            </form>`
          : raw('')}
      </div>
    </div>

    ${run.error
      ? html`<div class="flash error">
          <strong>Failed at "${run.failed_step ?? 'unknown'}"</strong>
          <div class="mono" style="margin-top:6px">${run.error}</div>
        </div>`
      : raw('')}
    ${run.post_url
      ? html`<div class="flash ok">
          Published: <a href="${run.post_url}" target="_blank" rel="noopener">${run.post_url}</a>
        </div>`
      : raw('')}

    <h2>Steps</h2>
    ${steps.length === 0
      ? html`<div class="card">${emptyState('No steps recorded yet.')}</div>`
      : html`${steps.map(
          (s) => html`
            <div class="card step-${s.status}">
              <div class="spread">
                <div>
                  <strong>${s.step}</strong> ${statusBadge(s.status)}
                  <div class="muted small">
                    ${formatDuration(s.duration_ms)}
                    ${s.attempt > 1 ? html` · attempt ${s.attempt}` : raw('')}
                    ${s.endpoint ? html` · endpoint: ${s.endpoint}` : raw('')}
                    ${s.model ? html` · ${s.model}` : raw('')}
                  </div>
                </div>
                <span class="muted small nowrap">${timeAgo(s.started_at)}</span>
              </div>
              ${s.error ? html`<div class="flash error" style="margin-top:10px">${s.error}</div>` : raw('')}
              ${s.output_json
                ? html`<details>
                    <summary>Output</summary>
                    <pre>${prettyJson(s.output_json)}</pre>
                  </details>`
                : raw('')}
            </div>
          `,
        )}`}
  `;
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
                <th>Name</th><th>Domain</th><th>Status</th><th>Target</th>
                <th>Interval</th><th>Credentials</th><th>Today</th><th>Last publish</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${sites.map((s) => {
                const v = views.find((x) => x.id === s.id);
                return html`<tr>
                  <td>${s.name}</td>
                  <td class="mono">${s.domain}</td>
                  <td>${statusBadge(s.status)}</td>
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

export function siteEditPage(site: SiteRow): Html {
  return html`
    <h1>${site.domain}</h1>
    <p class="subtitle">Edit site configuration.</p>
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

export function keywordsPage(
  keywords: KeywordRow[],
  sites: SiteRow[],
  links: Map<string, string>,
  page: number,
  total: number,
): Html {
  const pages = Math.max(1, Math.ceil(total / 100));

  return html`
    <h1>Keywords</h1>
    <p class="subtitle">
      ${total} keyword(s). Each cell decides whether that keyword may run on that site.
    </p>

    <div class="card">
      <h3>Import from CSV</h3>
      <p class="muted small">
        Columns: <span class="mono">seed_keyword, spy_title, spy_description, spy_image_url,
        spy_article_url, spy_pin_image, annotation, status</span>, then one column per site
        domain holding go / done / no. Only <span class="mono">seed_keyword</span> is required.
      </p>
      <form method="post" action="/keywords/import" enctype="multipart/form-data">
        <div class="field"><input type="file" name="file" accept=".csv,text/csv" required /></div>
        <div class="row">
          <button class="primary" type="submit">Import CSV</button>
          <a class="button" href="/keywords/template.csv" download>Download template</a>
        </div>
        <div class="help" style="margin-top:8px">
          The template already contains a column for every site you have added, with example
          rows showing go / done / no.
        </div>
      </form>
    </div>

    <div class="card table-wrap">
      ${keywords.length === 0
        ? emptyState('No keywords yet. Import a CSV to get started.')
        : html`<table class="matrix">
            <thead>
              <tr>
                <th>Keyword</th><th>Status</th>
                ${sites.map((s) => html`<th title="${s.domain}">${s.name}</th>`)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${keywords.map(
                (k) => html`<tr>
                  <td>
                    <strong>${k.seed_keyword}</strong>
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
                    const current = links.get(`${k.id}:${s.id}`) ?? 'no';
                    return html`<td>
                      <form method="post" action="/keywords/${k.id}/link">
                        <input type="hidden" name="site_id" value="${s.id}" />
                        <select name="status" onchange="this.form.submit()">
                          ${(['go', 'done', 'no'] as const).map(
                            (v) =>
                              html`<option value="${v}" ${current === v ? raw('selected') : raw('')}>${v}</option>`,
                          )}
                        </select>
                      </form>
                    </td>`;
                  })}
                  <td>
                    <form method="post" action="/keywords/${k.id}/delete"
                          onsubmit="return confirm('Delete this keyword?')">
                      <button class="small danger" type="submit">×</button>
                    </form>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>

    ${pages > 1
      ? html`<div class="row">
          ${page > 1 ? html`<a class="button small" href="/keywords?page=${page - 1}">Previous</a>` : raw('')}
          <span class="muted small">Page ${page} of ${pages}</span>
          ${page < pages ? html`<a class="button small" href="/keywords?page=${page + 1}">Next</a>` : raw('')}
        </div>`
      : raw('')}
  `;
}

/* =========================================================================
 * Decisions
 * ====================================================================== */

export function decisionsPage(
  cycles: { cycle_id: string; created_at: string; n: number }[],
  selected: string | null,
  rows: DecisionRow[],
): Html {
  return html`
    <h1>Decisions</h1>
    <p class="subtitle">
      Why the scheduler did what it did. Every site checked, every keyword skipped, with the
      reason recorded at the moment the choice was made.
    </p>

    <div class="card">
      <h3>Recent checks</h3>
      ${cycles.length === 0
        ? emptyState('No scheduler checks recorded yet.')
        : html`<div class="row">
            ${cycles.map(
              (c) => html`<a class="button small ${c.cycle_id === selected ? 'primary' : ''}"
                href="/decisions?cycle=${c.cycle_id}">${timeAgo(c.created_at)} (${c.n})</a>`,
            )}
          </div>`}
    </div>

    ${selected
      ? html`<div class="card table-wrap">
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
 * Settings
 * ====================================================================== */

export function settingsPage(
  specs: SettingSpec[],
  values: Map<string, string>,
  endpoints: Endpoint[],
  problems: string[],
): Html {
  const groups: { key: SettingSpec['group']; title: string }[] = [
    { key: 'general', title: 'General' },
    { key: 'schedule', title: 'Schedule' },
    { key: 'llm', title: 'LLM' },
    { key: 'images', title: 'Image generation' },
    { key: 'buffer', title: 'Buffer' },
    { key: 'telegram', title: 'Telegram' },
  ];

  return html`
    <h1>Settings</h1>
    <p class="subtitle">
      Everything is configured here. The only file you ever edit by hand is
      <span class="mono">.env</span>, which holds one line: the encryption key.
    </p>

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
      <button class="primary" type="submit">Save settings</button>
    </form>

    <h2>LLM API keys</h2>
    <p class="subtitle">
      One row per API key. They all share the base URL above, because the provider is a
      single cloud endpoint — the keys exist only to spread its rate limit. Requests go to
      the least recently used healthy key; on a 429 the same request is retried on the next
      one, so a throttled key never breaks a run.
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
                      <button class="small danger" type="submit">×</button>
                    </form>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>

    <div class="card">
      <h3>Add an API key</h3>
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
              <div class="help">Comma separated. Normally blank — any key can serve any model.</div>
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
