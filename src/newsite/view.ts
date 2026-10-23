import { html, raw, type Html } from '../web/views/layout.js';
import { CATCH_UP_DAYS, channelColor, platformName, websiteChannels } from './channels.js';


/** A website's channels: each name in its platform's colour, linked to its channel. */
const channelLinks = (websiteId: number): Html => {
  const list = websiteChannels(websiteId);
  if (!list.length) return html`No social channel yet`;
  return html`${list.map(
    (c, i) => html`${i ? ', ' : ''}<a class="nl-ch" style="--ch:${channelColor(c)}" href="/new-website/channels/${String(c.id)}">${c.name}</a>`,
  )}`;
};

/** The Flow project in one line: its short id, linked; the full address on hover. */
const flowProject = (value: string): Html => {
  if (!value) return html`Shared project from Platform settings`;
  const id = /project\/([0-9a-z-]+)/i.exec(value)?.[1] ?? value;
  const short = id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  return /^https?:\/\//.test(value)
    ? html`<a class="nl-oneline" href="${value}" target="_blank" rel="noopener" title="${value}">Flow project ${short} ↗</a>`
    : html`<span class="nl-oneline" title="${value}">Flow project ${short}</span>`;
};
import type { NewWebsiteRow } from './repo.js';
import { LANGUAGES, PERSONAS } from './validate.js';

const PERSONA_TEXT: Record<(typeof PERSONAS)[number], string> = {
  'Expert / Professional': 'Deep knowledge and credentials. “I have 20+ years of experience…”',
  'Passionate Enthusiast': 'Has tried everything. “Here is what actually works…”',
  'Practical Helper': 'Straight to the point, step by step.',
  Storyteller: 'Warm and personal. “Let me tell you what happened…”',
};

const gap = (minutes: number): string => {
  if (!minutes) return 'None';
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? 'day' : 'days'}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`;
  return `${minutes} minutes`;
};

const gapRange = (from: number, to: number): string => `${from ? gap(from) : '0'} to ${gap(to)}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** SQLite's "2026-10-08 11:02:31" as "8 Oct 2026". */
const added = (createdAt: string): string => {
  const [y, m, d] = createdAt.slice(0, 10).split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : createdAt;
};

const LIST_CSS = `
.nl-empty { border: 1px dashed var(--line-strong); border-radius: var(--r-card); padding: 64px 32px; text-align: center; }
.nl-empty h2 { font-size: 22px; margin-bottom: 8px; }
.nl-empty p { color: var(--soft); margin: 0 auto 28px; max-width: 44ch; }
.nl-list { display: grid; gap: 20px; }
.nl-site { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 26px 30px; box-shadow: var(--shadow); }
.nl-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
.nl-top h2 { font-size: 24px; line-height: 1.2; }
.nl-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 6px; color: var(--soft); font-size: 14px; }
.nl-meta > * + *::before { content: '\\00B7'; margin-right: 10px; color: var(--faint); }
.nl-state { font-weight: 600; color: var(--faint); }
.nl-state.active { color: var(--good); }
.nl-actions { display: flex; gap: 4px; flex: none; }
.nl-top form { margin: 0; }
.nl-sum { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 20px 0 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.nl-sum > div { padding: 14px 20px; }
.nl-sum > div + div { border-left: 1px solid var(--line); }
.nl-sum > div:first-child { padding-left: 0; }
.nl-ch { color: var(--ch); font-weight: 600; text-decoration: none; }
.nl-ch:hover { text-decoration: underline; }
:root.dark .nl-ch { color: color-mix(in srgb, var(--ch) 72%, #fff); }
.nl-oneline { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.nl-sum dt { color: var(--faint); font-size: 13px; margin-bottom: 2px; }
.nl-sum dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.nl-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.nl-more { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; }
.nl-more summary { cursor: pointer; font-weight: 600; color: var(--idle-ink); width: fit-content; }
.nl-parts { display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; margin-top: 12px; }
.nl-part { padding: 16px 0 10px; border-bottom: 1px solid var(--line); }
.nl-part-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 6px; }
.nl-part h3 { font-size: 15px; }
.ns-btn.nl-change { height: 30px; padding: 0 12px; font-size: 13px; }
.nl-part dl { margin: 0; }
.nl-part dl div { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 12px; padding: 9px 0; align-items: baseline; border-bottom: 1px solid var(--line); }
.nl-part dl div:last-child { border-bottom: 0; }
.nl-part dt { color: var(--faint); font-size: 14px; }
.nl-part dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.nl-facts { display: grid; grid-template-columns: 1fr 1fr; column-gap: 48px; margin: 24px 0 0; padding-top: 20px; border-top: 1px solid var(--line); }
.nl-facts div { display: grid; grid-template-columns: 128px 1fr; gap: 16px; padding: 8px 0; align-items: baseline; }
.nl-facts dt { color: var(--soft); font-size: 14px; }
.nl-facts dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
@media (max-width: 980px) { .nl-sum { grid-template-columns: 1fr; } .nl-sum > div { padding-left: 0; border-left: 0 !important; border-top: 1px solid var(--line); } .nl-sum > div:first-child { border-top: 0; } }
@media (max-width: 680px) {
  .nl-site { padding: 22px 20px; }
  .nl-meta { flex-direction: column; align-items: flex-start; gap: 2px; }
  .nl-meta > * + *::before { content: none; }
  .nl-facts, .nl-parts { grid-template-columns: 1fr; }
  .nl-facts div { grid-template-columns: 120px 1fr; }
}
`;

/** One part of a saved website, with the button that opens just that part. */
const part = (id: number, step: number, title: string, rows: [string, string | Html][]): Html => html`
  <section class="nl-part">
    <div class="nl-part-head"><h3>${title}</h3><a class="ns-btn small nl-change" href="/new-website/${String(id)}/edit?section=${String(step)}">Change</a></div>
    <dl>${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
  </section>`;

export function newWebsiteListPage(rows: NewWebsiteRow[], platformReady = true): Html {
  return html`
    <style>${raw(LIST_CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Websites</h1>
        <p class="ns-lede">The websites your articles are published on. Each one has its own topic, writing voice, publishing schedule, and the social channels it shares on.</p>
      </div>
      ${rows.length && platformReady ? html`<a class="ns-btn primary" href="/new-website/add">Add website</a>` : raw('')}
    </div>
    ${rows.length
      ? html`<div class="nl-list">
          ${rows.map(
            (r) => html`
              <article class="nl-site">
                <div class="nl-top">
                  <div>
                    <h2>${r.name}</h2>
                    <div class="nl-meta">
                      <span class="ns-mono">${r.domain}</span>
                      <span class="nl-state ${r.status}">${r.status === 'active' ? 'Active' : 'Paused'}</span>
                      <span>Added ${added(r.created_at)}</span>
                    </div>
                  </div>
                  <div class="nl-actions">
                  <form method="post" action="/new-website/${r.id}/delete" data-name="${r.name}"
                        onsubmit="return confirm('Remove ' + this.dataset.name + ' from this dashboard? The website itself is not changed.')">
                    <button class="ns-btn danger small">Remove</button>
                  </form>
                  </div>
                </div>
                <dl class="nl-sum">
                  <div><dt>Topic</dt><dd>${r.niche}</dd></div>
                  <div><dt>Voice</dt><dd>${r.persona}</dd></div>
                  <div><dt>Publishing</dt><dd>${r.status === 'active' ? (r.auto_publish ? 'By itself' : 'After your approval') : 'Paused'}${r.daily_target ? `, up to ${r.daily_target} a day` : ''}</dd></div>
                  <div><dt>Shares on</dt><dd>${channelLinks(r.id)}</dd></div>
                </dl>
                <div class="nl-links">
                  <a class="ns-btn small" href="/new-website/keywords#website-${String(r.id)}">Keywords &amp; articles</a>
                  <a class="ns-btn small" href="/new-website/sharing/site/${String(r.id)}">Social posts</a>
                  <a class="ns-btn small" href="/new-website/sharing/reels?website=${String(r.id)}">Reels</a>
                </div>
                <details class="nl-more">
                <summary>All settings of ${r.name}</summary>
                <div class="nl-parts">
                  ${part(r.id, 0, 'Website', [
                    ['Name', r.name],
                    ['Address', r.domain],
                    ['API key', 'Saved'],
                  ])}
                  ${part(r.id, 1, 'Topic', [
                    ['Topic', r.niche],
                    ['More detail', r.niche_context || '—'],
                    ['Picture style', r.picture_style || 'Decided from the niche'],
                    ['Language', r.language || 'English'],
                  ])}
                  ${part(r.id, 2, 'Voice', [['Persona', r.persona]])}
                  ${part(r.id, 3, 'Publishing', [
                    ['Status', r.status === 'active' ? 'Active' : 'Paused'],
                    ['Approval', r.auto_publish ? 'Publishes automatically' : 'Waits for my approval'],
                    ['Posts per day', String(r.daily_target || 'No target')],
                    ['Gap between posts', gap(r.interval_minutes)],
                    ...(r.random_gap_to > 0 ? [['Random gap between posts', gapRange(r.random_gap_from, r.random_gap_to)] as [string, string]] : []),
                    ...(r.social_gap_to > 0 ? [['Random gap between social posts', gapRange(r.social_gap_from, r.social_gap_to)] as [string, string]] : []),
                  ])}
                  ${part(r.id, 4, 'Channels and pictures', [
                    ['Social channels', websiteChannels(r.id).length ? `${websiteChannels(r.id).length} (listed above, under Shares on)` : 'None yet'],
                    ['Google Flow project', flowProject(r.project_id)],
                  ])}
                </div>
                </details>
              </article>
            `,
          )}
        </div>`
      : !platformReady
        ? html`<div class="nl-empty">
          <h2>Set up the platform first</h2>
          <p>Websites need the AI connection, the timezone and automation settings in place. It takes a few minutes, once.</p>
          <a class="ns-btn primary" href="/new-website/platform/setup">Set up the platform</a>
        </div>`
        : html`<div class="nl-empty">
          <h2>No websites yet</h2>
          <p>Add your first website to choose its niche, its author voice and how often it publishes.</p>
          <a class="ns-btn primary" href="/new-website/add">Add website</a>
        </div>`}
  `;
}

const STEP_NAMES = ['Website', 'Niche', 'Persona', 'Publishing', 'Channels and images', 'Review'];

export const WIZARD_CSS = `
.wz { max-width: 980px; margin: 0 auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); overflow: hidden; box-shadow: var(--shadow); }
.wz-head { background: var(--surface); color: var(--ink); padding: 28px 32px 22px; border-bottom: 1px solid var(--line); }
.wz-head h1 { font-size: 26px; font-weight: 700; line-height: 1.2; }
.wz-id { margin: 6px 0 0; font-size: 15px; color: var(--soft); min-height: 24px; overflow-wrap: anywhere; }
.wz-id span + span::before { content: '·'; margin: 0 8px; color: var(--faint); }
.wz-bar { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; margin-top: 20px; }
.wz-bar i { height: 6px; border-radius: 3px; background: var(--idle-line); }
.wz-bar i.on { background: var(--accent); }
.wz-stepname { margin-top: 10px; font-size: 14px; font-weight: 600; color: var(--accent-text); }
.wz-body { padding: 32px; }
.wz-step { display: none; }
.wz-step.on { display: block; }
.wz-step h2 { font-size: 22px; }
.wz-step > p { color: var(--soft); margin: 6px 0 28px; max-width: 60ch; }
.wz-field { margin-bottom: 20px; }
.wz-field:last-child { margin-bottom: 0; }
.wz-field label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 8px; color: var(--ink); }
.wz-field label em { font-style: normal; font-weight: 400; color: var(--faint); margin-left: 6px; }
.wz-field input, .wz-field select, .wz-field textarea { width: 100%; height: 44px; padding: 0 14px; border: 1px solid var(--line-strong);
  border-radius: var(--r-ctl); background: var(--surface); color: var(--ink); font: 15px/1.4 var(--body); }
.wz-field input:hover, .wz-field select:hover, .wz-field textarea:hover { border-color: var(--soft); }
.wz-field textarea { height: auto; min-height: 88px; padding: 12px 14px; resize: vertical; }
.wz-field input:focus, .wz-field select:focus, .wz-field textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
.wz-field input.bad, .wz-field select.bad { border-color: var(--bad); box-shadow: 0 0 0 3px var(--bad-tint); }
.wz-hint { color: var(--faint); font-size: 13px; margin-top: 6px; }
.wz-err { color: var(--bad); font-size: 13px; font-weight: 600; margin-top: 6px; }
.wz-err:empty { display: none; }
.wz-two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
.wz-two:last-child { margin-bottom: 0; }
.wz-two > .wz-field { margin-bottom: 0; }
.wz-inline { display: grid; grid-template-columns: 1fr 130px; gap: 10px; }
.wz-range { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) 120px; gap: 8px; align-items: center; }
.wz-range span { color: var(--soft); font-size: 14px; }
.wz-ok { display: none; margin-top: 4px; padding: 10px 14px; border-radius: var(--r-ctl); border-left: 4px solid var(--good); background: var(--good-tint); color: var(--ink); font-size: 14px; font-weight: 500; }
.wz-personas { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
.wz-persona { text-align: left; padding: 14px 16px; border-radius: var(--r-ctl); border: 1px solid var(--idle-line); background: var(--idle);
  color: var(--idle-ink); font: inherit; cursor: pointer; }
.wz-persona:hover { background: var(--idle-hover); }
.wz-persona.sel { border-color: var(--accent); background: var(--accent-tint); color: var(--ink); box-shadow: inset 0 0 0 1px var(--accent); }
.wz-persona b { display: block; font-weight: 600; font-size: 15px; margin-bottom: 4px; }
.wz-persona span { color: inherit; font-size: 13px; line-height: 1.5; }
.wz-or { display: flex; align-items: center; gap: 12px; color: var(--faint); font-size: 14px; margin: 0 0 16px; }
.wz-or::before, .wz-or::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.wz-sum section { padding: 18px 0; border-top: 1px solid var(--line); }
.wz-sum section:first-child { padding-top: 0; border-top: 0; }
.wz-sum h3 { display: flex; justify-content: space-between; align-items: baseline; font-size: 16px; margin-bottom: 10px; }
.wz-sum h3 button { font: 600 13px var(--body); color: var(--idle-ink); background: var(--idle); border: 1px solid var(--idle-line); cursor: pointer; padding: 5px 12px; border-radius: var(--r-ctl); }
.wz-sum h3 button:hover { background: var(--idle-hover); }
.wz-sum dl { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; margin: 0; }
.wz-sum dt { color: var(--soft); }
.wz-sum dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.wz-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 18px 32px;
  border-top: 1px solid var(--line); background: var(--raised); }
.wz-foot .ns-btn.primary { min-width: 140px; }
.wz-check { display: flex; align-items: center; gap: 10px; margin: -6px 0 20px; font-size: 14px; color: var(--ink); cursor: pointer; }
.wz-check input { width: 16px; height: 16px; accent-color: var(--accent); }
.wz-ch-platform { font-style: normal; color: var(--faint); font-size: 13px; }
.wz-ch-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; }
.wz-ch-row .wz-check { margin: 0; }
.wz-ch-what { display: flex; gap: 14px; font-size: 13px; color: var(--muted, var(--faint)); }
.wz-ch-what label { display: flex; align-items: center; gap: 6px; cursor: pointer; white-space: nowrap; margin: 0; font-weight: 400; }
.wz-ch-what input { width: 16px; height: 16px; min-height: 0; margin: 0; padding: 0; flex: none; accent-color: var(--accent); }
.wz-ch-row:not(:has(input[name=channelId]:checked)) .wz-ch-what { opacity: .45; }
.wz-saveerr { color: var(--bad); font-size: 14px; font-weight: 600; margin-top: 16px; }
.wz-saveerr:empty { display: none; }
@media (max-width: 640px) {
  .wz-head, .wz-body { padding: 24px 20px; }
  .wz-foot { padding: 16px 20px; }
  .wz-two, .wz-personas { grid-template-columns: 1fr; }
  .wz-sum dl { grid-template-columns: 1fr; gap: 2px; }
  .wz-sum dd { margin-bottom: 8px; }
}
`;

export const field = (
  name: string,
  label: string,
  input: Html,
  extra: { optional?: string; hint?: string } = {},
): Html => html`
  <div class="wz-field">
    <label for="wz-${name}">${label}${extra.optional ? html`<em>${extra.optional}</em>` : raw('')}</label>
    ${input}
    ${extra.hint ? html`<div class="wz-hint">${extra.hint}</div>` : raw('')}
    <div class="wz-err" data-err="${name}"></div>
  </div>
`;

/** Minutes as the wizard's amount and unit, in the largest unit that is exact. */
const gapParts = (minutes: number): { amount: number; unit: 'minutes' | 'hours' | 'days' } =>
  minutes && minutes % 1440 === 0
    ? { amount: minutes / 1440, unit: 'days' }
    : minutes % 60 === 0
      ? { amount: minutes / 60, unit: 'hours' }
      : { amount: minutes, unit: 'minutes' };

const selected = (on: boolean): Html => raw(on ? 'selected' : '');

/** A random gap's two ends in one unit: the largest one both are exact in. Empty when not set. */
const rangeParts = (from: number, to: number): { from: string; to: string; unit: 'minutes' | 'hours' | 'days' } => {
  if (!(to > 0)) return { from: '', to: '', unit: 'hours' };
  const per = [from, to].every((m) => m % 1440 === 0) ? 1440 : [from, to].every((m) => m % 60 === 0) ? 60 : 1;
  return { from: String(from / per), to: String(to / per), unit: per === 1440 ? 'days' : per === 60 ? 'hours' : 'minutes' };
};

/** "From X to Y unit", optional: a random gap. */
const rangeField = (prefix: 'random' | 'social', label: string, now: ReturnType<typeof rangeParts>): Html => html`
  <div class="wz-field">
    <label for="wz-${prefix}From">${label}<em>optional</em></label>
    <div class="wz-range">
      <input id="wz-${prefix}From" name="${prefix}From" inputmode="decimal" placeholder="from" value="${now.from}" />
      <span>to</span>
      <input name="${prefix}To" inputmode="decimal" placeholder="to" aria-label="${label}: to" value="${now.to}" />
      <select name="${prefix}Unit" aria-label="Unit">
        <option value="minutes" ${selected(now.unit === 'minutes')}>minutes</option><option value="hours" ${selected(now.unit === 'hours')}>hours</option><option value="days" ${selected(now.unit === 'days')}>days</option>
      </select>
    </div>
    <div class="wz-err" data-err="${prefix}From"></div>
    <div class="wz-err" data-err="${prefix}To"></div>
    <div class="wz-err" data-err="${prefix}Unit"></div>
  </div>
`;

/**
 * The wizard. Without a website it adds one; with one it edits it, every
 * field filled in. Saved secrets are never sent back to the page: an empty
 * key or token field means "keep the saved one".
 */
/** A channel this website may post to, and whether it already does. */
export interface WizardChannel {
  id: number;
  name: string;
  platform: string;
  via: string;
  checked: boolean;
  /** What this website sends it: its saved choice, or the channel's own when it is not used yet. */
  image: boolean;
  reel: boolean;
  takesReels: boolean;
  /** False for YouTube and TikTok: videos only. */
  takesImages: boolean;
}

export function newWebsiteWizardPage(existing?: NewWebsiteRow, channels: WizardChannel[] = [], section = -1): Html {
  const e = existing;
  // A saved website opens on one part alone, with Cancel and Save.
  const one = Boolean(e) && section >= 0 && section < STEP_NAMES.length - 1;
  const preset = e && (PERSONAS as readonly string[]).includes(e.persona) ? e.persona : '';
  const custom = e && !preset ? e.persona : '';
  const gapNow = gapParts(e?.interval_minutes ?? 480);
  return html`
    <style>${raw(WIZARD_CSS)}</style>
    <div class="wz">
      <div class="wz-head">
        <h1>${one ? `${e!.name}: ${STEP_NAMES[section]}` : e ? `Edit ${e.name}` : 'Add a website'}</h1>
        <p class="wz-id" id="wz-id">${one ? 'Only this part changes.' : e ? 'Change what you need. Nothing is saved until the last step.' : 'Fill in the steps below. Nothing is saved until the last step.'}</p>
        <div class="wz-bar" id="wz-bar" ${raw(one ? 'style="display:none"' : '')}>${STEP_NAMES.map(() => html`<i></i>`)}</div>
        <div class="wz-stepname" id="wz-stepname" ${raw(one ? 'style="display:none"' : '')}></div>
      </div>

      <form id="wz-form" autocomplete="off" novalidate data-edit="${e ? '1' : ''}" data-section="${String(one ? section : -1)}" data-has-buffer="${e?.buffer_token_encrypted ? '1' : ''}">
        ${e ? html`<input type="hidden" name="id" value="${e.id}" />` : raw('')}
        <div class="wz-body">
          <div class="wz-step">
            <h2>The website</h2>
            <p>Where articles are published. The address and key are checked with the website itself.</p>
            <div class="wz-two">
              ${field('name', 'Name', html`<input id="wz-name" name="name" maxlength="60" placeholder="Long Livo" value="${e?.name ?? ''}" />`)}
              ${field('domain', 'Address', html`<input id="wz-domain" name="domain" placeholder="f.longlivo.com" spellcheck="false" value="${e?.domain ?? ''}" />`)}
            </div>
            ${field('apiKey', 'API key', html`<input id="wz-apiKey" name="apiKey" type="password" spellcheck="false"
                placeholder="${e ? 'Leave empty to keep the saved key' : 'sk_…'}" />`, {
              optional: e ? 'only to change it' : undefined,
              hint: 'On the website: Admin → Automation → create a key.',
            })}
            <div class="wz-ok" id="wz-ok"></div>
          </div>

          <div class="wz-step">
            <h2>The niche</h2>
            <p>What this website writes about, and in which language. Every article is planned around it.</p>
            ${field('niche', 'Niche', html`<input id="wz-niche" name="niche" maxlength="60" placeholder="Recipes" value="${e?.niche ?? ''}" />`, {
              hint: 'One or two words: Recipes, Gardening, Travel, Pets…',
            })}
            ${field('nicheContext', 'More detail', html`<textarea id="wz-nicheContext" name="nicheContext" maxlength="500" placeholder="Easy family dinners for busy parents. No fancy ingredients.">${e?.niche_context ?? ''}</textarea>`, {
              optional: 'optional',
              hint: 'Two or three sentences that steer the writing.',
            })}
            ${field('pictureStyle', 'Picture style', html`<textarea id="wz-pictureStyle" name="pictureStyle" maxlength="600" placeholder="Dogs and cats at home, in the garden and at the vet, on the floor, a sofa or the grass. Real owners' hands. Never on a dining table, never with plates or food styling.">${e?.picture_style ?? ''}</textarea>`, {
              optional: 'optional',
              hint: 'How the photos of this niche look: where they are taken, who and what is in them, and what never to show. Left empty, the platform decides from the niche.',
            })}
            ${field('language', 'Language', html`<select id="wz-language" name="language">${LANGUAGES.map(
              (l) => html`<option ${selected(l === (e?.language || 'English'))}>${l}</option>`,
            )}</select>`, {
              hint: 'Articles, recipes, SEO, alt text and social posts are written in it.',
            })}
          </div>

          <div class="wz-step">
            <h2>The author's voice</h2>
            <p>Every article on this website is written in this voice.</p>
            <input type="hidden" name="persona" value="${preset}" />
            <div class="wz-personas" role="radiogroup" aria-label="Persona">
              ${PERSONAS.map(
                (p) => html`<button type="button" class="wz-persona ${p === preset ? 'sel' : ''}" role="radio" aria-checked="${p === preset ? 'true' : 'false'}" data-persona="${p}">
                  <b>${p}</b><span>${PERSONA_TEXT[p]}</span></button>`,
              )}
            </div>
            <div class="wz-err" data-err="persona"></div>
            <div class="wz-or">or</div>
            ${field('customPersona', 'Describe your own', html`<input id="wz-customPersona" name="customPersona" maxlength="200" placeholder="A retired chef who explains things simply" value="${custom}" />`)}
          </div>

          <div class="wz-step">
            <h2>Publishing</h2>
            <p>How often this website publishes, and whether you approve each article first.</p>
            <div class="wz-two">
              ${field('status', 'Status', html`<select id="wz-status" name="status">
                <option value="active">Active</option><option value="paused" ${selected(e?.status === 'paused')}>Paused</option></select>`)}
              ${field('autoPublish', 'Approval', html`<select id="wz-autoPublish" name="autoPublish">
                <option value="1">Publish automatically</option><option value="0" ${selected(e?.auto_publish === 0)}>Wait for my approval</option></select>`)}
            </div>
            <div class="wz-two">
              ${field('dailyTarget', 'Posts per day', html`<input id="wz-dailyTarget" name="dailyTarget" inputmode="numeric" value="${e?.daily_target ?? 3}" />`, {
                hint: '0 means no daily target.',
              })}
              <div class="wz-field">
                <label for="wz-gapAmount">Minimum gap between posts</label>
                <div class="wz-inline">
                  <input id="wz-gapAmount" name="gapAmount" inputmode="decimal" value="${gapNow.amount}" />
                  <select name="gapUnit" aria-label="Unit">
                    <option value="minutes" ${selected(gapNow.unit === 'minutes')}>minutes</option><option value="hours" ${selected(gapNow.unit === 'hours')}>hours</option><option value="days" ${selected(gapNow.unit === 'days')}>days</option>
                  </select>
                </div>
                <div class="wz-err" data-err="gapAmount"></div>
                <div class="wz-err" data-err="gapUnit"></div>
              </div>
            </div>
            <div class="wz-two">
              ${rangeField('random', 'Random gap between posts', rangeParts(e?.random_gap_from ?? 0, e?.random_gap_to ?? 0))}
              ${rangeField('social', 'Random gap between social posts', rangeParts(e?.social_gap_from ?? 0, e?.social_gap_to ?? 0))}
            </div>
          </div>

          <div class="wz-step">
            <h2>Channels and images</h2>
            <p>All optional. You can leave these empty and fill them in later.</p>
            <div class="wz-field">
              <label>Share this website’s articles on</label>
              ${channels.length
                ? html`<input type="hidden" name="channelContent" value="1" />
                  <div class="wz-channels">${channels.map(
                    (c) => html`<div class="wz-ch-row">
                      <label class="wz-check"><input type="checkbox" name="channelId" value="${String(c.id)}" data-name="${c.name}" ${c.checked ? raw('checked') : raw('')} />
                        <span>${c.name} <em class="wz-ch-platform">${platformName(c.platform)} · ${c.via === 'buffer' ? 'Buffer' : 'API'}</em></span></label>
                      <span class="wz-ch-what">
                        ${c.takesImages ? html`<label><input type="checkbox" name="image-${String(c.id)}" value="1" ${c.image ? raw('checked') : raw('')} /> Image posts</label>` : raw('')}
                        ${c.takesReels ? html`<label><input type="checkbox" name="reel-${String(c.id)}" value="1" ${c.reel ? raw('checked') : raw('')} /> Reels</label>` : raw('')}
                      </span>
                    </div>`,
                  )}</div>`
                : html`<div class="wz-hint">No channel to share on yet. Add one on the <a href="/new-website/channels">Channels</a> page, then come back.</div>`}
              <div class="wz-hint">Tick a channel, then what this website sends it. Saving brings sharing in line at once: a channel you add gets this website's image posts and reels from the last ${String(CATCH_UP_DAYS)} days, and one you take off gets nothing more that has not gone out yet.</div>
            </div>
            ${field('projectId', 'Google Flow project', html`<input id="wz-projectId" name="projectId" spellcheck="false" placeholder="https://flow.google.com/project/…" value="${e?.project_id ?? ''}" />`, {
              optional: 'optional',
              hint: 'Where this website’s images and reels are made: the whole address of the project, copied from the browser while it is open in Flow. Empty uses the shared project from Platform settings.',
            })}
          </div>

          <div class="wz-step">
            <h2>Review</h2>
            <p>Check everything. Use Change to go back to a step.</p>
            <div class="wz-sum" id="wz-sum"></div>
            ${one ? raw('') : html`<div class="wz-saveerr" id="wz-saveerr"></div>`}
          </div>
        </div>
        ${one ? html`<div class="wz-saveerr" id="wz-saveerr" style="padding:0 32px"></div>` : raw('')}

        <div class="wz-foot">
          <button type="button" class="ns-btn quiet" id="wz-back">Back</button>
          <button type="submit" class="ns-btn primary" id="wz-next">Next</button>
        </div>
      </form>
    </div>
    ${raw(SCRIPT)}
  `;
}

const SCRIPT = `<script>
(function () {
  var NAMES = ${JSON.stringify(STEP_NAMES)};
  var form = document.getElementById('wz-form');
  var steps = [].slice.call(form.querySelectorAll('.wz-step'));
  var SECTION = Number(form.getAttribute('data-section'));
  var cur = SECTION >= 0 ? SECTION : 0, busy = false;
  var $ = function (id) { return document.getElementById(id); };
  var f = function (n) { return form.elements[n]; };
  var val = function (n) { return (f(n).value || '').trim(); };
  var host = function (v) { return v.toLowerCase().replace(/^https?:\\/\\//, '').replace(/[\\/?#].*$/, ''); };
  var persona = function () { return val('customPersona') || val('persona'); };
  var range = function (p) { return val(p + 'From') || val(p + 'To') ? val(p + 'From') + ' to ' + val(p + 'To') + ' ' + val(p + 'Unit') : '—'; };
  var EDIT = form.getAttribute('data-edit') === '1';
  var channelsText = function () {
    var names = [].slice.call(form.querySelectorAll('input[name=channelId]:checked')).map(function (b) { return b.getAttribute('data-name'); });
    return names.length ? names.join(', ') : 'No channel';
  };

  function identity() {
    var bits = [val('name'), val('domain') && host(val('domain')), cur > 1 && val('niche'), cur > 2 && persona()].filter(Boolean);
    var box = $('wz-id');
    if (!bits.length) return;
    box.textContent = '';
    bits.forEach(function (b) { var s = document.createElement('span'); s.textContent = b; box.appendChild(s); });
  }

  function draw() {
    steps.forEach(function (s, i) { s.classList.toggle('on', i === cur); });
    [].forEach.call($('wz-bar').children, function (d, i) { d.className = i <= cur ? 'on' : ''; });
    $('wz-stepname').textContent = 'Step ' + (cur + 1) + ' of ' + NAMES.length + ' — ' + NAMES[cur];
    if (SECTION >= 0) {
      $('wz-back').textContent = 'Cancel';
      $('wz-back').style.visibility = 'visible';
      $('wz-next').textContent = 'Save';
      return;
    }
    $('wz-back').style.visibility = cur ? 'visible' : 'hidden';
    $('wz-next').textContent = cur === NAMES.length - 1 ? (EDIT ? 'Save changes' : 'Save website') : 'Next';
    if (cur === NAMES.length - 1) summary();
    identity();
    var first = steps[cur].querySelector('input:not([type=hidden]), textarea, select, .wz-persona');
    if (first && document.activeElement !== first) first.focus({ preventScroll: true });
  }

  function showErrors(errors) {
    form.querySelectorAll('[data-err]').forEach(function (e) { e.textContent = ''; });
    form.querySelectorAll('.bad').forEach(function (e) { e.classList.remove('bad'); });
    Object.keys(errors || {}).forEach(function (k) {
      var e = form.querySelector('[data-err="' + k + '"]');
      if (e) e.textContent = errors[k];
      if (f(k) && f(k).classList) f(k).classList.add('bad');
    });
  }

  function post(url, extra) {
    var p = new URLSearchParams(new FormData(form));
    Object.keys(extra || {}).forEach(function (k) { p.set(k, extra[k]); });
    return fetch(url, { method: 'POST', body: p }).then(function (r) { return r.json(); });
  }

  function summary() {
    var groups = [
      [0, 'Website', [['Name', val('name')], ['Address', host(val('domain'))],
        ['API key', val('apiKey') ? 'New key, checked with the website' : (EDIT ? 'Saved key kept, checked with the website' : 'Checked with the website')]]],
      [1, 'Niche', [['Niche', val('niche')], ['More detail', val('nicheContext') || '—'], ['Picture style', val('pictureStyle') || 'Decided from the niche'], ['Language', val('language')]]],
      [2, 'Voice', [['Persona', persona()]]],
      [3, 'Publishing', [['Status', f('status').selectedOptions[0].text], ['Approval', f('autoPublish').selectedOptions[0].text],
        ['Posts per day', val('dailyTarget')], ['Gap between posts', val('gapAmount') + ' ' + val('gapUnit')],
        ['Random gap between posts', range('random')], ['Random gap between social posts', range('social')]]],
      [4, 'Channels and images', [['Shares on', channelsText()],
        ['Google Flow project', val('projectId') || 'Shared project from Platform settings']]]
    ];
    var box = $('wz-sum');
    box.textContent = '';
    groups.forEach(function (g) {
      var sec = document.createElement('section');
      var h = document.createElement('h3'); h.textContent = g[1];
      var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Change';
      b.onclick = function () { cur = g[0]; draw(); };
      h.appendChild(b); sec.appendChild(h);
      var dl = document.createElement('dl');
      g[2].forEach(function (r) {
        var dt = document.createElement('dt'); dt.textContent = r[0];
        var dd = document.createElement('dd'); dd.textContent = r[1];
        dl.appendChild(dt); dl.appendChild(dd);
      });
      sec.appendChild(dl); box.appendChild(sec);
    });
  }

  function setBusy(on, label) {
    busy = on;
    $('wz-next').disabled = on;
    $('wz-back').disabled = on;
    $('wz-next').classList.toggle('busy', on);
    if (on) $('wz-next').textContent = label; else draw();
  }

  $('wz-back').onclick = function () {
    if (SECTION >= 0) { location.href = '/new-website'; return; }
    if (!busy && cur) { cur--; showErrors({}); draw(); }
  };

  form.onsubmit = function (e) {
    e.preventDefault();
    if (busy) return;
    $('wz-saveerr').textContent = '';
    if (cur === NAMES.length - 1 || SECTION >= 0) {
      setBusy(true, 'Saving…');
      post('/new-website/save').then(function (r) {
        if (r.saved) { location.href = r.redirect + (r.redirect.indexOf('?') < 0 ? '?ok=' + encodeURIComponent(EDIT ? 'Website updated.' : 'Website added.') : ''); return; }
        busy = false;
        if (SECTION < 0) cur = r.step || 0;
        else if ((r.step || 0) !== SECTION) $('wz-saveerr').textContent = Object.keys(r.errors || {}).map(function (k) { return r.errors[k]; }).join(' ');
        showErrors(r.errors); setBusy(false);
      }).catch(function () { $('wz-saveerr').textContent = 'Could not save. Check your connection and try again.'; setBusy(false); });
      return;
    }
    setBusy(true, cur === 0 ? 'Checking website…' : 'Checking…');
    post('/new-website/check', { step: cur }).then(function (r) {
      showErrors(r.errors);
      var ok = !Object.keys(r.errors || {}).length;
      if (ok && cur === 0 && r.siteName) {
        $('wz-ok').textContent = 'Connected to ' + r.siteName + '. It accepts: ' + (r.types || []).join(', ') + '.';
        $('wz-ok').style.display = 'block';
      }
      if (ok) cur++;
      busy = false; setBusy(false);
    }).catch(function () { busy = false; setBusy(false); });
  };

  // Changing the address or key means the earlier check no longer counts.
  ['domain', 'apiKey'].forEach(function (n) { f(n).addEventListener('input', function () { $('wz-ok').style.display = 'none'; }); });

  form.querySelectorAll('.wz-persona').forEach(function (b) {
    b.onclick = function () {
      form.querySelectorAll('.wz-persona').forEach(function (x) { x.classList.remove('sel'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('sel'); b.setAttribute('aria-checked', 'true');
      f('persona').value = b.getAttribute('data-persona');
      f('customPersona').value = '';
    };
  });
  f('customPersona').addEventListener('input', function () {
    if (!val('customPersona')) return;
    form.querySelectorAll('.wz-persona').forEach(function (x) { x.classList.remove('sel'); x.setAttribute('aria-checked', 'false'); });
    f('persona').value = '';
  });

  draw();
})();
</script>`;
