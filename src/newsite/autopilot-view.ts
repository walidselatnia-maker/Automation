import { html, raw, type Html } from '../web/views/layout.js';
import { autopilotState } from './autopilot.js';
import type { GenerateChoice } from './generate-now.js';
import type { NewWebsiteRow } from './repo.js';

/**
 * The new dashboard's Automation switch (setting newsite_automation_enabled), the first
 * thing on the Dashboard and on Platform settings: ON or OFF, one switch,
 * and while it is on, what each active website does next.
 */

const CSS = `
.ap { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; margin: 0 0 18px; padding: 16px 20px; border: 1px solid var(--line); border-left: 5px solid var(--line-strong); border-radius: var(--r-card); background: var(--surface); }
.ap.on { border-left-color: var(--good); }
.ap-title { display: flex; align-items: center; gap: 12px; }
.ap-title h2 { font-size: 18px; margin: 0; }
.ap-state { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 14px; border-radius: 999px; font-weight: 700; font-size: 14px; letter-spacing: .03em; }
.ap-state::before { content: ''; width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
.ap.on .ap-state { background: var(--good-tint); color: var(--good); }
.ap.off .ap-state { background: var(--raised); color: var(--faint); }
.ap-says { flex: 1 1 320px; color: var(--soft); font-size: 14px; line-height: 1.5; }
.ap-sites { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; list-style: none; }
.ap-sites li b { color: var(--ink); font-weight: 600; }
.ap-sites li.bad { color: var(--bad); }
.ap form { margin: 0; }
.ap-switch { display: inline-flex; align-items: center; gap: 10px; height: 38px; padding: 0 16px 0 6px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); color: var(--ink); font: 600 14px var(--body); cursor: pointer; }
.ap-switch i { position: relative; width: 42px; height: 24px; border-radius: 999px; background: var(--line-strong); }
.ap-switch i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: left .15s; }
.ap-switch[aria-checked="true"] i { background: var(--good); }
.ap-switch[aria-checked="true"] i::after { left: 21px; }
.ap-switch:hover { border-color: var(--ink); }
`;

export function automationBar(on: boolean, sites: NewWebsiteRow[], tz: string, back: string, now = Date.now(), onAt = 0): Html {
  const active = sites.filter((s) => s.status === 'active');
  return html`
    <style>${raw(CSS)}</style>
    <section class="ap ${on ? 'on' : 'off'}" aria-label="Automation">
      <div class="ap-title"><h2>Automation</h2><span class="ap-state">${on ? 'ON' : 'OFF'}</span></div>
      <div class="ap-says">
        ${on
          ? active.length
            ? html`<ul class="ap-sites">${active.map((s) => {
                const next = autopilotState(s, tz, now, onAt).next;
                return html`<li class="${next.startsWith('No keywords') || next.includes('stopped') ? 'bad' : ''}"><b>${s.name}:</b> ${next}</li>`;
              })}</ul>`
            : html`No active website.`
          : raw('')}
      </div>
      <form method="post" action="/new-website/platform/automation">
        <input type="hidden" name="on" value="${on ? '0' : '1'}" />
        <input type="hidden" name="back" value="${back}" />
        <button class="ap-switch" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="Automation"><i></i>${on ? 'Turn off' : 'Turn on'}</button>
      </form>
    </section>`;
}

const GEN_CSS = `
.gn { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: 0 0 18px; }
.gn-open { height: 38px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--ink); color: var(--surface); font: 600 14px var(--body); cursor: pointer; }
.gn-list { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; list-style: none; color: var(--soft); font-size: 14px; }
.gn-list b { color: var(--ink); font-weight: 600; }
.gn-list li.bad { color: var(--bad); }
.gn-dialog { width: min(520px, calc(100vw - 32px)); border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); color: var(--ink); padding: 22px; }
.gn-dialog::backdrop { background: rgba(0,0,0,.35); }
.gn-dialog h2 { margin: 0 0 16px; font-size: 18px; }
.gn-dialog label { display: block; margin: 0 0 14px; font-weight: 600; font-size: 14px; }
.gn-dialog select { display: block; width: 100%; margin-top: 6px; height: 40px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface); color: var(--ink); font: 15px var(--body); }
.gn-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.gn-actions button { height: 38px; padding: 0 18px; border-radius: 999px; font: 600 14px var(--body); cursor: pointer; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); }
.gn-actions button.go { border: 0; background: var(--ink); color: var(--surface); }
`;

/**
 * The Dashboard's Generate now button: pick a website, then one of its
 * keywords or sub-keywords not published yet, and it is written, pictured
 * and published ahead of everything else. Below it, the ones under way.
 */
export function generateBox(choices: GenerateChoice[], going: { keyword: string; site: string; step: string }[]): Html {
  const sites = choices.filter((c) => c.keywords.length);
  const script = `(() => {
    const d = document.getElementById('gn-dialog'); if (!d) return;
    document.getElementById('gn-open').addEventListener('click', () => d.showModal());
    d.querySelector('[data-close]').addEventListener('click', () => d.close());
    const site = d.querySelector('select[name=site]'), kw = d.querySelector('select[name=seo]');
    const show = () => {
      let first = null;
      for (const g of kw.querySelectorAll('optgroup')) { const on = g.dataset.site === site.value; g.hidden = !on; g.disabled = !on; if (on && !first) first = g.querySelector('option'); }
      if (first && (kw.selectedOptions[0]?.parentElement?.dataset.site !== site.value)) kw.value = first.value;
    };
    site.addEventListener('change', show); show();
  })();`;
  return html`
    <style>${raw(GEN_CSS)}</style>
    <div class="gn">
      <button type="button" class="gn-open" id="gn-open" ${raw(sites.length ? '' : 'disabled title="No keyword waiting. Add keywords first."')}>Generate now</button>
      ${going.length
        ? html`<ul class="gn-list">${going.map((g) => html`<li class="${g.step.startsWith('stopped') ? 'bad' : ''}"><b>${g.keyword}</b> (${g.site}): ${g.step}</li>`)}</ul>`
        : raw('')}
    </div>
    ${sites.length
      ? html`<dialog class="gn-dialog" id="gn-dialog">
          <form method="post" action="/new-website/generate-now">
            <h2>Generate an article now</h2>
            <label>Website<select name="site">${sites.map((c) => html`<option value="${String(c.websiteId)}">${c.websiteName}</option>`)}</select></label>
            <label>Keyword<select name="seo" required>${sites.map(
              (c) => html`<optgroup label="${c.websiteName}" data-site="${String(c.websiteId)}">${c.keywords.map(
                (k) => html`<option value="${String(k.id)}">${k.role === 'sub' ? `${k.keyword} (sub-keyword of ${k.pillar})` : k.keyword}</option>`,
              )}</optgroup>`,
            )}</select></label>
            <div class="gn-actions"><button type="button" data-close>Cancel</button><button class="go">Generate and publish</button></div>
          </form>
        </dialog>
        <script>${raw(script)}</script>`
      : raw('')}`;
}
