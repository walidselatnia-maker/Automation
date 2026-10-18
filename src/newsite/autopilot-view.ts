import { html, raw, type Html } from '../web/views/layout.js';
import { autopilotState } from './autopilot.js';
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
