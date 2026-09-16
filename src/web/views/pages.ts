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
import { BUFFER_ACCOUNT_LIMIT, hasSecret, type BufferAccount } from '../../db/repos.js';
import type {
  FbPageRow,
  FbTokenView,
  ReelCandidate,
  ReelView,
} from '../../db/repos.js';
import type {
  DecisionRow,
  EventRow,
  KeywordRow,
  RunListRow,
  RunRow,
  SiteRow,
  StepRow,
} from '../../db/repos.js';
import type { KeywordView, LinkView, SiteView } from '../../core/types.js';
import type { PresenterRow } from '../../db/repos.js';
import { formatMinutes } from '../../core/selector.js';
import { scenesFor } from '../../reels/plan.js';
import type { ReelFormat } from '../../reels/formats.js';
import type { Endpoint } from '../../llm/pool.js';
import type { SettingSpec } from '../../settings.js';
import type { Supply } from '../../core/supply.js';
import type { RunUsage } from '../../db/repos.js';
import type { KeywordDiagnosis } from '../../core/diagnosis.js';
import type {
  KeywordImageCounts,
  KeywordListView,
  SharedImageInfo,
} from '../../db/repos.js';
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
  /** For the manual run picker: what a person may choose to run right now. */
  keywords: KeywordView[];
  links: LinkView[];
  /** Articles written and stopped before publishing, waiting for a person. */
  held: RunListRow[];
  /** Published and failed per day, oldest first. */
  activity: { day: string; published: number; failed: number }[];
}

/**
 * The manual run picker.
 *
 * "Run once now" used to hand the decision to the selector, which meant it ran
 * whatever the scheduler would have run anyway — and refused when every site
 * had hit its daily target, which is exactly when someone reaches for it. It
 * now asks which site and which keyword, and runs that pair immediately.
 *
 * A <dialog>, so the modal behaviour, the backdrop and Escape to close are the
 * browser's rather than three more handlers to maintain.
 */
/** What the manual run picker needs: the sites, the keywords, their links, and whether a run is on. */
export type RunPickerData = Pick<DashboardData, 'sites' | 'keywords' | 'links' | 'busy'>;

export function runPicker(data: RunPickerData): Html {
  // Paused sites are listed, and labelled. Pausing stops the scheduler from
  // choosing a site; it is not meant to stop a person who names it.
  const runnable = data.sites;

  // Which keywords are linked to which sites, so choosing a site narrows the
  // keyword list to the pairs that were actually planned.
  const linkedSites = new Map<number, number[]>();
  for (const link of data.links) {
    if (link.status !== 'go') continue;
    const list = linkedSites.get(link.keywordId) ?? [];
    list.push(link.siteId);
    linkedSites.set(link.keywordId, list);
  }

  const choosable = data.keywords.filter((k) => k.status !== 'no');

  return html`
    <dialog id="run-once" class="card picker">
      <form method="post" action="/run-now">
        <h2>Run once now</h2>
        <p class="subtitle">
          This starts immediately and ignores the daily target and the interval
          since the last post. It publishes for real.
        </p>

        <div class="field">
          <label for="pick-site">Site</label>
          <select id="pick-site" name="site_id" required>
            ${runnable.map(
              (site) => html`<option value="${site.id}">
                ${site.domain}${site.status === 'paused' ? ' (paused)' : ''}
              </option>`,
            )}
          </select>
        </div>

        <div class="field">
          <label for="pick-keyword">Keyword</label>
          <select id="pick-keyword" name="keyword_id" required>
            ${choosable.map(
              (keyword) => html`<option value="${keyword.id}"
                data-sites="${(linkedSites.get(keyword.id) ?? []).join(',')}"
                >${keyword.spyTitle || keyword.seedKeyword}</option
              >`,
            )}
          </select>
          <p class="help">
            <label class="choice">
              <input type="checkbox" id="pick-all" />
              Show keywords that are not linked to this site
            </label>
          </p>
        </div>

        ${runnable.length === 0 || choosable.length === 0
          ? html`<div class="flash warn">
              Add at least one site and one keyword before running by hand.
            </div>`
          : raw('')}

        <div class="save-bar">
          <button type="button" id="run-once-cancel">Cancel</button>
          <button class="primary" type="submit"
                  ${runnable.length === 0 || choosable.length === 0 ? raw('disabled') : raw('')}>
            Run now
          </button>
        </div>
      </form>
    </dialog>

    <script>
      (function () {
        var dialog = document.getElementById('run-once');
        var site = document.getElementById('pick-site');
        var keyword = document.getElementById('pick-keyword');
        var all = document.getElementById('pick-all');

        // Hidden rather than removed, so unchecking the box brings them back
        // without rebuilding the list.
        function filter() {
          var chosen = site.value;
          var firstVisible = null;
          for (var i = 0; i < keyword.options.length; i++) {
            var option = keyword.options[i];
            var linked = (option.dataset.sites || '').split(',').indexOf(chosen) !== -1;
            var show = all.checked || linked;
            option.hidden = !show;
            option.disabled = !show;
            if (show && firstVisible === null) firstVisible = option;
          }
          // A hidden option can stay selected, which submits a pair the person
          // cannot see. Move to the first one they can.
          if (keyword.selectedOptions[0] && keyword.selectedOptions[0].hidden) {
            keyword.value = firstVisible ? firstVisible.value : '';
          }
        }

        document.getElementById('run-once-open').addEventListener('click', function () {
          filter();
          dialog.showModal();
        });
        document.getElementById('run-once-cancel').addEventListener('click', function () {
          dialog.close();
        });
        site.addEventListener('change', filter);
        all.addEventListener('change', filter);
      })();
    </script>
  `;
}

/** Decisions as a page of its own, under Activity. */
export function decisionsPage(
  cycles: { cycle_id: string; created_at: string; n: number }[],
  selected: string | null,
  rows: DecisionRow[],
  activity: { day: string; published: number; failed: number }[] = [],
): Html {
  return html`
    <h1>Decisions</h1>
    <p class="subtitle">Why the scheduler picked what it picked -- or nothing.</p>

    ${activity.length
      ? html`<div class="card">
          <div class="spread" style="align-items:center">
            <h3 style="margin:0">Last ${activity.length} days</h3>
            <span class="muted small">
              <span class="key brand"></span> published
              <span class="key red"></span> failed
            </span>
          </div>
          <div class="chart">${sparkline(activity, { width: 720, height: 64 })}</div>
        </div>`
      : raw('')}

    ${decisionsSection(cycles, selected, rows, '/decisions')}
  `;
}

function decisionsSection(
  cycles: { cycle_id: string; created_at: string; n: number }[],
  selected: string | null,
  rows: DecisionRow[],
  base = '/',
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
            href="${base}?cycle=${c.cycle_id}#decisions">${timeAgo(c.created_at)} (${c.n})</a>`,
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
    <h1>Articles</h1>
    <p class="subtitle">
      ${total} article(s) so far. Open one to see every step, what it cost, and
      why it failed if it did.
    </p>
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
          : duplicate && duplicate.similarity >= 1
            ? 'Held — this title is already on the site'
            : 'Written and waiting for your approval'}
      </strong>
      <div class="small" style="margin-top:6px">
        ${run.hold === 'dry'
          ? html`This ran the whole pipeline against ${run.title ? 'the keyword' : 'a keyword'} and
              stopped before posting. The images were generated and uploaded; only the article
              itself was not published. Publish it anyway if you like what you see.`
          : duplicate && duplicate.similarity >= 1
            ? html`An article with this exact title is already published here, so this one
                stopped before posting rather than putting a second copy on the site. Approve
                only if you mean to have both; otherwise discard it.`
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

    <!-- Folded away by default, like the step outputs below it. A finished
         recipe is a couple of thousand words, and on a run you opened to find
         out why Buffer rejected it, that is the whole page pushed off screen.
         Open on a held run, where reading it is the entire task. -->
    <details class="card article" ${editable ? raw('open') : raw('')}>
      <summary>
        ${title || 'Read the article'}
        <span class="muted small">${editable ? 'waiting for you' : 'read it'}</span>
      </summary>
      <div class="article-body">
        ${text('description') || text('intro') || text('summary')
          ? html`<p class="muted">${text('description') || text('intro') || text('summary')}</p>`
          : raw('')}
        ${body}
      </div>
    </details>

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

export function sitesPage(
  sites: SiteRow[],
  views: SiteView[],
  eligibility: { domain: string; eligible: boolean; reason: string }[] = [],
): Html {
  return html`
    <h1>Sites</h1>
    <p class="subtitle">
      Every website you publish to. Each one has its own daily target, gap between
      posts, and tokens. "Can run now?" says whether the platform would pick it at
      this moment, and why not if it would not.
    </p>

    ${sites.length === 0
      ? raw('')
      : html`
          <!-- Every control is a verb applied to the ticked rows, matching the
               keywords page. The two fields that need a value carry it beside
               the button that uses it, so no action depends on a field the
               person cannot see from the button they press. -->
          <form method="post" action="/sites/bulk" id="bulk" class="bulkbar">
            <div class="bulk-count">
              <span id="pick-count">0</span> selected
              <span class="muted small" id="pick-hint">— tick a row to act on it</span>
            </div>

            <div class="bulk-actions">
              <div class="bulk-group">
                <button type="submit" name="action" value="activate" class="primary">
                  Activate
                </button>
                <button type="submit" name="action" value="pause">Pause</button>
              </div>

              <div class="bulk-group">
                <span class="muted small">Publishing</span>
                <button type="submit" name="action" value="auto">Automatic</button>
                <button type="submit" name="action" value="hold">Hold for approval</button>
              </div>

              <div class="bulk-group">
                <label class="muted small" for="bulk-target">Articles a day</label>
                <input type="number" id="bulk-target" name="daily_target" min="0" max="100"
                       value="8" style="width:5rem" />
                <button type="submit" name="action" value="target" formnovalidate>Set</button>
              </div>

              <div class="bulk-group">
                <label class="muted small" for="bulk-interval">Wait between posts</label>
                <input type="number" id="bulk-interval" name="interval_amount" min="0"
                       value="3" style="width:5rem" />
                <select name="interval_unit" style="width:auto">
                  <option value="minutes">minutes</option>
                  <option value="hours" selected>hours</option>
                  <option value="days">days</option>
                </select>
                <button type="submit" name="action" value="interval" formnovalidate>Set</button>
              </div>
            </div>
          </form>
        `}

    <div class="card table-wrap">
      ${sites.length === 0
        ? emptyState('No sites yet. Add your first one below.')
        : html`<table>
            <thead>
              <!-- No Name column: in practice every site's name is its domain,
                   so the column was a second copy of the one beside it. The
                   field is still on the form, and still what the run log and
                   notifications call a site. -->
              <tr>
                <th class="pick">
                  <input type="checkbox" id="pick-all" title="Select every site" />
                </th>
                <th>Domain</th><th>Status</th><th>Publishing</th><th>Target</th>
                <th>Interval</th><th>Credentials</th><th>Today</th><th>Last publish</th>
                <th>Can run now?</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${sites.map((s) => {
                const v = views.find((x) => x.id === s.id);
                return html`<tr>
                  <td class="pick">
                    <input type="checkbox" form="bulk" name="ids" value="${s.id}" />
                  </td>
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
                  <td>
                    ${(() => {
                      const verdict = eligibility.find((e) => e.domain === s.domain);
                      if (!verdict) return raw('');
                      return verdict.eligible
                        ? html`<span class="badge ok">yes</span>`
                        : html`<span class="badge muted">no</span>
                            <div class="muted small">${verdict.reason}</div>`;
                    })()}
                  </td>
                  <td class="nowrap"><a class="button small" href="/sites/${s.id}">Edit</a></td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </div>

    <h2>Add a site</h2>
    <div class="card">${siteForm(null)}</div>

    <h2>Many at once</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">
        Columns: <span class="mono">name, domain, status, daily_target, interval_minutes,
        pin_username, project_id, auto_publish, paused_reason, api_token, buffer_token</span>.
        Only <span class="mono">domain</span> is required, and sites are matched on it &mdash;
        so importing the same file twice corrects rather than duplicates. A blank
        <span class="mono">api_token</span> or <span class="mono">buffer_token</span> keeps
        whatever is stored, which is what makes an export safe to edit and import straight back.
      </p>

      <form method="post" action="/sites/import" enctype="multipart/form-data">
        <div class="field"><input type="file" name="file" accept=".csv,text/csv" required /></div>
        <div class="row wrap">
          <button class="primary" type="submit">Import CSV</button>
          <a class="button" href="/sites/template.csv" download>Download a template</a>
          <a class="button" href="/data/export/sites" download>Export sites</a>
          <!-- Beside the safe export rather than in a panel of its own, but
               still marked and still confirmed: the two files look identical
               and one of them can publish to every site you own. -->
          <a class="button danger" href="/sites/export/credentials" download
             title="Every site API token and Buffer token in plain text"
             onclick="return confirm('This file contains every site token in plain text. Download it?')">
            Export with credentials
          </a>
        </div>
        <div class="help" style="margin-top:8px">
          <strong>Export sites</strong> carries everything except the tokens and is the one to
          reach for. <strong>Export with credentials</strong> is the same file with them in it,
          for moving to another deployment &mdash; it does not belong in a shared folder, a chat
          message, or a git repository.
        </div>
      </form>
    </div>
    ${raw(BULK_SELECTION_SCRIPT)}
  `;
}

export function siteEditPage(site: SiteRow, bufferAccounts: BufferAccount[] = []): Html {
  return html`
    <div class="spread">
      <div>
        <h1>${site.domain}</h1>
        <p class="subtitle">Edit site configuration.</p>
      </div>
      <div class="row wrap">
        <!-- Publishing mode sits with Pause rather than in the form below.
             Both answer "what is this site doing right now", which is a
             different question from the settings underneath, and neither means
             anything on a site that does not exist yet — which is why they are
             gone from Add a site entirely. -->
        <form method="post" action="/sites/${site.id}/publishing">
          <select name="auto_publish" onchange="this.form.submit()"
                  title="Holding stops each run after the article is written">
            <option value="1" ${site.auto_publish !== 0 ? raw('selected') : raw('')}>
              publishes automatically
            </option>
            <option value="0" ${site.auto_publish === 0 ? raw('selected') : raw('')}>
              holds for approval
            </option>
          </select>
        </form>

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
    ${bufferAccountsCard(site, bufferAccounts)}
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

/**
 * The Buffer accounts this site posts through, in the order they are tried.
 *
 * A Buffer queue takes ten posts a day and then refuses. With one account that
 * ended the run at its last step, with the article already written and
 * published. With several, the run moves down this list and finishes.
 */
function bufferAccountsCard(site: SiteRow, accounts: BufferAccount[]): Html {
  const room = BUFFER_ACCOUNT_LIMIT - accounts.length;

  // A grid rather than a table. A table spreads its columns to fill the card,
  // which on a wide screen put a hand's width of nothing between the token
  // field and the switch beside it. The grid gives the two text fields the
  // room and holds everything else to the width it needs, and header and rows
  // share one column definition so they cannot fall out of line.
  const row = (account: BufferAccount): Html => {
    const full = account.fullUntil !== null && account.fullUntil > new Date();

    return html`
      <li class="account">
        <span class="account-index">${account.position}</span>

        <label class="account-field">
          <span>Label</span>
          <input type="text" form="buffer-${account.id}" name="label"
                 value="${account.label}" />
        </label>

        <label class="account-field">
          <span>API token</span>
          <input type="password" form="buffer-${account.id}" name="token"
                 autocomplete="new-password" placeholder="leave blank to keep the saved one" />
        </label>

        <label class="inline-check account-rotation">
          <input type="checkbox" form="buffer-${account.id}" name="enabled" value="1"
                 ${account.enabled ? raw('checked') : raw('')} />
          in rotation
        </label>

        <div class="account-state">
          ${full
            ? html`<span class="badge warn" title="${account.lastError ?? ''}">queue full</span>`
            : account.enabled
              ? html`<span class="badge ok">ready</span>`
              : html`<span class="badge muted">out</span>`}
          <span class="muted small">
            ${account.lastUsedAt ? html`used ${timeAgo(account.lastUsedAt)}` : 'never used'}
          </span>
        </div>

        <div class="account-actions">
          <form method="post" action="/sites/${site.id}/buffer/${account.id}"
                id="buffer-${account.id}"></form>
          <button class="small" type="submit" form="buffer-${account.id}">Save</button>
          <form method="post" action="/sites/${site.id}/buffer/${account.id}/delete"
                onsubmit="return confirm('Remove ${account.label}? Posts will use the next account.')">
            <button class="danger small" type="submit">Remove</button>
          </form>
        </div>
      </li>
    `;
  };

  return html`
    <div class="card">
      <div class="spread">
        <h3>Buffer accounts</h3>
        <span class="muted small">${accounts.length} of ${BUFFER_ACCOUNT_LIMIT} in use</span>
      </div>
      <p class="muted small">
        Used in order. When Buffer refuses a post &mdash; a full queue, an expired
        token &mdash; the run moves to the next account and finishes rather than
        failing.
      </p>

      ${accounts.length === 0
        ? emptyState(
            'No accounts yet. The Buffer token on the form above keeps working until you add one.',
          )
        : html`<ul class="accounts">
            ${accounts.map(row)}
          </ul>`}

      ${room > 0
        ? html`<form method="post" action="/sites/${site.id}/buffer" class="account-add">
            <label class="account-field">
              <span>Label</span>
              <input type="text" name="label" placeholder="e.g. Overflow" />
            </label>
            <label class="account-field">
              <span>API token</span>
              <input type="password" name="token" required autocomplete="new-password"
                     placeholder="from the Buffer account to add" />
            </label>
            <input type="hidden" name="enabled" value="1" />
            <button class="primary" type="submit">Add account</button>
          </form>`
        : html`<p class="muted small">
            All ${BUFFER_ACCOUNT_LIMIT} in use. Remove one to add another.
          </p>`}
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
          "The token that lets the platform post articles and upload images to this website. From the site's own admin.",
        )}
        ${secretField(
          'buffer_token',
          'Buffer API token',
          site?.buffer_token_encrypted ?? '',
          "The Buffer account that schedules this site's Pinterest pins. The Pinterest channel is found automatically.",
        )}
      </div>
      <div class="field-row">
        <div class="field">
          <label>Pinterest username</label>
          <input type="text" name="pin_username" value="${site?.pin_username ?? ''}" />
          <div class="help">Only needed if the Buffer account has more than one Pinterest profile: names which one.</div>
        </div>
        <div class="field">
          <label>Google Flow project</label>
          <input type="text" name="project_id" value="${site?.project_id ?? ''}" />
          <div class="help">
            The Flow project this site's images go into: the long code after /project/
            in the address bar. Leave blank to use the shared one from Settings.
          </div>
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
  view: KeywordListView;
  siteId: number;
}

/** Where one keyword stands on one site, for the dots on its row. */
export interface SiteMark {
  domain: string;
  status: 'go' | 'done' | 'no' | 'unlinked';
}

/**
 * The views, in the words someone would use to ask for them.
 *
 * This replaced four dropdowns — keyword status, site, and one labelled "Where
 * it stands there" — whose combinations you had to hold the data model in your
 * head to predict. These are the five questions actually asked of this page.
 */
const VIEWS: { key: KeywordListView; label: string; blurb: string }[] = [
  { key: 'queued', label: 'Will publish', blurb: 'Set to go, with at least one site waiting to take it.' },
  {
    key: 'stuck',
    label: 'Going nowhere',
    blurb:
      'Set to go, but no site is set to go for it — so nothing will ever pick these up. ' +
      'They count as supply on the dashboard and publish nothing.',
  },
  { key: 'done', label: 'Finished', blurb: 'Already published everywhere they were meant to go.' },
  { key: 'off', label: 'Turned off', blurb: 'Set to no. The scheduler ignores them entirely.' },
  { key: 'all', label: 'Everything', blurb: 'Every keyword, whatever state it is in.' },
];

export function keywordsPage(
  keywords: KeywordRow[],
  sites: SiteRow[],
  marks: Map<number, SiteMark[]>,
  page: number,
  total: number,
  matched: number,
  counts: Record<KeywordListView, number>,
  filter: KeywordFilterView,
): Html {
  const pages = Math.max(1, Math.ceil(matched / 100));
  const current = VIEWS.find((v) => v.key === filter.view) ?? VIEWS[4]!;
  const back = `/keywords${pageLink(filter, page)}`;
  const siteName = sites.find((x) => x.id === filter.siteId)?.domain ?? '';

  return html`
    <div class="spread">
      <div>
        <h1>Keywords</h1>
        <p class="subtitle">
          ${total} keyword(s) across ${sites.length} site(s). A keyword publishes on a site when
          both are set to <span class="mono">go</span>.
        </p>
      </div>
      <a class="button primary" href="/keywords/add">Add keywords</a>
    </div>

    <!-- One question, not four fields. -->
    <form method="get" action="/keywords" class="viewbar">
      <div class="viewbar-line">
        <label for="view">Show me</label>
        <select id="view" name="view" onchange="this.form.submit()">
          ${VIEWS.map(
            (v) => html`<option value="${v.key}" ${filter.view === v.key ? raw('selected') : raw('')}>
              ${v.label} (${counts[v.key]})
            </option>`,
          )}
        </select>

        <label for="site">on</label>
        <select id="site" name="site" onchange="this.form.submit()">
          <option value="">any site</option>
          ${sites.map(
            (x) =>
              html`<option value="${x.id}" ${filter.siteId === x.id ? raw('selected') : raw('')}>${x.domain}</option>`,
          )}
        </select>

        <input type="search" name="q" value="${filter.q}" placeholder="search the words…" />
        <button type="submit">Search</button>
      </div>
      <p class="viewbar-blurb">
        ${current.blurb}
        ${filter.siteId ? html` Limited to <strong>${siteName}</strong>.` : raw('')}
      </p>
    </form>

    ${keywords.length === 0
      ? html`<div class="card">
          ${emptyState(
            filter.q
              ? `Nothing matches “${filter.q}” in this view.`
              : `No keywords are in this state${filter.siteId ? ` on ${siteName}` : ''}.`,
          )}
        </div>`
      : html`
          <!-- Every control below is a verb. The old bar read
               "Status [leave as is] On [all sites] set to [leave as is]",
               which is not a sentence anybody can act on. -->
          <form method="post" action="/keywords/bulk" id="bulk" class="bulkbar">
            <input type="hidden" name="back" value="${back}" />

            <div class="bulk-count">
              <span id="pick-count">0</span> selected
              <span class="muted small" id="pick-hint">— tick a row to act on it</span>
            </div>

            <div class="bulk-actions">
              <div class="bulk-group">
                <select name="site_id" aria-label="Which site these actions apply to">
                  <option value="">every site</option>
                  ${sites.map((x) => html`<option value="${x.id}">${x.domain}</option>`)}
                </select>
                <button type="submit" name="action" value="publish-on" class="primary">
                  Publish here
                </button>
                <button type="submit" name="action" value="stop-on">Stop here</button>
              </div>

              <div class="bulk-group">
                <button type="submit" name="action" value="finish">Mark finished</button>
                <button type="submit" name="action" value="off">Turn off</button>
              </div>

              <div class="bulk-group">
                <span class="muted small">Article images</span>
                <button type="submit" name="action" value="share-on"
                        title="Reuse one set of images across the sites this keyword runs on">
                  Reuse
                </button>
                <button type="submit" name="action" value="share-off"
                        title="Generate fresh images on every site">
                  Fresh
                </button>
              </div>

              <button type="submit" name="action" value="delete" class="danger" formnovalidate
                      onclick="return confirm('Delete every ticked keyword? This cannot be undone.')">
                Delete
              </button>
            </div>
          </form>

          <div class="card table-wrap">
            <table class="kwlist">
              <thead>
                <tr>
                  <th class="pick"><input type="checkbox" id="pick-all" title="Select every row here" /></th>
                  <th>Keyword</th>
                  <th>Where it runs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${keywords.map((k) => {
                  const row = marks.get(k.id) ?? [];
                  const going = row.filter((m) => m.status === 'go').length;

                  return html`<tr>
                    <td class="pick">
                      <input type="checkbox" form="bulk" name="ids" value="${k.id}" />
                    </td>
                    <td>
                      <a href="/keywords/${k.id}" class="kwtitle"
                        >${k.spy_title || k.seed_keyword}</a
                      >
                      <div class="muted small">
                        <span class="group-chip" title="Topic group — several recipes share this">
                          ${k.seed_keyword}
                        </span>
                        ${k.spy_title
                          ? raw('')
                          : html`<span class="badge error">no article title</span>`}
                      </div>
                    </td>
                    <td>
                      <div class="dots">
                        ${row.map(
                          (m) => html`<span class="dot ${m.status}"
                            title="${m.domain} — ${m.status === 'unlinked' ? 'not linked' : m.status}"
                          ></span>`,
                        )}
                      </div>
                      <div class="muted small">
                        ${k.status !== 'go'
                          ? html`keyword is <strong>${k.status}</strong>`
                          : going > 0
                            ? `${going} site(s) waiting for it`
                            : 'no site is set to go'}
                      </div>
                    </td>
                    <td class="nowrap">
                      <a class="button small" href="/keywords/${k.id}">Open</a>
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>

          <p class="muted small legend">
            <span class="dot go"></span> will publish here
            <span class="dot done"></span> already published
            <span class="dot no"></span> set to no
            <span class="dot unlinked"></span> not linked
            &mdash; hover a dot for the site.
          </p>
        `}

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

    ${raw(BULK_SELECTION_SCRIPT)}
  `;
}

function pageLink(filter: KeywordFilterView, page: number): string {
  const params = new URLSearchParams();
  if (filter.q) params.set('q', filter.q);
  if (filter.view && filter.view !== 'all') params.set('view', filter.view);
  if (filter.siteId) params.set('site', String(filter.siteId));
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Row selection, in the smallest amount of script that does the job.
 *
 * The checkboxes sit in the table but belong to the bulk form above it, via
 * the HTML `form` attribute: a form inside a form is invalid. The script keeps
 * the counter honest and greys the bar out until something is ticked, so it
 * stops looking like six decisions you owe it on arrival. Submitting still
 * works with scripting off.
 */
const BULK_SELECTION_SCRIPT = `<script>
(function () {
  var form = document.getElementById('bulk');
  if (!form) return;

  var boxes = Array.prototype.slice.call(document.querySelectorAll('input[name="ids"]'));
  var all = document.getElementById('pick-all');
  var count = document.getElementById('pick-count');
  var hint = document.getElementById('pick-hint');

  function sync() {
    var picked = 0;
    boxes.forEach(function (box) {
      if (box.checked) picked++;
      var row = box.closest('tr');
      if (row) row.classList.toggle('picked', box.checked);
    });

    if (count) count.textContent = String(picked);
    if (hint) hint.style.display = picked ? 'none' : '';
    form.classList.toggle('armed', picked > 0);

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
 * Adding keywords
 * ====================================================================== */

/**
 * Import moved off the list.
 *
 * It was two large blocks of explanatory text under a table people came to
 * read, which is most of why that page felt like a wall.
 */
export function keywordAddPage(): Html {
  return html`
    <div class="spread">
      <div>
        <h1>Add keywords</h1>
        <p class="subtitle">
          Bulk entry stays where it works well &mdash; a spreadsheet. Nothing is written until
          you import.
        </p>
      </div>
      <a class="button" href="/keywords">Back to keywords</a>
    </div>

    <h2>From a spreadsheet</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">
        Columns: <span class="mono">seed_keyword, spy_title, spy_description, annotation,
        status</span>, then one column per site domain holding
        <span class="mono">go</span>, <span class="mono">done</span> or
        <span class="mono">no</span>. Only <span class="mono">seed_keyword</span> is required.
      </p>
      <form method="post" action="/keywords/import" enctype="multipart/form-data">
        <div class="field"><input type="file" name="file" accept=".csv,text/csv" required /></div>
        <div class="row wrap">
          <button class="primary" type="submit">Import CSV</button>
          <a class="button" href="/keywords/template.csv" download>Download a template</a>
          <a class="button" href="/data/export/keywords" download>Export what is here</a>
        </div>
        <div class="help" style="margin-top:8px">
          The template already has a column for every site you have added. An export uses the same
          columns, so it can be edited in a spreadsheet and imported straight back.
        </div>
      </form>
    </div>
  `;
}

/* =========================================================================
 * Settings
 * ====================================================================== */

/** What the image service knows about its models, for the picker. */
export interface ImageModelCatalogue {
  models: {
    key: string;
    label: string;
    wire: string | null;
    discovered: boolean;
    outcome: 'untried' | 'accepted' | 'refused' | 'rejected' | 'unknown';
    at: string | null;
    error: string | null;
  }[];
  discovered: boolean;
  /** What the last scan of the Flow page looked at and found. */
  scan?: {
    at?: string;
    error?: string;
    page?: string;
    inline_scripts?: number;
    fetched?: string[];
    failed?: string[];
    anchor_hits?: Record<string, number>;
    candidates?: string[];
    near?: Record<string, string[]>;
  };
}


/** The three image models Flow offers, in fallback order. Keys match the image service. */
const IMAGE_MODEL_CHOICES = [
  { key: 'NANO_BANANA_PRO', label: 'Nano Banana Pro' },
  { key: 'NANO_BANANA_2', label: 'Nano Banana 2' },
  { key: 'NANO_BANANA_2_LITE', label: 'Nano Banana 2 Lite' },
];

/**
 * The image model picker, with what Google last said to each beside it.
 *
 * Two of the three names are known. The third is read off the Flow page by
 * the image service, and a name read off a page is a candidate until Google
 * accepts it -- which Automatic mode never checks, because Nano Banana 2 is
 * unlimited and the walk never reaches a third name. So the verdicts are
 * shown here: pick the third one, run an article, and this line says whether
 * it worked. That is the verification, and it costs one image.
 */
function imageModelPicker(current: string, catalogue: ImageModelCatalogue | null): Html {
  const verdict = (m: ImageModelCatalogue['models'][number]): Html => {
    if (!m.wire) return html`<span class="badge">not found on the Flow page yet</span>`;
    switch (m.outcome) {
      case 'accepted':
        return html`<span class="badge ok">verified</span> <span class="muted small">${m.at ?? ''}</span>`;
      case 'refused':
        return html`<span class="badge warn">refused by Google</span> <span class="muted small">${m.error ?? ''}</span>`;
      case 'rejected':
        return html`<span class="badge error">not a model Flow knows</span>`;
      default:
        return html`<span class="badge">untried</span>`;
    }
  };

  // The three are a fixed set the platform knows; the service only adds what
  // each is called on the wire and what Google said to it. So the picker is
  // always complete, whether or not the service has answered yet.
  const known = new Map((catalogue?.models ?? []).map((m) => [m.key, m]));
  const options = [
    { value: 'auto', label: 'Automatic — Pro first, then the others as fallbacks', disabled: false },
    ...IMAGE_MODEL_CHOICES.map((c) => {
      const m = known.get(c.key);
      const wire = m?.wire ?? null;
      return {
        value: c.key,
        label: wire ? `${c.label} (${wire})` : m && !wire ? `${c.label} — not found yet` : c.label,
        disabled: Boolean(m) && !wire,
      };
    }),
  ];

  return html`
    <div class="field">
      <label for="image_model">Image model</label>
      <select id="image_model" name="image_model">
        ${options.map(
          (o) => html`<option value="${o.value}" ${o.value === current ? raw('selected') : raw('')}
                        ${o.disabled ? raw('disabled') : raw('')}>${o.label}</option>`,
        )}
      </select>
      <div class="help">
        Automatic asks for Nano Banana Pro and falls back when Google refuses it. Pick one to
        use it alone — that is how the third model gets verified: choose it, run one article,
        and its line below says what Google answered.
      </div>
    </div>
    ${catalogue
      ? html`<table class="small" style="margin-top:8px">
          <tbody>
            ${catalogue.models.map(
              (m) => html`<tr>
                <td>${m.label}</td>
                <td class="mono muted">${m.wire ?? '—'}${m.discovered ? ' (read off the page)' : ''}</td>
                <td>${verdict(m)}</td>
              </tr>`,
            )}
          </tbody>
        </table>
        ${catalogue.discovered
          ? raw('')
          : html`<p class="small muted" style="margin-top:6px">
              The third name is read off the Flow page on the first image job after a
              deploy; nothing has run yet.
            </p>`}
        ${scanReport(catalogue.scan)}`
      : html`<p class="small muted" style="margin-top:6px">
          The image service did not answer, so no verdicts to show. The choice still saves.
        </p>`}
  `;
}

/**
 * What the scan of the Flow page saw, for when the third model is "not found".
 *
 * A scan that finds nothing has to say what it looked at, or the next step is
 * guessing: were the bundles fetched at all, did the known names even appear,
 * what sat near them. This is that, folded up unless someone opens it.
 */
function scanReport(scan: ImageModelCatalogue['scan']): Html {
  if (!scan || (!scan.at && !scan.error)) return raw('');
  const hits = Object.entries(scan.anchor_hits ?? {});
  const near = Object.entries(scan.near ?? {});
  return html`
    <details class="small" style="margin-top:8px">
      <summary class="muted">What the scan of the Flow page saw${scan.at ? html` (${scan.at})` : raw('')}</summary>
      <div style="margin-top:6px">
        ${scan.error ? html`<div class="badge error">${scan.error}</div>` : raw('')}
        ${scan.page ? html`<div>Page: <span class="mono">${scan.page}</span></div>` : raw('')}
        <div>
          Inline scripts: ${String(scan.inline_scripts ?? 0)} ·
          fetched: ${String(scan.fetched?.length ?? 0)} ·
          could not fetch: ${String(scan.failed?.length ?? 0)}
        </div>
        ${hits.length
          ? html`<div>Known names found in the source:
              ${hits.map(([name, n]) => html`<span class="mono">${name}</span>&times;${String(n)} `)}
            </div>`
          : raw('')}
        ${scan.candidates?.length
          ? html`<div>Candidates near every known name:
              <span class="mono">${scan.candidates.join(', ')}</span></div>`
          : html`<div>No token sat near every known name.</div>`}
        ${near.map(
          ([name, tokens]) => html`<div style="margin-top:4px">Near <span class="mono">${name}</span>:
            <span class="mono muted">${tokens.length ? tokens.join(' ') : '—'}</span></div>`,
        )}
        ${scan.failed?.length
          ? html`<div style="margin-top:4px">Could not fetch:
              <div class="mono muted">${scan.failed.map((f) => html`${f}<br />`)}</div></div>`
          : raw('')}
      </div>
    </details>
  `;
}

export function settingsPage(
  specs: SettingSpec[],
  values: Map<string, string>,
  problems: string[],
  imageModels: ImageModelCatalogue | null = null,
): Html {
  const groups: {
    key: SettingSpec['group'];
    title: string;
    blurb?: string;
    /** Rendered inside the card after the fields: links or a picker. */
    footer?: Html;
  }[] = [
    { key: 'general', title: 'General', blurb: 'The main switch.' },
    {
      key: 'schedule',
      title: 'Schedule',
      blurb: 'How often the platform checks for work, and how long one article may take.',
    },
    { key: 'retry', title: 'Retries', blurb: 'What happens when an article fails.' },
    { key: 'llm', title: 'Article writer', blurb: 'The AI service that writes the articles.' },
    {
      key: 'images',
      title: 'Image generation',
      blurb: 'Images are generated in Google Flow through the browser under Setup → Browser.',
      footer: imageModelPicker(values.get('image_model') ?? 'auto', imageModels),
    },
    { key: 'buffer', title: 'Pinterest (Buffer)', blurb: 'A pin for every article, scheduled through Buffer.' },
    {
      key: 'facebook',
      title: 'Facebook',
      // The tokens and pages live on their own page: they are tables, not
      // fields, and the switch here is the only thing about Facebook that
      // belongs in a settings form.
      footer: html`
        <div class="row wrap field-links">
          <a class="button primary" href="/settings/facebook">Tokens &amp; pages</a>
        </div>
      `,
    },
    { key: 'telegram', title: 'Telegram', blurb: 'Messages to your phone when something needs you.' },
  ];

  return html`
    <h1>General</h1>
    <p class="subtitle">
      How the platform behaves. Every change applies as soon as you save.
    </p>

    ${problems.length
      ? html`<div class="flash warn">
          <strong>Not ready to run</strong>
          <ul>${problems.map((p) => html`<li>${p}</li>`)}</ul>
        </div>`
      : html`<div class="flash ok">Configuration is complete.</div>`}

    <form method="post" action="/settings">
      ${groups.map((group) => {
        // Hidden settings still resolve, still take their environment
        // override, and are still saved if something submits them. They are
        // simply not questions worth putting to anybody.
        const fields = specs.filter((s) => s.group === group.key && !s.hidden);
        if (fields.length === 0) return raw('');
        return html`
          <h2>${group.title}</h2>
          ${group.blurb ? html`<p class="subtitle">${group.blurb}</p>` : raw('')}
          <div class="card">
            ${fields.map((spec) => settingField(spec, values.get(spec.key) ?? ''))}
            ${group.footer ?? raw('')}
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
  `;
}

export function keysPage(endpoints: Endpoint[], baseUrl: string): Html {
  return html`
    <h1>LLM API keys</h1>
    <p class="subtitle">
      The API keys the article writer uses, all from <span class="mono">${baseUrl}</span>.
      More keys means more articles per hour: when one key hits its limit, the
      next one is used. Keys do not choose the model &mdash; that is under Prompts.
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
              <div class="help">Leave blank. Only if this key may not be used for some models.</div>
            </div>
            <div class="field">
              <label>Override base URL</label>
              <input type="text" name="base_url" placeholder="leave blank to use the shared URL" />
              <div class="help">Leave blank unless this key belongs to a different provider.</div>
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
    <h1>Events</h1>
    <p class="subtitle">
      A log of technical problems and what the scheduler did. If an article failed
      and its page did not say enough, the reason is usually here.
    </p>
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
      The instructions the AI follows at each step. Editing them changes how
      articles are written. Every edit is saved and the original is always there
      to go back to; the last ${PROMPT_VERSIONS_KEPT} saves of each are
      kept so you can go back to this morning rather than all the way.
    </p>
    <p class="subtitle">
      Each prompt is sent to one AI model, chosen here. A bigger model writes
      better and costs more; API keys have nothing to do with this choice.
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
          How much history is stored, and how to export or clear it. Clearing
          never changes what gets published next &mdash; but it is the only record
          of what happened, so export first.
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
  shares: Map<number, boolean>,
  images: SharedImageInfo | undefined,
  counts: KeywordImageCounts,
  siblings: KeywordRow[],
): Html {
  return html`
    <div class="spread">
      <div>
        <!-- A spy title can run to a couple of hundred characters, so a long
             one is clamped rather than allowed to become the whole page. -->
        <h1 class="${(keyword.spy_title || '').length > 70 ? 'long' : ''}"
            title="${keyword.spy_title || keyword.seed_keyword}">
          ${keyword.spy_title || keyword.seed_keyword}
        </h1>
      </div>
      <div class="row">
        <a class="button" href="/keywords">All keywords</a>
        <form method="post" action="/keywords/${keyword.id}/dry-run">
          <button type="submit"
                  title="Write this article now without publishing it, so you can read it first">
            Write a test article
          </button>
        </form>
      </div>
    </div>

    ${keyword.spy_title.trim()
      ? raw('')
      : html`<div class="flash error">
          <strong>This keyword has no article title</strong>
          <div class="small" style="margin-top:6px">
            Only the topic group describes it, and a topic group covers many different
            recipes &mdash; so there is nothing here to say which dish to write. Runs for this
            keyword are refused rather than producing another copy of whatever else is in
            &ldquo;${keyword.seed_keyword}&rdquo;. Fill in
            <span class="mono">spy_title</span> and re-import.
          </div>
        </div>`}

    ${groupCard(keyword, siblings)}

    <div class="flash ${diagnosis.readyCount > 0 ? 'ok' : 'warn'}">${diagnosis.summary}</div>

    <h2>Is this keyword in use?</h2>
    <div class="card">
      <form method="post" action="/keywords/${keyword.id}/status" class="row wrap">
        ${(
          [
            ['go', 'Use it', 'The scheduler may pick this up.'],
            ['done', 'Finished', 'Published everywhere it was meant to go.'],
            ['no', 'Turned off', 'Never pick this up.'],
          ] as const
        ).map(
          ([value, label, why]) => html`
            <label class="choice ${keyword.status === value ? 'on' : ''}">
              <input type="radio" name="status" value="${value}"
                     ${keyword.status === value ? raw('checked') : raw('')}
                     onchange="this.form.submit()" />
              <span><strong>${label}</strong><span class="muted small">${why}</span></span>
            </label>
          `,
        )}
      </form>
    </div>

    <h2>Which sites should publish it?</h2>
    <p class="subtitle">
      One row per site, with the reason it can or cannot run right now. This is the same
      information the scheduler uses when it decides.
    </p>

    <div class="card table-wrap">
      ${diagnosis.sites.length === 0
        ? emptyState('No sites yet, so there is nowhere for this to publish.')
        : html`<table>
            <thead>
              <tr><th>Site</th><th>Should it run here?</th><th>Images</th><th>Right now</th></tr>
            </thead>
            <tbody>
              ${diagnosis.sites.map((verdict) => {
                const linked = verdict.link !== 'unlinked';
                const shared = shares.get(verdict.siteId) ?? true;

                return html`<tr>
                  <td>
                    <a href="/sites/${verdict.siteId}" class="mono">${verdict.domain}</a>
                  </td>
                  <td>
                    <form method="post" action="/keywords/${keyword.id}/link" class="row">
                      <input type="hidden" name="site_id" value="${verdict.siteId}" />
                      <input type="hidden" name="share_images" value="${shared ? '1' : '0'}" />
                      <select name="status" onchange="this.form.submit()">
                        <option value="go" ${verdict.link === 'go' ? raw('selected') : raw('')}>
                          yes — publish here
                        </option>
                        <option value="done" ${verdict.link === 'done' ? raw('selected') : raw('')}>
                          already published here
                        </option>
                        <option value="no"
                                ${verdict.link === 'no' || !linked ? raw('selected') : raw('')}>
                          no — skip this site
                        </option>
                      </select>
                    </form>
                  </td>
                  <td>
                    ${verdict.link === 'go' || verdict.link === 'done'
                      ? html`<form method="post" action="/keywords/${keyword.id}/link" class="row">
                          <input type="hidden" name="site_id" value="${verdict.siteId}" />
                          <input type="hidden" name="status" value="${verdict.link}" />
                          <label class="muted small"
                                 title="Reuse the article images another site already made for this keyword. The Pinterest graphic is always made fresh.">
                            <input type="checkbox" name="share_images" value="1"
                                   ${shared ? raw('checked') : raw('')}
                                   onchange="this.form.submit()" />
                            reuse
                          </label>
                        </form>`
                      : html`<span class="muted small">—</span>`}
                  </td>
                  <td class="small">
                    ${verdict.ready
                      ? html`<span class="badge ok">ready</span> ${verdict.reason}`
                      : verdict.reason}
                    ${verdict.blocked
                      ? html`<form method="post"
                                   action="/keywords/${keyword.id}/unblock/${verdict.siteId}"
                                   style="margin-top:6px">
                          <button class="small" type="submit"
                                  title="Offer this pair again on the next check">
                            Put it back in the running
                          </button>
                        </form>`
                      : raw('')}
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </div>

    ${imagesSection(keyword, images, counts)}

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
      <form method="post" action="/keywords/${keyword.id}/delete" style="margin-top:14px"
            onsubmit="return confirm('Delete this keyword? Its run history stays but is detached.')">
        <button class="danger small" type="submit">Delete this keyword</button>
      </form>
    </div>
  `;
}

/**
 * The topic group, stated as a label rather than an identity.
 *
 * Spying on one topic yields five or ten different recipes under it, so the
 * seed keyword is shared and means "where I found this", not "what this is".
 * Naming the siblings makes that concrete, and makes it obvious at a glance if
 * two of them are drifting towards the same article.
 */
function groupCard(keyword: KeywordRow, siblings: KeywordRow[]): Html {
  return html`
    <div class="card groupcard">
      <div>
        <span class="muted small">Topic group</span>
        <div>
          <span class="group-chip big">${keyword.seed_keyword}</span>
          <span class="muted small">
            &mdash; a research label, not the subject. The article is written from the title,
            description and notes below it.
          </span>
        </div>
      </div>

      ${siblings.length > 0
        ? html`<div style="margin-top:12px">
            <span class="muted small">
              ${siblings.length} other recipe(s) found under the same label. Each is its own
              keyword with its own article and its own images:
            </span>
            <div class="row wrap" style="margin-top:8px">
              ${siblings.map(
                (other) => html`<a class="button small" href="/keywords/${other.id}"
                  >${other.spy_title || `#${other.id}`}</a
                >`,
              )}
            </div>
          </div>`
        : html`<div class="muted small" style="margin-top:10px">
            The only recipe under this label so far.
          </div>`}
    </div>
  `;
}

/**
 * Which images this keyword owns, and what it has cost.
 *
 * "Only four article images but ten Pinterest ones" is the correct behaviour
 * of the sharing design, and it looks exactly like a bug until you can see the
 * arithmetic: four article images are generated once per *keyword* and copied
 * to every site it runs on, while the Pinterest graphic is generated once per
 * *site* because it is the asset that has to be unique.
 *
 * Showing the actual URLs matters more than the explanation. Two keywords
 * displaying two different sets is the only thing that really answers "are
 * these being shared across keywords?".
 */
function imagesSection(
  keyword: KeywordRow,
  images: SharedImageInfo | undefined,
  counts: KeywordImageCounts,
): Html {

  return html`
    <h2>Its images</h2>

    <div class="grid">
      <div class="stat">
        <div class="value">${counts.articleGenerated}</div>
        <div class="label">Article images made</div>
        <div class="muted small">
          ${counts.generatedRuns === 0
            ? 'none yet'
            : counts.generatedRuns === 1
              ? 'four, made once and reused'
              : `${counts.generatedRuns} sets of four — regenerated since`}
        </div>
      </div>
      <div class="stat">
        <div class="value">${counts.copiedRuns}</div>
        <div class="label">Sites that copied them</div>
        <div class="muted small">no call to Google</div>
      </div>
      <div class="stat ${counts.pinsFailed > 0 ? 'supply-low' : ''}">
        <div class="value">${counts.pinsMade}</div>
        <div class="label">Pinterest graphics made</div>
        <div class="muted small">
          one per site, never shared${counts.pinsFailed > 0
            ? `, ${counts.pinsFailed} attempt(s) failed`
            : ''}
        </div>
      </div>
    </div>

    <div class="card">
      ${images
        ? html`
            <p class="muted small" style="margin-top:0">
              These four belong to this keyword alone. They were made on
              <strong>${images.sourceDomain ?? 'a site that has since been removed'}</strong>
              ${timeAgo(images.createdAt)}, and
              ${images.reusedBy === 0
                ? 'no other site has copied them yet'
                : `${images.reusedBy} other site(s) copied them instead of asking Google again`}.
              Open another keyword and you will see a different set &mdash; the store is keyed by
              keyword, so one keyword&rsquo;s images can never be handed to another.
            </p>
            <div class="shots">
              ${(
                [
                  ['Feature', images.feature],
                  ['Top shot', images.topShot],
                  ['Texture macro', images.textureMacro],
                  ['Before / after', images.beforeAfter],
                ] as const
              ).map(
                ([label, url]) => html`
                  <a class="shot" href="${url}" target="_blank" rel="noopener">
                    <img src="${url}" alt="${label} for ${keyword.seed_keyword}" loading="lazy" />
                    <span>${label}</span>
                  </a>
                `,
              )}
            </div>
            <form method="post" action="/keywords/${keyword.id}/images/clear" style="margin-top:14px"
                  onsubmit="return confirm('Forget these? The next site to publish this keyword will generate a new set.')">
              <button class="danger small" type="submit">Forget these and make new ones</button>
            </form>
          `
        : html`<p class="muted small" style="margin:0">
            No image set stored for this keyword yet. The first site to publish it generates four
            and records them here; every site after that copies them, unless you have turned
            <span class="mono">reuse</span> off for that site above.
          </p>`}
    </div>
  `;
}

/* =========================================================================
 * Reels
 * ====================================================================== */

/** The four article images, as the generate-images step recorded them. */
export interface ReelImages {
  feature: string;
  topShot: string;
  textureMacro: string;
  beforeAfter: string;
}

export interface ReelsPageData {
  candidates: (ReelCandidate & { images: ReelImages | null })[];
  reels: ReelView[];
  configured: boolean;
  enabled: boolean;
  pages: number;
}

const REEL_STATE: Record<string, { label: string; badge: string }> = {
  draft: { label: 'Draft', badge: 'pending' },
  generating: { label: 'Generating', badge: 'pending' },
  ready: { label: 'Ready to review', badge: 'ok' },
  publishing: { label: 'Publishing', badge: 'pending' },
  published: { label: 'Published', badge: 'ok' },
  failed: { label: 'Failed', badge: 'failed' },
};

/** An absolute URL for an image the site published. */
const onSite = (domain: string | null, path: string): string =>
  `https://${(domain ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')}${path}`;

/**
 * One reel, as a tile.
 *
 * A tile rather than a table row: the thing being judged here is a video and
 * four photographs, and a table forces that into a column narrow enough to
 * wrap a title onto four lines while a 9:16 preview stretches the row past the
 * height of a screen. Tiles let the media be the size it needs to be and the
 * text sit under it.
 */
function reelTile(reel: ReelView): Html {
  const state = REEL_STATE[reel.status] ?? { label: reel.status, badge: 'pending' };
  const live = reel.fb_video_id ? `https://www.facebook.com/reel/${reel.fb_video_id}` : '';

  return html`
    <article class="tile">
      <div class="tile-media">
        ${reel.video_url
          ? html`<video src="${reel.video_url}" controls muted playsinline preload="metadata"></video>`
          : html`<div class="tile-placeholder">
              ${reel.status === 'generating' ? 'Generating…' : 'No video yet'}
            </div>`}
      </div>

      <div class="tile-body">
        <div class="row wrap">
          ${statusBadge(state.badge)}<span class="small">${state.label}</span>
        </div>

        <div class="tile-title">
          <a href="/reels/${reel.id}">${reel.run_title ?? '(untitled)'}</a>
        </div>
        <div class="help">
          ${reel.site_domain ?? ''} &middot; ${reel.seed_keyword ?? ''}
        </div>
        <div class="help">
          ${reel.page_name
            ? html`To <strong>${reel.page_name}</strong>`
            : html`<a href="/settings/facebook">No page for this niche &mdash; assign one</a>`}
        </div>

        ${reel.error
          ? html`<div class="tile-error small">
              ${reel.error.length > 200 ? html`${reel.error.slice(0, 200)}…` : html`${reel.error}`}
              <a href="/reels/${reel.id}">Full report</a>
            </div>`
          : raw('')}

        <div class="row wrap tile-actions">
          ${reel.status === 'ready' && reel.fb_page_id
            ? html`<form method="post" action="/reels/${reel.id}/publish">
                <button class="primary" type="submit">Publish</button>
              </form>`
            : raw('')}
          ${reel.status === 'failed'
            ? html`<form method="post" action="/reels/${reel.id}/retry">
                <button type="submit">Retry</button>
              </form>`
            : raw('')}
          ${live ? html`<a class="button" href="${live}" target="_blank" rel="noopener">View</a>` : raw('')}
          <form method="post" action="/reels/${reel.id}/discard"
                onsubmit="return confirm('Discard this reel?')">
            <button class="danger" type="submit">Discard</button>
          </form>
        </div>
      </div>
    </article>
  `;
}

/** One published article that could become a reel. */
function candidateTile(c: ReelCandidate & { images: ReelImages | null }): Html {
  const images = c.images;

  return html`
    <article class="tile">
      <div class="tile-strip">
        ${images
          ? [images.feature, images.topShot, images.textureMacro, images.beforeAfter].map(
              (src) => html`<img src="${onSite(c.site_domain, src)}" alt="" loading="lazy">`,
            )
          : html`<div class="tile-placeholder">Images unavailable</div>`}
      </div>

      <div class="tile-body">
        <div class="tile-title">${c.title || c.spy_title}</div>
        <div class="help">
          ${c.site_domain} &middot; ${c.seed_keyword} &middot; ${timeAgo(c.published_at ?? '')}
        </div>
        <div class="row wrap tile-actions">
          ${images
            ? html`<a class="button" href="/reels/new/${c.run_id}">Make a reel</a>`
            : raw('')}
        </div>
      </div>
    </article>
  `;
}

export function reelsPage(data: ReelsPageData): Html {
  const working = data.reels.filter((r) => r.status !== 'published');
  const published = data.reels.filter((r) => r.status === 'published');

  return html`
    <div class="spread">
      <div>
        <h1>Reels</h1>
        <p class="subtitle">
          Every published article whose niche has a page becomes a reel here. Make one by
          hand from any article below.
        </p>
      </div>
      <div class="row wrap">
        <a class="button" href="/settings/facebook">Facebook pages</a>
      </div>
    </div>

    ${!data.configured
      ? html`<div class="flash warn">
          <strong>Facebook is not set up yet.</strong>
          Add a token and give a page a niche under
          <a href="/settings/facebook">Settings &rarr; Facebook</a>; reels are made automatically from then on.
        </div>`
      : !data.enabled
        ? html`<div class="flash warn">
            <strong>Reel publishing is switched off.</strong>
            Reels can still be generated and reviewed. Turn on &ldquo;Publish reels to
            Facebook&rdquo; in <a href="/settings">Settings</a> to release them.
          </div>`
        : raw('')}

    <h2>In progress</h2>
    ${working.length === 0
      ? html`<div class="card">${emptyState('No reels on the go.')}</div>`
      : html`<div class="grid tiles">${working.map(reelTile)}</div>`}

    <h2>Make a reel from</h2>
    <p class="subtitle">Published articles whose images are still on file.</p>
    ${data.candidates.length === 0
      ? html`<div class="card">
          ${emptyState('Nothing to turn into a reel yet. Publish an article first.')}
        </div>`
      : html`<div class="grid tiles">${data.candidates.map(candidateTile)}</div>`}

    ${published.length === 0
      ? raw('')
      : html`
          <!-- Folded away: finished work is worth being able to find, and worth
               nothing at all in the space where the current work is judged. -->
          <details class="card">
            <summary>Published (${published.length})</summary>
            <div class="table-wrap scroll-y">
              <table>
                <thead><tr><th>Article</th><th>Page</th><th>When</th><th></th></tr></thead>
                <tbody>
                  ${published.map(
                    (reel) => html`<tr>
                      <td>${reel.run_title ?? '(untitled)'}</td>
                      <td class="small">${reel.page_name ?? ''}</td>
                      <td class="muted small nowrap">${timeAgo(reel.updated_at)}</td>
                      <td class="nowrap">
                        ${reel.fb_video_id
                          ? html`<a class="button" target="_blank" rel="noopener"
                                   href="https://www.facebook.com/reel/${reel.fb_video_id}">View</a>`
                          : raw('')}
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>
          </details>`}
  `;
}

export interface ReelComposerData {
  candidate: ReelCandidate;
  images: ReelImages;
  caption: string;
  page: FbPageRow | undefined;
}

/**
 * Choose what the reel is made from.
 *
 * All four are ticked by default. They were not, on the reasoning that a
 * texture macro alone makes a video of an unidentifiable surface -- true of
 * that image alone, and beside the point when it arrives alongside the other
 * three. The prompt asks the model to read the dish from the photos together,
 * and giving it two of the four to read from is throwing away the detail it
 * needs to keep ingredients and textures honest. Untick one to exclude it.
 *
 * The Pinterest graphic is deliberately not here and never was: these come
 * from the generate-images step, which produces the four article images, and
 * the pin is built by a different step from a different template.
 */
export interface ReelSettingsData {
  lengthSeconds: number;
  allowed: string[];
  freshImages: boolean;
  cta: string;
  formats: ReelFormat[];
}

/** Setup → Reels: how every reel is shaped. */
export function reelSettingsPage(data: ReelSettingsData): Html {
  const lengths = [15, 30, 45, 60];
  return html`
    <h1>Reels</h1>
    <p class="subtitle">
      How every reel is shaped. Nothing here is needed to start; change it when you
      want reels longer, shorter, or in fewer shapes.
    </p>

    <form method="post" action="/settings/reels">
      <h2>Length</h2>
      <div class="card">
        <div class="field">
          <label for="reel_length_seconds">Reel length</label>
          <select id="reel_length_seconds" name="reel_length_seconds">
            ${lengths.map(
              (n) => html`<option value="${n}" ${n === data.lengthSeconds ? raw('selected') : raw('')}>
                ${n} seconds — ${scenesFor(n)} scenes
              </option>`,
            )}
          </select>
          <div class="help">
            Each scene is a ten-second clip. Longer reels cost more video credits per article.
          </div>
        </div>
        <div class="field">
          <label for="reel_cta_text">Call to action</label>
          <input type="text" id="reel_cta_text" name="reel_cta_text" value="${data.cta}" />
          <div class="help">
            The last thing every reel says and shows. The article link goes in the first comment.
          </div>
        </div>
        <div class="field">
          <label>
            <input type="checkbox" name="reel_fresh_images" value="1"
                   ${data.freshImages ? raw('checked') : raw('')} />
            Make a fresh image for every scene
          </label>
          <div class="help">
            Off: scenes are filmed from the article's own images, which costs nothing extra.
            On: a new image is made for every scene first.
          </div>
        </div>
      </div>

      <h2>Shapes</h2>
      <p class="subtitle">
        Every reel takes one of these. A page never repeats a shape it used in its last
        four reels, so turning more on means more variety.
      </p>
      <div class="card">
        ${data.formats.map(
          (f) => html`<div class="field">
            <label>
              <input type="checkbox" name="reel_formats" value="${f.key}"
                     ${data.allowed.includes(f.key) ? raw('checked') : raw('')} />
              <strong>${f.title}</strong>
              <span class="muted"> — ${f.shape}</span>
            </label>
          </div>`,
        )}
      </div>

      <div class="save-bar">
        <button class="primary" type="submit">Save</button>
        <span class="muted small">Applies to the next reel.</span>
      </div>
    </form>
  `;
}

export function reelComposerPage(data: ReelComposerData): Html {
  const shots: { key: keyof ReelImages; label: string }[] = [
    { key: 'feature', label: 'Feature' },
    { key: 'topShot', label: 'Top shot' },
    { key: 'textureMacro', label: 'Texture macro' },
    { key: 'beforeAfter', label: 'Before / after' },
  ];

  return html`
    <h1>Make a reel</h1>
    <p class="subtitle">
      ${data.candidate.title || data.candidate.spy_title}
      &middot; ${data.candidate.site_domain} &middot; ${data.candidate.seed_keyword}
    </p>

    <form method="post" action="/reels/new/${data.candidate.run_id}">
      <div class="split">
        <div class="card">
          <h2>What it is made from</h2>
          <p class="help">
            The storyboard is written for this article and filmed from these
            photographs, scene by scene. Nothing to choose here.
          </p>
          <div class="pick-grid">
            ${shots.map(
              (shot) => html`
                <div class="pick-tile">
                  <img src="${onSite(data.candidate.site_domain, data.images[shot.key])}"
                       alt="${shot.label}" loading="lazy">
                  <span class="pick-label">${shot.label}</span>
                </div>`,
            )}
          </div>
        </div>

        <div>
          <div class="card">
            <h2>Where it goes</h2>
            ${data.page
              ? html`
                  <p>
                    <strong>${data.page.name || data.page.page_id}</strong>
                  </p>
                  <p class="help">
                    The page for ${data.candidate.seed_keyword}.
                    ${data.page.auto_publish === 1
                      ? raw('It publishes automatically once the reel is ready.')
                      : raw('It will be held for you to review.')}
                  </p>`
              : html`<div class="flash warn">
                  No page has the niche <strong>${data.candidate.seed_keyword}</strong>. The
                  reel will be made and then wait.
                  <a href="/settings/facebook">Assign one</a> to send it somewhere.
                </div>`}
          </div>

          <div class="card">
            <div class="field">
              <label for="reel-caption">Caption</label>
              <textarea id="reel-caption" name="caption" rows="6"
                        data-caption-url="/reels/new/${data.candidate.run_id}/caption">${data.caption}</textarea>
              <p class="help" id="reel-caption-help">Writing a caption… the title is there meanwhile. The link goes in the first comment, not here.</p>
            </div>
          </div>
        </div>
      </div>

      <div class="save-bar">
        <button class="primary" type="submit">Make the reel</button>
        <a class="button" href="/reels">Cancel</a>
        <span class="muted small">The storyboard is written first, then each scene is filmed. Ten minutes or so.</span>
      </div>
    </form>
    ${raw(REEL_CAPTION_SCRIPT)}
  `;
}

/**
 * Fill the caption in once the model has written it.
 *
 * Fetched after the page is up rather than rendered into it: the model takes
 * anywhere from two seconds to twenty and is sometimes down, and a page that
 * waited on it sat past Cloudflare's hundred seconds and answered 524. Only the
 * untouched box is replaced -- anyone who has started typing keeps what they
 * wrote.
 */
const REEL_CAPTION_SCRIPT = `<script>
(function () {
  var box = document.getElementById('reel-caption');
  var help = document.getElementById('reel-caption-help');
  if (!box || !box.dataset.captionUrl) return;

  var initial = box.value;
  var done = function (text) {
    if (help) help.textContent = text;
  };

  fetch(box.dataset.captionUrl, { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { caption: null }; })
    .then(function (body) {
      if (body && body.caption && box.value === initial) {
        box.value = body.caption;
        done('Written by the model. Edit it as you like. The link goes in the first comment, not here.');
      } else if (body && body.caption) {
        done('A caption was written, but you had already started typing, so yours was kept.');
      } else {
        done('The model did not answer, so the title is there to start from. The link goes in the first comment, not here.');
      }
    })
    .catch(function () {
      done('The model did not answer, so the title is there to start from. The link goes in the first comment, not here.');
    });
})();
</script>`;

/* =========================================================================
 * Settings -> Facebook
 * ====================================================================== */

export interface FacebookSettingsData {
  enabled: boolean;
  tokens: FbTokenView[];
  pages: FbPageRow[];
  groups: string[];
  presenters: PresenterRow[];
}

/**
 * Two tables and nothing else.
 *
 * Tokens bring pages; a page takes a niche. The routing table this replaced
 * asked three questions per row -- which site, which niche, which page --
 * with a wildcard for two of them, and a person setting up one page for one
 * niche had to work out which of the four combinations they meant. Now the
 * page row asks one question, and the answer is in the row.
 */

export interface PresentersData {
  presenters: PresenterRow[];
  /** Page names per presenter id, for "used by". */
  usedBy: Map<number, string[]>;
}

/** Setup → Presenters: the people who appear in reels. */
export function presentersPage(data: PresentersData): Html {
  return html`
    <h1>Presenters</h1>
    <p class="subtitle">
      A presenter is a character you made in Google Flow, with a voice. Reels on a page
      that has one show them on screen and let them speak. Make the character and the
      voice in Flow first (Setup &rarr; Browser), then add them here.
    </p>

    <h2>Add a presenter</h2>
    <div class="card">
      <form method="post" action="/settings/presenters">
        <div class="field-row">
          <div class="field">
            <label for="presenter-name">Name</label>
            <input type="text" id="presenter-name" name="name" required placeholder="Rima" />
            <div class="help">What you call them. It goes into the clip prompts as who is speaking.</div>
          </div>
          <div class="field">
            <label for="presenter-voice-description">How they sound</label>
            <input type="text" id="presenter-voice-description" name="voice_description"
                   placeholder="warm, unhurried, mid-thirties" />
            <div class="help">
              A few words. The same words go into every scene so the delivery stays the same.
            </div>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="presenter-character">Character</label>
            <input type="text" id="presenter-character" name="character" required
                   placeholder="https://flow.google.com/u/0/project/…/character/…" />
            <div class="help">
              In Flow, open the character. The address bar ends in
              <span class="mono">/character/&lt;id&gt;</span>: paste the whole address, or just the id.
            </div>
          </div>
          <div class="field">
            <label for="presenter-voice">Voice</label>
            <input type="text" id="presenter-voice" name="voice"
                   placeholder="paste the voice's address or id" />
            <div class="help">
              In Flow, open the voice you made for them and paste its address the same way.
              Leave empty for a presenter who does not speak.
            </div>
          </div>
        </div>
        <button class="primary" type="submit">Add presenter</button>
      </form>
    </div>

    <h2>Presenters</h2>
    ${data.presenters.length === 0
      ? html`<div class="card">${emptyState('No presenters yet. Reels show the dish only until there is one.')}</div>`
      : html`<div class="card table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>How they sound</th><th>Character</th><th>Voice</th><th>Used by</th><th></th></tr>
            </thead>
            <tbody>
              ${data.presenters.map((p) => {
                const formId = `presenter-${p.id}`;
                const pages = data.usedBy.get(p.id) ?? [];
                return html`<tr>
                  <td><input type="text" name="name" form="${formId}" value="${p.name}" /></td>
                  <td><input type="text" name="voice_description" form="${formId}" value="${p.voice_description}" /></td>
                  <td class="mono small">${p.flow_character_id}</td>
                  <td class="mono small">${p.flow_voice_id || html`<span class="muted">none</span>`}</td>
                  <td class="small">${pages.length ? pages.join(', ') : html`<span class="muted">no page yet</span>`}</td>
                  <td class="nowrap">
                    <form method="post" action="/settings/presenters/${p.id}" id="${formId}">
                      <button type="submit" class="small">Save</button>
                    </form>
                    <form method="post" action="/settings/presenters/${p.id}/delete"
                          onsubmit="return confirm('Remove ${p.name}? Pages using them go back to dish-only reels.')">
                      <button type="submit" class="small danger">Remove</button>
                    </form>
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>`}
  `;
}

export function facebookSettingsPage(data: FacebookSettingsData): Html {
  const tokenName = new Map(data.tokens.map((t) => [t.id, t.name]));

  return html`
    <h1>Facebook</h1>
    <p class="subtitle">
      Add a token, pick a niche for each page it brings, and every article in that niche
      becomes a reel on that page.
    </p>

    ${data.enabled
      ? raw('')
      : html`<div class="flash warn">
          Reels are switched off. Turn on <em>Publish reels to Facebook</em> under
          <a href="/settings">Settings</a> when the pages below are ready.
        </div>`}

    <div class="card">
      <h2>Tokens</h2>
      <p class="help">
        One per app. The platform reads every page the token can manage; you never type a
        page id. A token from Business Settings &rarr; System Users does not expire.
        Removing a token removes its pages.
      </p>

      ${data.tokens.length === 0
        ? emptyState('No token yet. Add one below and its pages appear.')
        : html`<div class="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Pages</th><th>Last checked</th><th></th></tr>
              </thead>
              <tbody>
                ${data.tokens.map(
                  (t) => html`<tr>
                    <td>
                      ${t.name}
                      ${t.last_error
                        ? html`<div class="small error">${t.last_error}</div>`
                        : raw('')}
                    </td>
                    <td>${t.page_count}</td>
                    <td class="small muted nowrap">
                      ${t.last_synced_at ? timeAgo(t.last_synced_at) : 'never'}
                    </td>
                    <td class="nowrap">
                      <form method="post" action="/settings/facebook/tokens/${t.id}/refresh"
                            style="display:inline">
                        <button type="submit" class="small">Refresh</button>
                      </form>
                      <form method="post" action="/settings/facebook/tokens/${t.id}/delete"
                            style="display:inline"
                            onsubmit="return confirm('Remove this token and its ${t.page_count} page(s)?')">
                        <button type="submit" class="small danger">Remove</button>
                      </form>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}

      <form method="post" action="/settings/facebook/tokens" class="stack" style="margin-top:1rem">
        <div class="grid two">
          <div class="field">
            <label for="fb-token-name">Name</label>
            <input id="fb-token-name" name="name" placeholder="App 1" />
          </div>
          <div class="field">
            <label for="fb-token">Token</label>
            <input id="fb-token" name="token" type="password" required autocomplete="off" />
          </div>
        </div>
        <div><button type="submit" class="primary">Add token</button></div>
      </form>
    </div>

    <div class="card">
      <h2>Pages</h2>
      <p class="help">
        One niche per page. A page with no niche is left alone. With auto-publish off, a
        reel waits on the <a href="/reels">Reels</a> page for you to publish it.
      </p>

      ${data.pages.length === 0
        ? emptyState('No pages. They arrive with a token.')
        : html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Page</th><th>Niche</th><th>Presenter</th><th>Auto-publish</th><th>Enabled</th>
                  <th>Last</th><th></th>
                </tr>
              </thead>
              <tbody>
                ${data.pages.map((p) => {
                  const formId = `fb-page-${p.id}`;
                  return html`<tr>
                    <td>
                      ${p.name || p.page_id}
                      <div class="small muted">
                        ${p.page_id}
                        ${p.token_id && tokenName.get(p.token_id)
                          ? html`&middot; ${tokenName.get(p.token_id)}`
                          : raw('')}
                      </div>
                    </td>
                    <td>
                      <select name="niche" form="${formId}">
                        <option value="">not used</option>
                        ${data.groups.map(
                          (g) => html`<option value="${g}"
                            ${p.niche && g.toLowerCase() === p.niche.toLowerCase()
                              ? raw('selected')
                              : raw('')}>${g}</option>`,
                        )}
                      </select>
                      ${p.niche && !data.groups.some((g) => g.toLowerCase() === p.niche!.toLowerCase())
                        ? html`<div class="small error">
                            Set to &ldquo;${p.niche}&rdquo;, which no keyword has any more.
                          </div>`
                        : raw('')}
                    </td>
                    <td>
                      <select name="presenter_id" form="${formId}">
                        <option value="">no presenter — dish only</option>
                        ${data.presenters.map(
                          (pr) => html`<option value="${pr.id}"
                            ${p.presenter_id === pr.id ? raw('selected') : raw('')}>${pr.name}</option>`,
                        )}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" name="autoPublish" form="${formId}"
                             ${p.auto_publish === 1 ? raw('checked') : raw('')} />
                    </td>
                    <td>
                      <input type="checkbox" name="enabled" form="${formId}"
                             ${p.enabled === 1 ? raw('checked') : raw('')} />
                    </td>
                    <td class="small">
                      ${p.last_used_at
                        ? html`<span class="muted nowrap">${timeAgo(p.last_used_at)}</span>`
                        : html`<span class="muted">&mdash;</span>`}
                      ${p.last_error ? html`<div class="error">${p.last_error}</div>` : raw('')}
                    </td>
                    <td class="nowrap">
                      <form method="post" action="/settings/facebook/pages/${p.id}" id="${formId}">
                        <button type="submit" class="small">Save</button>
                      </form>
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>`}
    </div>
  `;
}
