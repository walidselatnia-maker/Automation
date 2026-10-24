import { html, raw, type Html } from '../web/views/layout.js';
import type { NewWebsiteRow } from './repo.js';
import { PHASES, stateOf, type Origin, type ResearchRow, type ResearchState } from './research.js';
import { PROVIDERS, type SearchKeyRow } from './search-keys.js';

/**
 * Content research pages: the projects, one project's plan as a tree, and the
 * search keys' part of Platform settings. Plain: buttons and the data.
 */

const CSS = `
.rs-box { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); padding: 18px 22px; margin: 0 0 18px; }
.rs-box h2 { font-size: 17px; margin: 0 0 12px; }
.rs-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 10px 0; border-top: 1px solid var(--line); }
.rs-row:first-of-type { border-top: 0; }
.rs-row .grow { flex: 1; min-width: 200px; }
.rs-row b { font-weight: 600; }
.rs-soft { color: var(--soft); font-size: 14px; }
.rs-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.rs-form label { display: grid; gap: 4px; font-size: 13px; font-weight: 600; color: var(--soft); }
.rs-form input, .rs-form select, .rs-tree input[type=text], .rs-tree select, .rs-keys textarea { height: 38px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--page); color: var(--ink); font: inherit; }
.rs-form input { min-width: 280px; }
.rs-keys textarea { width: 100%; height: 90px; margin-top: 10px; padding: 10px; font: 13px/1.5 var(--mono); }
.rs-counts { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 0 0 16px; font-size: 14px; color: var(--soft); }
.rs-counts b { color: var(--ink); font-variant-numeric: tabular-nums; }
.rs-error { margin: 0 0 16px; padding: 12px 16px; border: 1px solid var(--bad); border-left-width: 4px; border-radius: var(--r-ctl); background: var(--bad-tint); color: var(--ink); }
.rs-tree { display: grid; gap: 14px; }
.rs-pillar { border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: var(--r-card); padding: 12px 16px; background: var(--surface); }
.rs-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.rs-line input[type=text] { flex: 1; min-width: 220px; }
.rs-pillar > .rs-line input[type=text] { font-weight: 700; }
.rs-subs { list-style: none; margin: 10px 0 0; padding: 0 0 0 22px; display: grid; gap: 6px; border-left: 2px solid var(--line); }
.rs-tag { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.rs-tag.real { background: var(--good-tint); color: var(--good); }
.rs-tag.ai { background: var(--idle); color: var(--idle-ink); }
.rs-tag.yours { background: var(--raised); color: var(--soft); }
.rs-remove { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--soft); }
.rs-status { font-weight: 600; font-size: 14px; }
.rs-status.failed { color: var(--bad); }
.rs-status.working { color: var(--good); }
.rs-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.rs-progress { list-style: none; margin: 0 0 18px; padding: 14px 18px; display: grid; gap: 8px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); counter-reset: rs; }
.rs-progress li { counter-increment: rs; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; color: var(--faint); font-size: 14px; }
.rs-progress li::before { content: counter(rs); display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line-strong); font-size: 12px; font-weight: 700; }
.rs-progress li.done { color: var(--soft); }
.rs-progress li.done::before { content: '✓'; background: var(--good-tint); color: var(--good); border-color: var(--good); }
.rs-progress li.now { color: var(--ink); }
.rs-progress li.now::before { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.rs-dropped summary { cursor: pointer; font-size: 14px; color: var(--soft); }
.rs-dropped ul { margin: 8px 0 0; padding-left: 18px; font-size: 13px; color: var(--soft); }
`;

const STATUS: Record<string, string> = {
  new: 'Waiting to start',
  fetching: 'Reading Google',
  grouping: 'The AI is grouping',
  ready: 'Ready to review',
  failed: 'Stopped',
  approved: 'Approved',
};

const TAG: Record<Origin, string> = { real: 'Google', ai: 'AI', yours: 'Yours' };
const tag = (o: Origin): Html => html`<span class="rs-tag ${o}" title="${o === 'real' ? 'Real search data' : o === 'ai' ? 'Made by the AI' : 'Typed by you'}">${TAG[o]}</span>`;

const callsMade = (s: ResearchState): number => Object.values(s.made).reduce((a, b) => a + b, 0);

function counts(s: ResearchState): Html {
  const subs = s.plan.reduce((n, p) => n + p.subs.length, 0);
  const real = s.plan.reduce((n, p) => n + [p, ...p.subs].filter((k) => k.origin === 'real').length, 0);
  return html`<div class="rs-counts">
    <span>Search calls <b>${String(callsMade(s))}</b></span>
    <span>Google searches found <b>${String(s.found.length)}</b></span>
    <span>Already on the website <b>${String(s.dropped.length)}</b></span>
    ${s.plan.length ? html`<span>Pillars <b>${String(s.plan.length)}</b></span><span>Sub-articles <b>${String(subs)}</b></span><span>From Google <b>${String(real)}</b> of ${String(s.plan.length + subs)}</span>` : raw('')}
  </div>`;
}

/** The projects, and a new one: a website and a niche or topic, then Discover topics. Without a working search key, the key line instead. */
export function researchListPage(rows: ResearchRow[], sites: NewWebsiteRow[], keys: Html = raw(''), canSearch = true): Html {
  const name = new Map(sites.map((s) => [s.id, s.name]));
  return html`<style>${raw(CSS)}</style>
    <div class="ns-head"><div><h1 class="ns-title">Content research</h1></div></div>
    ${canSearch ? keys : raw('')}
    <div class="rs-box">
      <h2>New research</h2>
      ${!sites.length
        ? html`<p class="rs-soft">Add a website first.</p>`
        : !canSearch
          ? keys
          : html`<form class="rs-form" method="post" action="/new-website/research">
            <label>Website<select name="website">${sites.map((s) => html`<option value="${String(s.id)}">${s.name}</option>`)}</select></label>
            <label>Niche or topic<input name="topic" required maxlength="120" placeholder="sourdough bread" /></label>
            <button class="ns-btn primary">Discover topics</button>
          </form>`}
    </div>
    <div class="rs-box">
      <h2>Projects</h2>
      ${rows.length
        ? rows.map((r) => {
            const s = stateOf(r);
            return html`<div class="rs-row"><div class="grow"><b>${r.topic}</b> <span class="rs-soft">· ${name.get(r.website_id) ?? 'Website gone'}</span></div>
              <span class="rs-status ${r.status}">${STATUS[r.status] ?? r.status}</span>
              <span class="rs-soft">${String(s.found.length)} searches · ${String(s.plan.length)} pillars</span>
              <a class="ns-btn small quiet" href="/new-website/research/${String(r.id)}">Open</a></div>`;
          })
        : html`<p class="rs-soft">None yet.</p>`}
    </div>`;
}

/** The steps of a running research: done, the one under way (with what it is doing), and the ones to come. */
function progress(s: ResearchState): Html {
  const at = s.progress?.phase ?? 1;
  return html`<ol class="rs-progress" role="status">${PHASES.map((p, i) => {
    const n = i + 1;
    const cls = n < at ? 'done' : n === at ? 'now' : '';
    return html`<li class="${cls}"><b>${p}</b>${n === at && s.progress?.text ? html` <span class="rs-soft">${s.progress.text}</span>` : raw('')}</li>`;
  })}</ol>`;
}

export function researchPage(r: ResearchRow, site: NewWebsiteRow | undefined, busy: boolean, keys: Html = raw('')): Html {
  const s = stateOf(r);
  const working = busy || r.status === 'fetching' || r.status === 'grouping';
  const options = s.plan.map((p, i) => ({ i, name: p.pillar }));
  const moveTo = (name: string, at: number): Html =>
    html`<select name="${name}" aria-label="Pillar">${options.map((o) => html`<option value="${String(o.i)}" ${raw(o.i === at ? 'selected' : '')}>${o.name}</option>`)}</select>`;
  const editable = r.status === 'ready';
  return html`<style>${raw(CSS)}</style>
    ${working ? raw('<meta http-equiv="refresh" content="3">') : raw('')}
    <div class="ns-head"><div><h1 class="ns-title">${r.topic}</h1><p class="ns-lede">${site?.name ?? 'Website gone'} · ${STATUS[r.status] ?? r.status}</p></div>
      <a class="ns-btn quiet" href="/new-website/research">Back</a></div>
    ${working ? progress(s) : raw('')}
    ${counts(s)}
    ${s.error ? html`<p class="rs-error" role="alert">${s.error}</p>` : raw('')}
    ${r.status === 'failed' ? keys : raw('')}
    ${!working && (r.status === 'failed' || r.status === 'new')
      ? html`<form method="post" action="/new-website/research/${String(r.id)}/run" class="rs-actions" style="justify-content:flex-start"><button class="ns-btn primary">Resume</button></form>`
      : raw('')}
    ${s.approved
      ? html`<div class="rs-box"><b>${String(s.approved.plans)} pillars went into the Keywords list.</b>
          ${s.approved.skipped.map((x) => html`<p class="rs-soft">${x}</p>`)}
          <p><a class="ns-btn small quiet" href="/new-website/keywords">Open Keywords</a></p></div>`
      : raw('')}
    ${s.plan.length
      ? html`<form method="post" action="/new-website/research/${String(r.id)}/plan">
          <div class="rs-tree">${s.plan.map(
            (p, i) => html`<div class="rs-pillar">
              <div class="rs-line">${tag(p.origin)}
                <input type="text" name="p-${String(i)}" value="${p.pillar}" aria-label="Pillar" ${raw(editable ? '' : 'readonly')} />
                <input type="hidden" name="page-${String(i)}" value="${p.page}" />
                ${editable ? html`<label class="rs-remove"><input type="checkbox" name="rp-${String(i)}" value="1" /> Remove</label>` : raw('')}
              </div>
              <ul class="rs-subs">${p.subs.map(
                (sub, j) => html`<li class="rs-line">${tag(sub.origin)}
                  <input type="text" name="s-${String(i)}-${String(j)}" value="${sub.keyword}" aria-label="Sub-article" ${raw(editable ? '' : 'readonly')} />
                  ${editable ? html`${moveTo(`m-${i}-${j}`, i)}<label class="rs-remove"><input type="checkbox" name="rs-${String(i)}-${String(j)}" value="1" /> Remove</label>` : raw('')}
                </li>`,
              )}
              ${editable ? html`<li class="rs-line"><input type="text" name="new-${String(i)}" placeholder="Add a sub-article" aria-label="Add a sub-article" /></li>` : raw('')}</ul>
            </div>`,
          )}</div>
          ${editable
            ? html`<div class="rs-actions">
                <button class="ns-btn">Save changes</button>
                <button class="ns-btn primary" formaction="/new-website/research/${String(r.id)}/approve">Approve</button>
              </div>`
            : raw('')}
        </form>`
      : raw('')}
    ${s.left.length
      ? html`<details class="rs-dropped rs-box"><summary>${String(s.left.length)} left out of the plan</summary>
          <ul>${s.left.slice(0, 200).map((d) => html`<li>${d.keyword}: ${d.reason}</li>`)}</ul></details>`
      : raw('')}
    ${s.dropped.length
      ? html`<details class="rs-dropped rs-box"><summary>${String(s.dropped.length)} searches left out: the website has them</summary>
          <ul>${s.dropped.slice(0, 200).map((d) => html`<li>${d.keyword}: ${d.reason}</li>`)}</ul></details>`
      : raw('')}
    <form method="post" action="/new-website/research/${String(r.id)}/delete" class="rs-actions"><button class="ns-btn small danger">Delete project</button></form>`;
}

const when = (ms: number): string => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never');

/** The search keys, in Platform settings: the order they are tried in, and the box to add more. */
export function searchKeysSection(keys: SearchKeyRow[], hint: (k: SearchKeyRow) => string): Html {
  const label = (p: string) => PROVIDERS.find((x) => x.key === p)?.label ?? p;
  const base = '/new-website/platform/search-keys';
  return html`<style>${raw(CSS)}</style>
    <section class="pf-group rs-keys" id="search-keys">
      <div><h2>Search keys</h2><span class="pf-state ${keys.some((k) => k.status !== 'failed') ? 'ok' : 'bad'}">${keys.length
        ? `${keys.filter((k) => k.status !== 'failed').length} of ${keys.length} working`
        : 'No key'}</span></div>
      <div class="pf-wide">
        ${keys.map(
          (k, i) => html`<div class="rs-row"><b>${String(i + 1)}</b>
            <div class="grow">${label(k.provider)} <span class="rs-soft">${hint(k)}</span></div>
            <span class="rs-status ${k.status}">${k.status === 'working' ? 'Working' : k.status === 'failed' ? `Failed: ${k.error}` : 'Not tried yet'}</span>
            <span class="rs-soft">Last checked ${when(k.checked_at)}</span>
            <form method="post" action="${base}/${String(k.id)}/up"><button class="ns-btn small quiet" ${raw(i === 0 ? 'disabled' : '')}>Up</button></form>
            <form method="post" action="${base}/${String(k.id)}/down"><button class="ns-btn small quiet" ${raw(i === keys.length - 1 ? 'disabled' : '')}>Down</button></form>
            <form method="post" action="${base}/${String(k.id)}/delete"><button class="ns-btn small danger">Remove</button></form>
          </div>`,
        )}
        <form method="post" action="${base}">
          <textarea name="keys" spellcheck="false" aria-label="Search keys" placeholder="One key per line. Serper.dev keys as they are; a SerpAPI key as serpapi: KEY"></textarea>
          <div class="rs-actions">
            ${keys.length ? html`<button class="ns-btn" formaction="${base}/check">Check all keys</button>` : raw('')}
            <button class="ns-btn primary">Add</button>
          </div>
        </form>
      </div>
    </section>`;
}
