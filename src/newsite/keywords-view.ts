import { html, raw, type Html } from '../web/views/layout.js';
import type { KeywordPlan, NewWebsiteRow } from './repo.js';

const INTENT_LABEL: Record<string, string> = {
  diet: 'Diet',
  method: 'Method',
  format: 'Format',
  flavor: 'Flavor',
  ingredient: 'Ingredient',
  time: 'Time',
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
.kw-search { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 28px 32px; }
.kw-search label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
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
.kw-plan ol { margin: 12px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.kw-plan li { display: grid; grid-template-columns: 110px 1fr; gap: 12px; font-size: 15px; }
.kw-plan li span { color: var(--soft); font-size: 13px; padding-top: 1px; }
.kw-none { color: var(--soft); }
@media (max-width: 640px) {
  .kw-search { padding: 22px 20px; }
  .kw-row { grid-template-columns: 1fr; }
  .kw-dropped li, .kw-plan li { grid-template-columns: 1fr; gap: 2px; }
}
`;

export function keywordsPage(
  websites: NewWebsiteRow[],
  current: NewWebsiteRow | undefined,
  plans: KeywordPlan[],
): Html {
  const head = html`
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Keywords</h1>
        <p class="ns-lede">One pillar keyword and up to six sub-keywords, each answering a different search.
          Only real Google searches are used, and nothing already on the website is repeated.</p>
      </div>
    </div>`;

  if (!current) {
    return html`<style>${raw(CSS)}</style>${head}
      <div class="nl-empty" style="border:1px dashed var(--line-strong);border-radius:var(--r-card);padding:56px 32px;text-align:center">
        <h2 style="font-size:22px;margin-bottom:8px">Add a website first</h2>
        <p style="color:var(--soft);margin:0 0 24px">Keywords are planned for one website at a time.</p>
        <a class="ns-btn primary" href="/new-website/add">Add website</a>
      </div>`;
  }

  return html`
    <style>${raw(CSS)}</style>
    ${head}
    <div class="kw-site">
      Website
      ${websites.length > 1
        ? html`<select aria-label="Website" onchange="location.href='/new-website/keywords?website='+this.value">
            ${websites.map((w) => html`<option value="${w.id}" ${w.id === current.id ? raw('selected') : raw('')}>${w.name} · ${w.domain}</option>`)}
          </select>`
        : html`<strong>${current.name}</strong><span class="ns-mono">${current.domain}</span>`}
    </div>

    <section class="kw-search">
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

        <div class="kw-save">
          <div class="kw-error" id="kw-save-error" role="alert" style="margin:0"></div>
          <button type="button" class="ns-btn primary" id="kw-save">Save keyword plan</button>
        </div>
      </div>
    </section>

    <section class="kw-plans">
      <h2>Saved plans for ${current.name}</h2>
      ${plans.length
        ? plans.map(
            (plan) => html`
              <article class="kw-plan">
                <div class="kw-plan-head">
                  <div>
                    <h3>${plan.pillar}</h3>
                    <div class="kw-plan-meta">Pillar · ${plan.items.length} sub-keyword${plan.items.length === 1 ? '' : 's'} · saved ${day(plan.created_at)}</div>
                  </div>
                  <form method="post" action="/new-website/keywords/${plan.id}/delete" data-name="${plan.pillar}"
                        onsubmit="return confirm('Delete the plan for ' + this.dataset.name + '?')">
                    <input type="hidden" name="websiteId" value="${current.id}" />
                    <button class="ns-btn quiet kw-remove">Delete</button>
                  </form>
                </div>
                <ol>
                  ${plan.items.map((i) => html`<li><span>${INTENT_LABEL[i.intent] ?? i.intent}</span>${i.keyword}</li>`)}
                </ol>
              </article>`,
          )
        : html`<p class="kw-none">No plans yet. Find sub-keywords above and save the ones you want.</p>`}
    </section>
    ${raw(script(current.id))}
  `;
}

const script = (websiteId: number): string => `<script>
(function () {
  var LABELS = ${JSON.stringify(INTENT_LABEL)};
  var MAX = 6;
  var state = { pillar: '', items: [], dropped: [] };
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
      if (item.reason) text.appendChild(el('div', 'kw-why', item.reason));
      var rm = el('button', 'ns-btn quiet kw-remove', 'Remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + item.keyword);
      rm.onclick = function () { state.items.splice(i, 1); render(); };
      li.appendChild(text); li.appendChild(rm); list.appendChild(li);
    });
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
      state = { pillar: pillar, items: r.kept, dropped: r.dropped };
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
      state.items.push({ keyword: r.keyword, intent: 'yours', reason: '' });
      $('kw-own').value = '';
      render();
    }).catch(function () { busy($('kw-own-add'), false, 'Add'); $('kw-own-error').textContent = 'Could not check it. Try again.'; });
  }
  $('kw-own-add').onclick = addOwn;
  $('kw-own').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addOwn(); } });

  $('kw-save').onclick = function () {
    $('kw-save-error').textContent = '';
    busy($('kw-save'), true, 'Saving…');
    post('/new-website/keywords/save', { pillar: state.pillar, items: JSON.stringify(state.items) }).then(function (r) {
      if (r.ok) { location.href = r.redirect; return; }
      busy($('kw-save'), false, 'Save keyword plan');
      $('kw-save-error').textContent = r.error;
    }).catch(function () { busy($('kw-save'), false, 'Save keyword plan'); $('kw-save-error').textContent = 'Could not save. Try again.'; });
  };
})();
</script>`;
