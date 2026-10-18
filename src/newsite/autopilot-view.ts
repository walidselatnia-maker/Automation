import { html, raw, type Html } from '../web/views/layout.js';
import { autopilotState } from './autopilot.js';
import type { NewWebsiteRow } from './repo.js';

/**
 * The Autopilot panel: one row per website with its on/off switch and what
 * happens next. The first thing on the Dashboard and on the Websites page.
 */

const CSS = `
.ap { margin: 0 0 18px; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); }
.ap-head { display: flex; align-items: baseline; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.ap-head h2 { font-size: 17px; margin: 0; }
.ap-head span { color: var(--faint); font-size: 13px; }
.ap-row { display: grid; grid-template-columns: minmax(140px, 1fr) auto minmax(180px, 2fr) auto; align-items: center; gap: 16px; padding: 12px 18px; }
.ap-row + .ap-row { border-top: 1px solid var(--line); }
.ap-name b { display: block; font-size: 15px; }
.ap-name small { color: var(--faint); font: 12px var(--mono); }
.ap-state { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 14px; border-radius: 999px; font-weight: 700; font-size: 14px; letter-spacing: .02em; }
.ap-state::before { content: ''; width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
.ap-state.on { background: var(--good-tint); color: var(--good); }
.ap-state.off { background: var(--raised); color: var(--faint); }
.ap-next { color: var(--soft); font-size: 14px; }
.ap-next.bad { color: var(--bad); font-weight: 600; }
.ap-row form { margin: 0; }
.ap-switch { display: inline-flex; align-items: center; gap: 10px; height: 34px; padding: 0 14px 0 6px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); color: var(--ink); font: 600 14px var(--body); cursor: pointer; }
.ap-switch i { position: relative; width: 38px; height: 22px; border-radius: 999px; background: var(--line-strong); transition: background .15s; }
.ap-switch i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
.ap-switch[aria-checked="true"] i { background: var(--good); }
.ap-switch[aria-checked="true"] i::after { left: 19px; }
.ap-switch:hover { border-color: var(--ink); }
.ap-empty { padding: 14px 18px; color: var(--soft); }
@media (max-width: 720px) { .ap-row { grid-template-columns: 1fr auto; } .ap-next { grid-column: 1 / -1; } }
`;

/** What one website's Autopilot is doing, in words. */
const nextLine = (site: NewWebsiteRow, tz: string, now: number): string => {
  if (!site.autopilot) return 'You press the buttons: Make pictures and Publish.';
  if (site.status !== 'active') return 'The website is paused, so nothing runs.';
  return autopilotState(site, tz, now).next;
};

export function autopilotPanel(sites: NewWebsiteRow[], tz: string, back: string, now = Date.now()): Html {
  const on = sites.filter((s) => s.autopilot).length;
  return html`
    <style>${raw(CSS)}</style>
    <section class="ap" aria-label="Autopilot">
      <div class="ap-head"><h2>Autopilot</h2><span>${sites.length ? `On for ${on} of ${sites.length} website${sites.length === 1 ? '' : 's'}` : ''}</span></div>
      ${sites.length
        ? sites.map((s) => {
            const line = nextLine(s, tz, now);
            return html`<div class="ap-row">
              <div class="ap-name"><b>${s.name}</b><small>${s.domain}</small></div>
              <span class="ap-state ${s.autopilot ? 'on' : 'off'}">${s.autopilot ? 'ON' : 'OFF'}</span>
              <span class="ap-next ${line.startsWith('No keywords') ? 'bad' : ''}">${line}</span>
              <form method="post" action="/new-website/${String(s.id)}/autopilot">
                <input type="hidden" name="on" value="${s.autopilot ? '0' : '1'}" />
                <input type="hidden" name="back" value="${back}" />
                <button class="ap-switch" role="switch" aria-checked="${s.autopilot ? 'true' : 'false'}" aria-label="Autopilot for ${s.name}"><i></i>${s.autopilot ? 'Turn off' : 'Turn on'}</button>
              </form>
            </div>`;
          })
        : html`<p class="ap-empty">Add a website to run it on Autopilot.</p>`}
    </section>`;
}
