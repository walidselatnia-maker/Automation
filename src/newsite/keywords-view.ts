import { html, raw, type Html } from '../web/views/layout.js';
import type { KeywordPlan, NewWebsiteRow } from './repo.js';
import { DESCRIPTION, TITLE, type SeoRow } from './seo.js';
import { articleTypeFor, parseSkeleton, totalWords, type Skeleton } from './skeleton.js';
import { parseRecipe } from './recipe.js';
import { markdownToHtml } from './markdown.js';
import { parseImageSet } from './images.js';
import { WIZARD_CSS } from './view.js';

const INTENT_LABEL: Record<string, string> = {
  diet: 'Diet',
  method: 'Method',
  format: 'Format',
  flavor: 'Flavor',
  ingredient: 'Ingredient',
  time: 'Time',
  info: 'Know-how',
  yours: 'Added by you',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (createdAt: string): string => {
  const [y, m, d] = createdAt.slice(0, 10).split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : createdAt;
};

const CSS = `
.kw-site { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; color: var(--soft); font-size: 14px; }
.kw-site select { height: 36px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl);
  background: var(--surface); color: var(--ink); font: 500 14px var(--body); }
.kw-site strong { color: var(--ink); }
#kw-find label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
.kw-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; }
.kw-row input { height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--r-ctl);
  background: var(--surface); color: var(--ink); font: 15px var(--body); min-width: 0; }
.kw-row input:hover { border-color: var(--line-strong); }
.kw-row input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
.kw-row .ns-btn { height: 44px; }
.kw-hint { color: var(--faint); font-size: 13px; margin-top: 8px; }
.kw-error { color: var(--bad); font-size: 14px; font-weight: 500; margin-top: 12px; }
.kw-error:empty { display: none; }
.kw-status { color: var(--soft); font-size: 14px; margin-top: 12px; }
.kw-status:empty { display: none; }

.kw-result { margin-top: 32px; }
.kw-result[hidden] { display: none; }
.kw-result-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 4px; }
.kw-result-head h2 { font-size: 22px; }
.kw-count { color: var(--soft); font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.kw-source { color: var(--soft); font-size: 14px; margin: 0 0 16px; }
.kw-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.kw-item { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: start; padding: 16px 0; border-bottom: 1px solid var(--line); }
.kw-item b { font-weight: 600; font-size: 16px; }
.kw-intent { display: inline-block; margin-left: 10px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); }
.kw-why { color: var(--soft); font-size: 14px; margin-top: 4px; }
.kw-page { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.kw-page-chip { height: 28px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line-strong); background: var(--surface);
  color: var(--ink); font: 600 12px var(--body); cursor: pointer; }
.kw-page-chip.recipe { border-color: var(--good); color: var(--good); }
.kw-page-chip:hover { background: var(--raised); }
.kw-page-why { color: var(--faint); font-size: 13px; }
.kw-pillar-page { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: -4px 0 16px; padding: 12px 14px; background: var(--raised); border-radius: var(--r-ctl); }
.kw-pillar-page[hidden] { display: none; }
.kw-pillar-page .kw-page { margin-top: 0; }
.kw-pillar-label { font-weight: 600; font-size: 14px; }
.kw-remove { height: 32px; padding: 0 10px; font-size: 13px; }
.kw-remove:hover { color: var(--bad); background: var(--accent-tint); }
.kw-empty { color: var(--soft); padding: 16px 0; border-bottom: 1px solid var(--line); }
.kw-add { margin-top: 20px; }
.kw-add label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
.kw-dropped { margin-top: 24px; }
.kw-dropped summary { cursor: pointer; color: var(--soft); font-weight: 600; font-size: 14px; padding: 4px 0; }
.kw-dropped summary:hover { color: var(--ink); }
.kw-dropped ul { list-style: none; margin: 8px 0 0; padding: 0; }
.kw-dropped li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 14px; }
.kw-dropped li span:last-child { color: var(--soft); }
.kw-save { display: flex; justify-content: flex-end; align-items: center; gap: 16px; margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); }

.kw-plans { margin-top: 56px; }
.kw-plans > h2 { font-size: 20px; margin-bottom: 16px; }
.kw-plan { padding: 20px 0; border-top: 1px solid var(--line); }
.kw-plan-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.kw-plan h3 { font-size: 18px; }
.kw-plan-meta { color: var(--soft); font-size: 14px; margin-top: 2px; }
.kw-plan form { margin: 0; }
.kw-none { color: var(--soft); }
.kw-plain { margin: 12px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.kw-plain li { display: grid; grid-template-columns: 110px 1fr; gap: 12px; font-size: 15px; }
.kw-plain li span { color: var(--soft); font-size: 13px; padding-top: 1px; }
.kw-seo-list { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 12px; }
.kw-seo { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 18px 20px; }
.kw-seo-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.kw-seo-head b { font-weight: 600; }
.kw-seo-role { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); min-width: 84px; }
.kw-seo-status { margin-left: auto; font-size: 13px; font-weight: 600; color: var(--faint); }
.kw-seo-status.done { color: var(--good); }
.kw-seo-status.failed { color: var(--bad); }
.kw-seo-status.writing { color: var(--ink); }
.kw-serp { margin: 14px 0 0; padding: 14px 16px; border-left: 3px solid var(--line-strong); background: var(--raised); }
.kw-serp-title { color: #1a0dab; font-size: 18px; line-height: 1.3; }
:root.dark .kw-serp-title { color: #8ab4f8; }
.kw-serp-desc { color: var(--soft); font-size: 14px; margin-top: 4px; }
.kw-seo-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 32px; margin: 14px 0 0; }
.kw-seo-facts div { display: grid; grid-template-columns: 120px 1fr; gap: 12px; }
.kw-seo-facts div.wide { grid-column: 1 / -1; }
.kw-seo-facts dt { color: var(--soft); font-size: 13px; }
.kw-seo-facts dd { margin: 0; font-size: 14px; }
.kw-seo-facts dd.off { color: var(--bad); font-weight: 600; }
.kw-seo-problems { margin-top: 12px; color: var(--bad); font-size: 14px; display: grid; gap: 2px; }
.kw-seo-retry { margin-top: 10px; display: flex; justify-content: flex-end; }
.kw-skel { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
.kw-skel summary { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; font-weight: 600; color: var(--ink); }
.kw-skel summary .ns-num { font-weight: 400; color: var(--soft); }
.kw-skel-h1 { margin: 14px 0 8px; font: 600 15px var(--display); }
.kw-skel-list { margin: 0; padding-left: 20px; display: grid; gap: 12px; }
.kw-skel-h2 { display: flex; justify-content: space-between; gap: 16px; font-size: 14px; }
.kw-skel-h2 .ns-num { color: var(--faint); font-size: 13px; white-space: nowrap; }
.kw-skel-covers { color: var(--soft); font-size: 13px; margin-top: 2px; }
.kw-skel ul { margin: 4px 0 0; padding-left: 18px; color: var(--soft); font-size: 13px; }
.kw-skel-h3s { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 6px; }
.kw-recipe { border-top: 1px solid var(--line); padding-top: 14px; }
.kw-recipe-facts { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 0 0 16px; }
.kw-recipe-facts dt { color: var(--soft); font-size: 12px; }
.kw-recipe-facts dd { margin: 2px 0 0; font-weight: 600; font-size: 14px; }
.kw-recipe-facts dd.cap { text-transform: capitalize; }
.kw-recipe-cols { display: grid; grid-template-columns: 2fr 3fr; gap: 28px; }
.kw-recipe h4 { font: 600 15px var(--display); margin: 0 0 8px; }
.kw-recipe-group { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--soft); margin: 10px 0 4px; }
.kw-recipe ul, .kw-recipe ol { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 14px; }
.kw-recipe-foot { margin-top: 16px; color: var(--soft); font-size: 13px; }
.kw-recipe-notes { margin-top: 8px; font-size: 14px; color: var(--soft); }
.kw-recipe-notes b { color: var(--ink); margin-right: 6px; }
.kw-img-theme { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 20px; margin: 0 0 18px;
  padding: 14px 16px; background: var(--raised); border-radius: var(--r-ctl); }
.kw-img-theme dt { color: var(--soft); font-size: 12px; }
.kw-img-theme dd { margin: 2px 0 0; font-size: 14px; }
.kw-img-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 0; border-top: 1px solid var(--line); }
.kw-img-list li { padding: 14px 0; border-bottom: 1px solid var(--line); }
.kw-img-slot { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); }
.kw-img-prompt { margin: 6px 0 8px; font-size: 14px; line-height: 1.6; max-width: 72ch; }
.kw-img-alt { color: var(--soft); font-size: 13px; }
.kw-img-alt b { color: var(--ink); margin-right: 6px; }
.kw-article { border-top: 1px solid var(--line); padding-top: 18px; max-width: 68ch; overflow-wrap: anywhere; font-size: 16px; line-height: 1.7; }
.kw-article h1 { font-size: 26px; line-height: 1.2; margin: 0 0 16px; }
.kw-article h2 { font-size: 21px; margin: 28px 0 10px; }
.kw-article h3 { font-size: 17px; margin: 20px 0 8px; }
.kw-article p { margin: 0 0 14px; }
.kw-article ul, .kw-article ol { margin: 0 0 14px; padding-left: 22px; display: grid; gap: 4px; }
/* Steps: the wizard card, wider for lists. */
.wz.kw-wz { max-width: 820px; }
.kw-wz .wz-bar { grid-template-columns: repeat(4, 1fr); }
.kw-steps-names { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 8px; font-size: 12px; font-weight: 600; opacity: .75; }
.kw-steps-names span.on { opacity: 1; }
.wz-foot a.ns-btn.disabled { pointer-events: none; opacity: .5; }

/* Saved plans under step 1: a compact list, each opening its steps. */
.kw-saved { max-width: 820px; margin: 40px auto 0; }
.kw-saved > h2 { font-size: 20px; margin-bottom: 12px; }
.kw-saved-row { display: grid; grid-template-columns: 1fr auto auto; gap: 16px; align-items: center; padding: 16px 0; border-top: 1px solid var(--line); }
.kw-saved-row a.kw-open { text-decoration: none; }
.kw-saved-row a.kw-open b { font: 600 17px var(--display); }
.kw-saved-row a.kw-open:hover b { color: var(--accent); }
.kw-saved-meta { color: var(--soft); font-size: 14px; margin-top: 2px; }

/* Keyword cards that open and close. */
.acc-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.acc { border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); }
.acc.open { border-color: var(--line-strong); }
.acc-head { width: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 16px 18px; background: none; border: 0;
  color: var(--ink); font: inherit; text-align: left; cursor: pointer; border-radius: var(--r-card); }
.acc-head:hover { background: var(--raised); }
.acc-head b { font-weight: 600; flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.acc-chev { width: 18px; height: 18px; flex: none; color: var(--soft); transition: transform .25s ease; }
.acc.open .acc-chev { transform: rotate(180deg); }
.acc-panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .28s ease; }
.acc.open .acc-panel { grid-template-rows: 1fr; }
.acc-inner { overflow: hidden; }
.acc-body { padding: 0 18px 18px; }
.acc-head .kw-seo-status { margin-left: 0; }
@media (prefers-reduced-motion: reduce) { .acc-panel, .acc-chev { transition: none; } }

@media (max-width: 640px) {
  .kw-saved-row { grid-template-columns: 1fr; gap: 8px; }
  .kw-recipe-facts { grid-template-columns: repeat(3, 1fr); }
  .kw-recipe-cols { grid-template-columns: 1fr; }
  .kw-row { grid-template-columns: 1fr; }
  .kw-dropped li, .kw-plain li, .kw-seo-facts, .kw-seo-facts div { grid-template-columns: 1fr; gap: 2px; }
}
`;

/** The steps of a plan. Recipe websites get the fixed recipe before the skeleton. */
const stepNames = (niche: string): string[] =>
  articleTypeFor(niche) === 'recipe'
    ? ['Keywords', 'SEO', 'Recipe', 'Skeleton', 'Article', 'Images']
    : ['Keywords', 'SEO', 'Skeleton', 'Article', 'Images'];

const CHEVRON = '<svg class="acc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/** The wizard card every step shares: header with progress, body, and a footer with Previous / Next. */
function stepCard(names: string[], step: number, title: string, subtitle: Html | string, body: Html, foot: Html): Html {
  return html`
    <div class="wz kw-wz">
      <div class="wz-head">
        <h1>${title}</h1>
        <p class="wz-id">${subtitle}</p>
        <div class="wz-bar" style="grid-template-columns:repeat(${names.length},1fr)">${names.map((_, i) => html`<i class="${i <= step ? 'on' : ''}"></i>`)}</div>
        <div class="kw-steps-names" style="grid-template-columns:repeat(${names.length},1fr)">${names.map(
          (n, i) => html`<span class="${i === step ? 'on' : ''}">${i + 1}. ${n}</span>`,
        )}</div>
      </div>
      <div class="wz-body">${body}</div>
      <div class="wz-foot">${foot}</div>
    </div>`;
}

const planHref = (planId: number, step: 'seo' | 'recipe' | 'skeleton' | 'article' | 'images'): string => `/new-website/keywords/plan/${planId}/${step}`;

/** How far a plan has got, in one line. */
const progress = (rows: SeoRow[]): string => {
  if (!rows.length) return 'SEO not started';
  const seo = rows.filter((r) => r.status === 'done').length;
  const recipes = rows.filter((r) => r.recipe_status === 'done').length;
  const sk = rows.filter((r) => r.skeleton_status === 'done').length;
  const articles = rows.filter((r) => r.article_status === 'done').length;
  const images = rows.filter((r) => r.images_status === 'done').length;
  return `SEO ${seo}/${rows.length}${recipes ? ` · Recipes ${recipes}/${rows.length}` : ''} · Skeletons ${sk}/${rows.length} · Articles ${articles}/${rows.length} · Images ${images}/${rows.length}`;
};

/** Step 1: pick the website, find sub-keywords, save the plan. Saved plans are listed below. */
export function keywordsPage(
  websites: NewWebsiteRow[],
  current: NewWebsiteRow | undefined,
  plans: KeywordPlan[],
  seo: Map<number, SeoRow[]> = new Map(),
): Html {
  if (!current) {
    return html`<style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
      <div class="nl-empty" style="border:1px dashed var(--line-strong);border-radius:var(--r-card);padding:56px 32px;text-align:center;max-width:820px;margin:0 auto">
        <h2 style="font-size:22px;margin-bottom:8px">Add a website first</h2>
        <p style="color:var(--soft);margin:0 0 24px">Keywords are planned for one website at a time.</p>
        <a class="ns-btn primary" href="/new-website/add">Add website</a>
      </div>`;
  }

  const body = html`
    <h2>Pillar and sub-keywords</h2>
    <p>One pillar keyword and up to six sub-keywords, each answering a different search. Only real Google searches are used, and nothing already on the website is repeated.</p>
    <div class="kw-site">
      Website
      ${websites.length > 1
        ? html`<select aria-label="Website" onchange="location.href='/new-website/keywords?website='+this.value">
            ${websites.map((w) => html`<option value="${w.id}" ${w.id === current.id ? raw('selected') : raw('')}>${w.name} · ${w.domain}</option>`)}
          </select>`
        : html`<strong>${current.name}</strong><span class="ns-mono">${current.domain}</span>`}
    </div>
    <form id="kw-find" autocomplete="off">
      <input type="hidden" name="websiteId" value="${current.id}" />
      <label for="kw-pillar">Pillar keyword</label>
      <div class="kw-row">
        <input id="kw-pillar" name="pillar" maxlength="80" placeholder="pumpkin chocolate chip cookies" />
        <button class="ns-btn primary" id="kw-go">Find sub-keywords</button>
      </div>
      <div class="kw-hint">The main topic for ${current.niche}. The search reads the website's posts, asks Google, then the AI. It can take a minute.</div>
      <div class="kw-status" id="kw-status" role="status"></div>
      <div class="kw-error" id="kw-error" role="alert"></div>
    </form>

    <div class="kw-result" id="kw-result" hidden>
      <div class="kw-result-head">
        <h2 id="kw-title"></h2>
        <span class="kw-count" id="kw-count"></span>
      </div>
      <p class="kw-source" id="kw-source"></p>
      <div class="kw-pillar-page" id="kw-pillar-page" hidden></div>
      <ul class="kw-list" id="kw-list"></ul>

      <div class="kw-add">
        <label for="kw-own">Add your own</label>
        <div class="kw-row">
          <input id="kw-own" maxlength="100" placeholder="pumpkin chocolate chip cookie bars" />
          <button type="button" class="ns-btn" id="kw-own-add">Add</button>
        </div>
        <div class="kw-error" id="kw-own-error" role="alert"></div>
      </div>

      <details class="kw-dropped" id="kw-dropped" hidden>
        <summary id="kw-dropped-title"></summary>
        <ul id="kw-dropped-list"></ul>
      </details>
      <div class="kw-error" id="kw-save-error" role="alert"></div>
    </div>`;

  const foot = html`
    <span></span>
    <button type="button" class="ns-btn primary" id="kw-save" disabled>Save and continue</button>`;

  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(stepNames(current.niche), 0, 'Keyword plan', `${current.name} · ${current.domain}`, body, foot)}

    <section class="kw-saved">
      <h2>Saved plans for ${current.name}</h2>
      ${plans.length
        ? plans.map((plan) => {
            const rows = seo.get(plan.id) ?? [];
            return html`<div class="kw-saved-row">
              <a class="kw-open" href="${planHref(plan.id, 'seo')}">
                <b>${plan.pillar}</b>
                <div class="kw-saved-meta">${plan.items.length} sub-keyword${plan.items.length === 1 ? '' : 's'} · saved ${day(plan.created_at)} · ${progress(rows)}</div>
              </a>
              <a class="ns-btn" href="${planHref(plan.id, 'seo')}">Open</a>
              <form method="post" action="/new-website/keywords/${plan.id}/delete" data-name="${plan.pillar}"
                    onsubmit="return confirm('Delete the plan for ' + this.dataset.name + '?')">
                <input type="hidden" name="websiteId" value="${current.id}" />
                <button class="ns-btn quiet kw-remove">Delete</button>
              </form>
            </div>`;
          })
        : html`<p class="kw-none">No plans yet. Find sub-keywords above and save the ones you want.</p>`}
    </section>
    ${raw(script(current.id, articleTypeFor(current.niche) === 'recipe'))}
  `;
}

const STATUS: Record<SeoRow['status'], string> = {
  pending: 'Waiting',
  writing: 'Writing…',
  done: 'Done',
  failed: 'Failed',
};

const fits = (length: number, [min, max]: readonly [number, number]): boolean => length >= min && length <= max;

const SKELETON_STATUS: Record<string, string> = {
  pending: 'Waiting',
  writing: 'Making…',
  done: 'Done',
  failed: 'Failed',
};

/** A card whose head opens and closes its body, with an animation. */
function card(head: Html, body: Html, open = false): Html {
  return html`<li class="acc ${open ? 'open' : ''}">
    <button type="button" class="acc-head" aria-expanded="${open ? 'true' : 'false'}">${head}${raw(CHEVRON)}</button>
    <div class="acc-panel"><div class="acc-inner"><div class="acc-body">${body}</div></div></div>
  </li>`;
}

const roleLabel = (row: SeoRow, intent: string): Html =>
  html`<span class="kw-seo-role">${row.role === 'pillar' ? 'Pillar' : (INTENT_LABEL[intent] ?? 'Sub-keyword')}</span>`;

const problemList = (text: string): Html =>
  html`<div class="kw-seo-problems">${text.split('\n').filter(Boolean).map((p) => html`<div>${p}</div>`)}</div>`;

/** One keyword's AI#1 result: how it will look in Google, and its checks. */
function seoCard(row: SeoRow, intent: string): Html {
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b><span class="kw-seo-status ${row.status}">${STATUS[row.status]}</span>`;
  const shown = row.status === 'done' || (row.status === 'failed' && row.title);
  const body = html`
    ${shown
      ? html`<div class="kw-serp">
          <div class="kw-serp-title">${row.title}</div>
          <div class="kw-serp-desc">${row.description}</div>
        </div>
        <dl class="kw-seo-facts">
          <div><dt>Title</dt><dd class="ns-num ${fits(row.title.length, TITLE) ? '' : 'off'}">${row.title.length} characters</dd></div>
          <div><dt>Description</dt><dd class="ns-num ${fits(row.description.length, DESCRIPTION) ? '' : 'off'}">${row.description.length} characters</dd></div>
          <div><dt>Focus keyword</dt><dd>${row.focus_keyword}</dd></div>
          <div><dt>E-E-A-T</dt><dd>${row.eeat || '—'}${row.confidence ? ` · ${row.confidence} confidence` : ''}</dd></div>
          <div class="wide"><dt>Image alt text</dt><dd>${row.alt_text}</dd></div>
          ${row.reasoning ? html`<div class="wide"><dt>Why it works</dt><dd>${row.reasoning}</dd></div>` : raw('')}
        </dl>`
      : html`<p class="kw-none" style="margin:4px 0 0">${row.status === 'writing' ? 'The AI is writing this now.' : 'Waiting for its turn.'}</p>`}
    ${row.status === 'failed' ? problemList(row.problems) : raw('')}
    ${row.status === 'done' || row.status === 'failed'
      ? html`<form method="post" action="/new-website/keywords/seo/${row.id}/retry" class="kw-seo-retry">
          <button class="ns-btn quiet kw-remove">Write again</button>
        </form>`
      : raw('')}`;
  return card(head, body, row.status === 'failed');
}

/** One keyword's AI#2 outline: headings, word targets and key points. */
function skeletonCard(row: SeoRow, intent: string): Html {
  const k: Skeleton | null = row.skeleton_json ? parseSkeleton(row.skeleton_json) : null;
  const state =
    row.status !== 'done'
      ? 'Needs SEO first'
      : row.recipe_status && row.recipe_status !== 'done'
        ? 'Needs the recipe first'
        : (SKELETON_STATUS[row.skeleton_status] ?? 'Waiting');
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b>${k && row.skeleton_status === 'done'
    ? html`<span class="ns-num kw-count">${k.sections.length} sections · ${totalWords(k)} words</span>`
    : raw('')}<span class="kw-seo-status ${row.skeleton_status}">${state}</span>`;
  const body = html`
    ${k
      ? html`<div class="kw-skel">
          <div class="kw-skel-h1">H1 · ${k.h1}${row.article_type ? html` <span class="kw-count">(${row.article_type})</span>` : raw('')}</div>
          <ol class="kw-skel-list">
            ${k.sections.map(
              (sec) => html`<li>
                <div class="kw-skel-h2"><b>${sec.h2}</b><span class="ns-num">${sec.words ? `${sec.words} words` : ''}</span></div>
                ${sec.covers ? html`<div class="kw-skel-covers">${sec.covers}</div>` : raw('')}
                <ul>${sec.keyPoints.map((pt) => html`<li>${pt}</li>`)}</ul>
                ${sec.h3.length
                  ? html`<ol class="kw-skel-h3s">${sec.h3.map(
                      (h) => html`<li><div class="kw-skel-h2"><span>${h.h3}</span><span class="ns-num">${h.words ? `${h.words} words` : ''}</span></div>
                        ${h.keyPoints.length ? html`<ul>${h.keyPoints.map((pt) => html`<li>${pt}</li>`)}</ul>` : raw('')}</li>`,
                    )}</ol>`
                  : raw('')}
              </li>`,
            )}
          </ol>
        </div>`
      : html`<p class="kw-none" style="margin:4px 0 0">${row.status !== 'done'
          ? 'The skeleton is made once this keyword has its SEO metadata.'
          : row.skeleton_status === 'writing' ? 'The AI is designing this outline now.' : 'Waiting for its turn.'}</p>`}
    ${row.skeleton_status === 'failed' ? problemList(row.skeleton_problems) : raw('')}
    ${row.skeleton_status === 'done' || row.skeleton_status === 'failed'
      ? html`<form method="post" action="/new-website/keywords/skeleton/${row.id}/retry" class="kw-seo-retry">
          <button class="ns-btn quiet kw-remove">Make skeleton again</button>
        </form>`
      : raw('')}`;
  return card(head, body, row.skeleton_status === 'failed');
}

const busyRows = (rows: SeoRow[]): boolean =>
  rows.some((r) =>
    [r.status, r.recipe_status, r.skeleton_status, r.article_status, r.images_status].some((st) => st === 'pending' || st === 'writing'),
  );

/** Step 2: the SEO metadata (AI#1) of every keyword in one plan. */
export function seoStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[]): Html {
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const done = rows.filter((r) => r.status === 'done').length;
  const body = html`
    <h2>SEO metadata</h2>
    <p>Title, description, focus keyword and alt text for each keyword, written by the AI from real Google searches and checked by code. Click a keyword to open it.</p>
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => seoCard(r, intentOf.get(r.keyword) ?? ''))}
        </ul>`
      : html`<form method="post" action="/new-website/keywords/${plan.id}/seo/start">
          <input type="hidden" name="websiteId" value="${site.id}" />
          <p class="kw-none">This plan was saved before SEO metadata was written automatically.</p>
          <button class="ns-btn primary">Write SEO metadata</button>
        </form>`}`;
  const foot = html`
    <a class="ns-btn quiet" href="/new-website/keywords?website=${site.id}">Previous</a>
    ${articleTypeFor(site.niche) === 'recipe'
      ? html`<a class="ns-btn primary" href="${planHref(plan.id, 'recipe')}">Next: recipes</a>`
      : html`<a class="ns-btn primary" href="${planHref(plan.id, 'skeleton')}">Next: skeletons</a>`}`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(stepNames(site.niche), 1, plan.pillar, html`${site.name} · <span class="ns-num">${done} of ${rows.length || plan.items.length + 1} done</span>`, body, foot)}
    ${raw(watchScript)}`;
}

/** Step 3: the article skeleton (AI#2) of every keyword in one plan. */
export function skeletonStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[]): Html {
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const done = rows.filter((r) => r.skeleton_status === 'done').length;
  const body = html`
    <h2>Article skeletons</h2>
    <p>The outline the AI designed for each article: headings, what each part covers, key points and word targets. Click a keyword to open it.</p>
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => skeletonCard(r, intentOf.get(r.keyword) ?? ''))}
        </ul>`
      : html`<p class="kw-none">Skeletons follow the SEO metadata. Go back one step to start it.</p>`}`;
  const foot = html`
    <a class="ns-btn quiet" href="${planHref(plan.id, articleTypeFor(site.niche) === 'recipe' ? 'recipe' : 'seo')}">Previous</a>
    <a class="ns-btn primary" href="${planHref(plan.id, 'article')}">Next: articles</a>`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(stepNames(site.niche), stepNames(site.niche).indexOf('Skeleton'), plan.pillar, html`${site.name} · <span class="ns-num">${done} of ${rows.length || plan.items.length + 1} done</span>`, body, foot)}
    ${raw(watchScript)}`;
}

/** One keyword's fixed recipe: the card the article will follow exactly. */
function recipeCard(row: SeoRow, intent: string): Html {
  const r = row.recipe_json ? parseRecipe(row.recipe_json) : null;
  if (row.page === 'article') {
    return card(
      html`${roleLabel(row, intent)}<b>${row.keyword}</b><span class="kw-seo-status">Article page · no recipe</span>`,
      html`<p class="kw-none" style="margin:4px 0 0">This keyword answers a question rather than cooking a dish, so it is written as an article without a recipe. You chose this on step 1.</p>`,
    );
  }
  const state = row.status !== 'done' ? 'Needs SEO first' : (SKELETON_STATUS[row.recipe_status] ?? 'Waiting');
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b>${r && row.recipe_status === 'done'
    ? html`<span class="ns-num kw-count">${r.ingredients.reduce((n, g) => n + g.items.length, 0)} ingredients · ${r.steps.length} steps</span>`
    : raw('')}<span class="kw-seo-status ${row.recipe_status}">${state}</span>`;
  const body = html`
    ${r
      ? html`<div class="kw-recipe">
          <dl class="kw-recipe-facts">
            <div><dt>Prep</dt><dd class="ns-num">${r.prepMinutes} min</dd></div>
            <div><dt>Cook</dt><dd class="ns-num">${r.cookMinutes} min</dd></div>
            <div><dt>Servings</dt><dd class="ns-num">${r.servings}</dd></div>
            <div><dt>Difficulty</dt><dd class="cap">${r.difficulty || '—'}</dd></div>
            <div><dt>Cuisine</dt><dd>${r.cuisine || '—'}</dd></div>
            <div><dt>Course</dt><dd>${r.course || '—'}</dd></div>
          </dl>
          <div class="kw-recipe-cols">
            <div>
              <h4>Ingredients</h4>
              ${r.ingredients.map((g) => html`${g.title ? html`<div class="kw-recipe-group">${g.title}</div>` : raw('')}
                <ul>${g.items.map((i) => html`<li>${i}</li>`)}</ul>`)}
            </div>
            <div>
              <h4>Steps</h4>
              <ol>${r.steps.map((st) => html`<li>${st.text}</li>`)}</ol>
            </div>
          </div>
          <div class="kw-recipe-foot ns-num">Per serving: ${r.nutrition.calories} kcal · ${r.nutrition.protein} g protein · ${r.nutrition.carbs} g carbs · ${r.nutrition.fat} g fat</div>
          ${r.notes ? html`<div class="kw-recipe-notes"><b>Notes</b> ${r.notes}</div>` : raw('')}
        </div>`
      : html`<p class="kw-none" style="margin:4px 0 0">${row.status !== 'done'
          ? 'The recipe is made once this keyword has its SEO metadata.'
          : row.recipe_status === 'writing' ? 'The AI is writing this recipe now.' : 'Waiting for its turn.'}</p>`}
    ${row.recipe_status === 'failed' ? problemList(row.recipe_problems) : raw('')}
    ${row.recipe_status === 'done' || row.recipe_status === 'failed' || (row.status === 'done' && !row.recipe_status)
      ? html`<form method="post" action="/new-website/keywords/recipe/${row.id}/retry" class="kw-seo-retry">
          <button class="ns-btn quiet kw-remove">${row.recipe_status ? 'Make recipe again' : 'Make recipe'}</button>
        </form>`
      : raw('')}`;
  return card(head, body, row.recipe_status === 'failed');
}

/** Recipe websites only: the fixed recipe of every keyword in one plan. */
export function recipeStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[]): Html {
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const done = rows.filter((r) => r.recipe_status === 'done').length;
  const body = html`
    <h2>Recipes</h2>
    <p>The real recipe for each keyword: exact ingredients, steps, times and nutrition. The skeleton and the article are written from it and cannot change it. When the pillar is one dish, its recipe is also added near the end of the pillar article. Article pages have no recipe. Click a keyword to open it.</p>
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => recipeCard(r, intentOf.get(r.keyword) ?? ''))}
        </ul>`
      : html`<p class="kw-none">Recipes follow the SEO metadata. Go back one step to start it.</p>`}`;
  const foot = html`
    <a class="ns-btn quiet" href="${planHref(plan.id, 'seo')}">Previous</a>
    <a class="ns-btn primary" href="${planHref(plan.id, 'skeleton')}">Next: skeletons</a>`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(stepNames(site.niche), 2, plan.pillar, html`${site.name} · <span class="ns-num">${done} of ${rows.length || plan.items.length + 1} done</span>`, body, foot)}
    ${raw(watchScript)}`;
}

/** One keyword's written article (AI#3), shown as it will read. */
function articleCard(row: SeoRow, intent: string): Html {
  const ready = row.skeleton_status === 'done';
  const state = !ready ? 'Needs the skeleton first' : (SKELETON_STATUS[row.article_status] ?? 'Waiting');
  const failed = row.article_status === 'failed';
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b>${row.article_status === 'done'
    ? html`<span class="ns-num kw-count">${row.article_words.toLocaleString('en')} words</span>`
    : raw('')}<span class="kw-seo-status ${row.article_status}">${row.article_status === 'writing' ? 'Writing…' : state}</span>`;
  const body = html`
    ${failed
      ? html`${problemList(row.article_problems)}
          <p class="kw-none" style="margin:8px 0 16px">${row.article_md
            ? 'The sections written before the failed one are kept below. Carrying on writes from the failed section.'
            : 'The first section failed, so nothing is kept yet.'}</p>`
      : raw('')}
    ${row.article_md
      ? html`<article class="kw-article"><h1>${row.title}</h1>${raw(markdownToHtml(row.article_md))}</article>`
      : failed
        ? raw('')
        : html`<p class="kw-none" style="margin:4px 0 0">${!ready
            ? 'The article is written once this keyword has its skeleton.'
            : row.article_status === 'writing' ? 'The AI is writing this article now, one section at a time.' : 'Waiting for its turn.'}</p>`}
    ${row.article_status === 'done' || failed
      ? html`<form method="post" action="/new-website/keywords/article/${row.id}/retry" class="kw-seo-retry">
          <button class="ns-btn ${failed ? 'primary' : 'quiet kw-remove'}">${failed ? 'Carry on writing' : 'Write article again'}</button>
        </form>`
      : raw('')}`;
  return card(head, body, row.article_status === 'failed');
}

/** The written article (AI#3) of every keyword in one plan. */
export function articleStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[]): Html {
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const done = rows.filter((r) => r.article_status === 'done').length;
  const names = stepNames(site.niche);
  const body = html`
    <h2>Articles</h2>
    <p>Each article, written section by section from its skeleton${articleTypeFor(site.niche) === 'recipe' ? ' and, for recipe pages, from its fixed recipe' : ''}. Code checked every section: headings, length, plain language, no generic AI phrases${articleTypeFor(site.niche) === 'recipe' ? ', and nothing that is not in the recipe' : ''}. Click a keyword to read it.</p>
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => articleCard(r, intentOf.get(r.keyword) ?? ''))}
        </ul>`
      : html`<p class="kw-none">Articles follow the skeletons. Go back to start them.</p>`}`;
  const foot = html`
    <a class="ns-btn quiet" href="${planHref(plan.id, 'skeleton')}">Previous</a>
    <a class="ns-btn primary" href="${planHref(plan.id, 'images')}">Next: images</a>`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(names, names.indexOf('Article'), plan.pillar, html`${site.name} · <span class="ns-num">${done} of ${rows.length || plan.items.length + 1} done</span>`, body, foot)}
    ${raw(watchScript)}`;
}

/** One keyword's image prompts (AI#4): the shared theme, then one prompt per picture. */
function imagesCard(row: SeoRow, intent: string): Html {
  const ready = row.article_status === 'done';
  const set = row.images_json ? parseImageSet(row.images_json) : null;
  const state = !ready ? 'Needs the article first' : (SKELETON_STATUS[row.images_status] ?? 'Waiting');
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b>${set && row.images_status === 'done'
    ? html`<span class="ns-num kw-count">${set.images.length} images</span>`
    : raw('')}<span class="kw-seo-status ${row.images_status}">${row.images_status === 'writing' ? 'Writing…' : state}</span>`;
  const body = html`
    ${row.images_status === 'failed' ? problemList(row.images_problems) : raw('')}
    ${set && row.images_status === 'done'
      ? html`<div class="kw-img">
          <dl class="kw-img-theme">
            <div><dt>Surface</dt><dd>${set.theme.surface}</dd></div>
            <div><dt>Lighting</dt><dd>${set.theme.lighting}</dd></div>
            <div><dt>Palette</dt><dd>${set.theme.palette}</dd></div>
            <div><dt>Style</dt><dd>${set.theme.style}</dd></div>
            <div><dt>Mood</dt><dd>${set.theme.mood}</dd></div>
          </dl>
          <ol class="kw-img-list">
            ${set.images.map(
              (im) => html`<li>
                <div class="kw-img-slot">${im.slot.replace(/-/g, ' ')}</div>
                <p class="kw-img-prompt">${im.prompt}</p>
                <div class="kw-img-alt"><b>Alt</b> ${im.alt}</div>
              </li>`,
            )}
          </ol>
        </div>`
      : row.images_status === 'failed'
        ? raw('')
        : html`<p class="kw-none" style="margin:4px 0 0">${!ready
            ? 'The image prompts are written once this keyword has its article.'
            : row.images_status === 'writing' ? 'The AI is writing the image prompts now.' : 'Waiting for its turn.'}</p>`}
    ${row.images_status === 'done' || row.images_status === 'failed'
      ? html`<form method="post" action="/new-website/keywords/images/${row.id}/retry" class="kw-seo-retry">
          <button class="ns-btn quiet kw-remove">Write image prompts again</button>
        </form>`
      : raw('')}`;
  return card(head, body, row.images_status === 'failed');
}

/** The image prompts (AI#4) of every keyword in one plan. */
export function imagesStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[]): Html {
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const done = rows.filter((r) => r.images_status === 'done').length;
  const names = stepNames(site.niche);
  const recipeSite = articleTypeFor(site.niche) === 'recipe';
  const body = html`
    <h2>Image prompts</h2>
    <p>For each article the AI first sets one look (surface, lighting, palette, style, mood), then writes a prompt per picture that follows it, so all of an article's pictures look like one photoshoot. ${recipeSite
      ? 'Recipe pages get six photos of the dish and one per recipe step; article pages get a feature image and one per main section.'
      : 'Each article gets a feature image and one per main section.'} Code checked every prompt: the shared look, lens, aperture, light, real details from the article and no generic words.</p>
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => imagesCard(r, intentOf.get(r.keyword) ?? ''))}
        </ul>`
      : html`<p class="kw-none">Image prompts follow the articles. Go back to start them.</p>`}`;
  const foot = html`
    <a class="ns-btn quiet" href="${planHref(plan.id, 'article')}">Previous</a>
    <a class="ns-btn primary disabled" aria-disabled="true">Next: make the pictures (coming next)</a>`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(names, names.indexOf('Images'), plan.pillar, html`${site.name} · <span class="ns-num">${done} of ${rows.length || plan.items.length + 1} done</span>`, body, foot)}
    ${raw(watchScript)}`;
}

/** Opens and closes the cards, and refreshes the page while the AI is still working. */
const watchScript = `<script>
(function () {
  document.querySelectorAll('.acc-head').forEach(function (b) {
    b.addEventListener('click', function () {
      var li = b.closest('.acc');
      var open = li.classList.toggle('open');
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
  var list = document.querySelector('[data-watch]');
  if (!list) return;
  var id = list.getAttribute('data-watch'), seen;
  setInterval(function () {
    fetch('/new-website/keywords/' + id + '/seo').then(function (r) { return r.json(); }).then(function (r) {
      var key = r.rows.map(function (x) { return [x.status, x.recipe_status, x.skeleton_status, x.article_status, x.images_status].join('/'); }).join(',');
      if (seen !== undefined && seen !== key) location.reload();
      seen = key;
    }).catch(function () {});
  }, 5000);
})();
</script>`;

const script = (websiteId: number, recipeSite: boolean): string => `<script>
(function () {
  var LABELS = ${JSON.stringify(INTENT_LABEL)};
  var MAX = 6;
  var RECIPE_SITE = ${recipeSite ? 'true' : 'false'};
  var state = { pillar: '', pillarPage: 'recipe', pillarReason: '', items: [], dropped: [] };

  // Recipe page or article page: shown, and switchable, only on recipe websites.
  function pageChip(get, set, reason) {
    var wrap = el('span', 'kw-page');
    var b = el('button', 'kw-page-chip ' + get(), get() === 'recipe' ? 'Recipe page' : 'Article page');
    b.type = 'button';
    b.title = 'Switch between a recipe page (gets a full recipe) and an article page (no recipe)';
    b.onclick = function () { set(get() === 'recipe' ? 'article' : 'recipe'); render(); };
    wrap.appendChild(b);
    if (reason) wrap.appendChild(el('span', 'kw-page-why', reason));
    return wrap;
  }
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function post(url, fields) {
    var p = new URLSearchParams();
    p.set('websiteId', '${websiteId}');
    Object.keys(fields).forEach(function (k) { p.set(k, fields[k]); });
    return fetch(url, { method: 'POST', body: p }).then(function (r) { return r.json(); });
  }

  function render() {
    $('kw-result').hidden = false;
    $('kw-title').textContent = 'Sub-keywords for “' + state.pillar + '”';
    $('kw-count').textContent = state.items.length + ' of ' + MAX;
    var list = $('kw-list'); list.textContent = '';
    if (!state.items.length) list.appendChild(el('li', 'kw-empty', 'None kept. Add your own below, or try a different pillar.'));
    state.items.forEach(function (item, i) {
      var li = el('li', 'kw-item');
      var text = el('div');
      var name = el('b', null, item.keyword);
      text.appendChild(name);
      text.appendChild(el('span', 'kw-intent', LABELS[item.intent] || item.intent));
      if (RECIPE_SITE) {
        text.appendChild(pageChip(function () { return item.page || 'recipe'; }, function (v) { item.page = v; item.pageReason = 'Set by you'; }, item.pageReason));
      }
      if (item.reason) text.appendChild(el('div', 'kw-why', item.reason));
      var rm = el('button', 'ns-btn quiet kw-remove', 'Remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + item.keyword);
      rm.onclick = function () { state.items.splice(i, 1); render(); };
      li.appendChild(text); li.appendChild(rm); list.appendChild(li);
    });
    var pp = $('kw-pillar-page');
    pp.hidden = !RECIPE_SITE;
    pp.textContent = '';
    if (RECIPE_SITE) {
      pp.appendChild(el('span', 'kw-pillar-label', 'The pillar “' + state.pillar + '” is'));
      pp.appendChild(pageChip(function () { return state.pillarPage; }, function (v) { state.pillarPage = v; state.pillarReason = 'Set by you'; },
        state.pillarReason || (state.pillarPage === 'recipe' ? 'one dish: its recipe goes near the end' : 'a broad topic: no single recipe')));
    }
    $('kw-own-add').disabled = state.items.length >= MAX;
    $('kw-save').disabled = state.items.length === 0;

    var d = $('kw-dropped');
    d.hidden = !state.dropped.length;
    $('kw-dropped-title').textContent = 'Left out (' + state.dropped.length + ') and why';
    var dl = $('kw-dropped-list'); dl.textContent = '';
    state.dropped.forEach(function (x) {
      var li = el('li'); li.appendChild(el('span', null, x.keyword)); li.appendChild(el('span', null, x.reason)); dl.appendChild(li);
    });
  }

  function busy(button, on, label) {
    button.disabled = on;
    button.classList.toggle('busy', on);
    if (label) button.textContent = label;
  }

  $('kw-find').onsubmit = function (e) {
    e.preventDefault();
    var pillar = $('kw-pillar').value.trim();
    $('kw-error').textContent = '';
    $('kw-status').textContent = 'Reading the website, asking Google, then the AI…';
    busy($('kw-go'), true, 'Searching…');
    post('/new-website/keywords/find', { pillar: pillar }).then(function (r) {
      $('kw-status').textContent = '';
      busy($('kw-go'), false, 'Find sub-keywords');
      if (!r.ok) { $('kw-error').textContent = r.error; $('kw-result').hidden = true; return; }
      state = { pillar: pillar, pillarPage: r.pillarPage || 'recipe', pillarReason: r.pillarPageReason || '', items: r.kept, dropped: r.dropped };
      $('kw-source').textContent = 'Picked from ' + r.searches + ' real Google searches. Remove any you do not want.';
      render();
    }).catch(function () {
      $('kw-status').textContent = '';
      busy($('kw-go'), false, 'Find sub-keywords');
      $('kw-error').textContent = 'The search did not finish. Check your connection and try again.';
    });
  };

  function addOwn() {
    var keyword = $('kw-own').value.trim();
    $('kw-own-error').textContent = '';
    if (!keyword) { $('kw-own-error').textContent = 'Type a keyword.'; return; }
    busy($('kw-own-add'), true, 'Checking…');
    post('/new-website/keywords/check', {
      pillar: state.pillar, keyword: keyword,
      others: JSON.stringify(state.items.map(function (i) { return i.keyword; }))
    }).then(function (r) {
      busy($('kw-own-add'), false, 'Add');
      if (!r.ok) { $('kw-own-error').textContent = r.error; return; }
      state.items.push({ keyword: r.keyword, intent: 'yours', reason: '', page: RECIPE_SITE ? 'recipe' : 'article', pageReason: '' });
      $('kw-own').value = '';
      render();
    }).catch(function () { busy($('kw-own-add'), false, 'Add'); $('kw-own-error').textContent = 'Could not check it. Try again.'; });
  }
  $('kw-own-add').onclick = addOwn;
  $('kw-own').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addOwn(); } });

  $('kw-save').onclick = function () {
    $('kw-save-error').textContent = '';
    busy($('kw-save'), true, 'Saving…');
    post('/new-website/keywords/save', { pillar: state.pillar, pillarPage: state.pillarPage, items: JSON.stringify(state.items) }).then(function (r) {
      if (r.ok) { location.href = r.redirect; return; }
      busy($('kw-save'), false, 'Save and continue');
      $('kw-save-error').textContent = r.error;
    }).catch(function () { busy($('kw-save'), false, 'Save and continue'); $('kw-save-error').textContent = 'Could not save. Try again.'; });
  };
})();
</script>`;
