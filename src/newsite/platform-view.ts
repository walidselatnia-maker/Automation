import { html, raw, type Html } from '../web/views/layout.js';
import { AI_MODELS, IMAGE_MODELS, NUMBER_RANGES, TIMEZONES } from './platform.js';
import { field, WIZARD_CSS } from './view.js';
import { imageModelCards } from './image-model.js';
import type { ImageModelCatalogue } from './image-model.js';
import { STATUS_LABEL, type GoogleAccount } from './google-accounts.js';

export interface PlatformView {
  ready: boolean;
  done: boolean;
  keys: { id: number; name: string; models: string[]; enabled: boolean; lastError: string }[];
  value: (key: string) => string;
  hasTelegramToken: boolean;
  /** Null when the image service answers. */
  imageProblem: string | null;
  /** What Google last said to each image model; null when the service does not say. */
  catalogue: ImageModelCatalogue | null;
  /** The sign-in password: chosen here, the generated one, or the one set for the server (AUTH_PASSWORD). Absent when not offered. */
  password?: 'own' | 'generated' | 'server';
  /** The Google accounts Flow jobs use, in order. */
  googleAccounts?: GoogleAccount[];
}

const modelLabel = (v: string): string => IMAGE_MODELS.find((m) => m.value === v)?.label ?? v;

const PAGE_CSS = `
.pf-note { margin-bottom: 28px; border-color: var(--idle-line); background: var(--idle); padding: 12px 16px; border-radius: var(--r-ctl); border: 1px solid; border-left-width: 4px; color: var(--ink); font-weight: 500; }
.pf-note b { display: block; margin-bottom: 2px; }
.pf-note span { color: var(--soft); font-size: 14px; }
.pf-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 4px 32px; box-shadow: var(--shadow); }
.pf-group { display: grid; grid-template-columns: 200px 1fr; gap: 24px; padding: 24px 0; border-top: 1px solid var(--line); }
.pf-group:first-child { border-top: 0; }
.pf-group { scroll-margin-top: 24px; }
.pf-group:target { box-shadow: inset 4px 0 0 var(--accent); margin: 0 -32px; padding-left: 32px; padding-right: 32px; }
.pf-group > div:first-child { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
.pf-group h2 { font-size: 17px; }
.pf-state { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; font: 600 13px/1 var(--body); white-space: nowrap; background: var(--raised); color: var(--soft); border: 1px solid var(--line); }
.pf-state.ok { background: var(--good-tint); color: var(--good); border-color: transparent; }
.pf-state.bad { background: var(--bad-tint); color: var(--bad); border-color: transparent; }
.pf-group dl { display: grid; grid-template-columns: 190px 1fr; gap: 6px 16px; margin: 0; }
.pf-group dt { color: var(--faint); font-size: 14px; }
.pf-group dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.pf-group dd small { display: block; font-weight: 500; color: var(--bad); font-size: 13px; }
.ns-btn.pf-change { height: 32px; padding: 0 12px; font-size: 13px; }
.pf-wide { grid-column: 1 / -1; }
.pf-more summary, .pf-advanced summary { cursor: pointer; font-weight: 600; color: var(--idle-ink); padding: 4px 0; }
.pf-more[open] summary { margin-bottom: 14px; }
.pf-ai { margin-top: 20px; }
.pf-keylist { display: grid; grid-template-columns: 190px 1fr; gap: 6px 16px; margin: 0; }
.pf-advanced { margin-top: 20px; padding: 18px 32px; }
.pf-advanced summary { list-style: none; display: flex; align-items: center; gap: 10px; color: var(--ink); font-weight: 400; }
.pf-advanced summary::-webkit-details-marker { display: none; }
.pf-advanced summary::before { content: '▸'; color: var(--faint); }
.pf-advanced[open] summary::before { content: '▾'; }
.pf-advanced summary b { margin-right: 8px; }
.pf-advanced summary span { color: var(--soft); }
.pf-advanced .pf-group { border-top: 1px solid var(--line); margin-top: 16px; }
.ga-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.ga-table th { text-align: left; font-weight: 600; color: var(--soft); padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
.ga-table td { padding: 10px 10px 10px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
.ga-table td.ga-error { min-width: 160px; overflow-wrap: anywhere; color: var(--soft); }
.ga-table td.ga-when { white-space: nowrap; }
.ga-table td.ga-actions { padding-right: 0; }
.ga-actions div { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.ga-table form { margin: 0; }
@media (max-width: 720px) { .ga-table thead { display: none; } .ga-table tr { display: grid; padding: 10px 0; border-bottom: 1px solid var(--line); } .ga-table td { border: 0; padding: 2px 0; } .ga-actions div { justify-content: flex-start; padding-top: 6px; } }
@media (max-width: 720px) {
  .pf-card { padding: 4px 20px; }
  .pf-group, .pf-group dl { grid-template-columns: 1fr; gap: 4px; }
}
`;

const state = (ok: boolean, okText: string, badText: string): Html =>
  html`<span class="pf-state ${ok ? 'ok' : 'bad'}">${ok ? okText : badText}</span>`;

/** On or off: a choice, so "off" is quiet rather than an error. */
const switchState = (on: boolean): Html => html`<span class="pf-state ${on ? 'ok' : ''}">${on ? 'On' : 'Off'}</span>`;

/** A code-like value in the code font; "Not set" in plain text. */
const codeOr = (value: string): Html => (value ? html`<dd class="ns-mono">${value}</dd>` : html`<dd>Not set</dd>`);

/** A part's title, its state, and the button that opens just that part to change it. */
const head = (title: string, step: number, st: Html, done: boolean): Html =>
  html`<div><h2>${title}</h2>${st}${done ? html`<a class="ns-btn small pf-change" href="/new-website/platform/setup?section=${String(step)}">Change</a>` : raw('')}</div>`;

export function platformPage(v: PlatformView, automation: Html = raw(''), searchKeys?: Html): Html {
  const flow = v.value('flow_project_id');
  const d = v.done;
  return html`
    <style>${raw(PAGE_CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Platform settings</h1>
        <p class="ns-lede">What the whole platform needs to work: the AI that writes, the service that makes pictures, your time zone and where to send notifications.
          Each part has its own Change button.</p>
      </div>
      ${d ? raw('') : html`<a class="ns-btn primary" href="/new-website/platform/setup">Set up the platform</a>`}
    </div>
    ${automation}
    ${v.ready
      ? raw('')
      : html`<div class="pf-note" role="status"><b>Set up the platform before adding websites.</b>
          <span>Websites and keywords need at least one working AI key and a saved setup.</span></div>`}
    <div class="pf-card">
      <section class="pf-group" id="images">
        ${head('Images', 3, state(!v.imageProblem && Boolean(flow), 'Ready', v.imageProblem ? 'Service not answering' : 'No Flow project'), d)}
        <dl>
          <dt>Image service</dt><dd>${v.imageProblem ? html`Not connected<small>${v.imageProblem}</small>` : 'Connected'}</dd>
          <dt>Shared Flow project</dt>${codeOr(flow)}
          <dt>Image model</dt><dd>${modelLabel(v.value('image_model'))}</dd>
          <dt>Pause between images</dt><dd class="ns-num">${v.value('image_gap_seconds')} seconds</dd>
          <dt>Public address</dt>${v.value('public_base_url') ? html`<dd class="ns-mono">${v.value('public_base_url')}</dd>` : html`<dd>Not set<small>Needed for sharing: Buffer fetches the pictures from here.</small></dd>`}
        </dl>
        <details class="pf-wide pf-more">
          <summary>Choose the image model</summary>
          ${imageModelCards(v.value('image_model'), v.catalogue)}
        </details>
      </section>
      ${v.googleAccounts ? googleAccountsSection(v.googleAccounts) : raw('')}
      <section class="pf-group">
        ${head('Timezone', 1, state(true, 'Set', ''), d)}
        <dl><dt>Timezone</dt><dd>${v.value('timezone')}</dd></dl>
      </section>
      <section class="pf-group" id="notifications">
        ${head('Notifications', 4, switchState(v.value('telegram_enabled') === 'true'), d)}
        <dl>
          <dt>Telegram bot</dt><dd>${v.hasTelegramToken ? 'Token saved' : 'No token'}</dd>
          <dt>Chat ID</dt>${codeOr(v.value('telegram_chat_id'))}
        </dl>
      </section>
      ${v.password
        ? html`<section class="pf-group" id="password">
            <div><h2>Password</h2>${state(v.password === 'own', 'Your own', v.password === 'generated' ? 'Generated one' : 'Server default')}
              <a class="ns-btn small pf-change" href="/new-website/platform/password">Change</a></div>
            <dl><dt>Sign-in password</dt><dd>${v.password === 'own'
              ? 'The password you chose.'
              : v.password === 'generated'
                ? html`Still the one generated on first start (in the server log).<small>Change it to a password of your own.</small>`
                : 'The one set for the server. You can choose your own.'}</dd></dl>
          </section>`
        : raw('')}
    </div>
    <details class="pf-card pf-advanced">
      <summary><span><b>Advanced</b> What the platform does when a step fails. The defaults suit most people.</span></summary>
      <section class="pf-group" id="automation">
        ${head('Retries', 2, raw(''), d)}
        <dl>
          <dt>Automatic retries</dt><dd>${v.value('auto_retry_enabled') === 'true' ? `${v.value('auto_retry_max')} attempt(s), ${v.value('auto_retry_delay_minutes')} minutes apart` : 'Off'}</dd>
        </dl>
      </section>
    </details>
    <div class="pf-card pf-ai">
      <section class="pf-group" id="ai">
        ${head('AI connection', 0, state(v.keys.length > 0, `${v.keys.length} key${v.keys.length === 1 ? '' : 's'}`, 'No AI key'), d)}
        <dl>
          <dt>Provider</dt><dd class="ns-mono">${v.value('llm_base_url')}</dd>
          <dt>Keys</dt><dd>${v.keys.length
            ? `${v.keys.length} saved, ${v.keys.filter((k) => k.enabled).length} on${v.keys.some((k) => k.lastError) ? `, ${v.keys.filter((k) => k.lastError).length} with a recent error` : ''}`
            : 'None yet'}</dd>
        </dl>
        ${v.keys.length
          ? html`<details class="pf-wide pf-more">
              <summary>Show each key</summary>
              <dl class="pf-keylist">${v.keys.map((k) => html`<dt>${k.name}</dt><dd>${k.models.join(', ') || 'no models'}${k.enabled ? raw('') : html` · off`}${!k.enabled && k.lastError ? html`<small class="pf-refused">Not accepted: ${k.lastError.slice(0, 140)}</small>` : k.lastError ? html`<small>Last error: ${k.lastError.slice(0, 140)}</small>` : raw('')}</dd>`)}</dl>
            </details>`
          : raw('')}
      </section>
    </div>
    ${searchKeys ? html`<div class="pf-card pf-ai">${searchKeys}</div>` : raw('')}
  `;
}

const GA = '/new-website/platform/google-accounts';

/** A plain button that posts to one account's action. */
const accountButton = (id: number, action: string, label: string, kind = 'quiet'): Html =>
  html`<form method="post" action="${GA}/${String(id)}/${action}"><button class="ns-btn small ${kind}">${label}</button></form>`;

/** The Google accounts Flow uses, in the order jobs try them. */
function googleAccountsSection(accounts: GoogleAccount[]): Html {
  return html`<section class="pf-group" id="google-accounts">
    <div><h2>Google accounts</h2><a class="ns-btn small pf-change" href="${GA}/add">Add account</a></div>
    <div class="pf-wide"><table class="ga-table">
      <thead><tr><th>Email</th><th>Status</th><th>Credits left</th><th>Last used</th><th>Last error</th><th></th></tr></thead>
      <tbody>${accounts.map((a, i) => html`<tr>
        <td>${a.email || 'Current account'}</td>
        <td>${STATUS_LABEL[a.status] ?? a.status}</td>
        <td class="ns-num">${a.credits}</td>
        <td class="ga-when">${a.last_used_at ? a.last_used_at.slice(0, 16) : ''}</td>
        <td class="ga-error">${a.last_error.slice(0, 160)}</td>
        <td class="ga-actions"><div>${accountButton(a.id, 'sign-in', 'Sign in')}${i > 0 ? accountButton(a.id, 'up', 'Up') : raw('')}${i < accounts.length - 1 ? accountButton(a.id, 'down', 'Down') : raw('')}<a class="ns-btn small quiet" href="${GA}/${String(a.id)}/change">Change</a>${accountButton(a.id, 'remove', 'Remove', 'danger')}</div></td>
      </tr>`)}</tbody>
    </table></div>
  </section>`;
}

/** Add or change one Google account: its email and its Flow project. */
export function googleAccountPage(account: { id?: number; email: string; flow_project: string }, errors: Record<string, string> = {}): Html {
  const adding = !account.id;
  const action = adding ? `${GA}/add` : `${GA}/${String(account.id)}/change`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(PAGE_CSS)}
      .pw-form { display: grid; gap: 16px; max-width: 560px; }
      .pw-form label { display: grid; gap: 6px; font-weight: 600; }
      .pw-form input { height: 42px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--page); color: var(--ink); font: inherit; }
      .pw-form small { font-weight: 500; color: var(--bad); }</style>
    <div class="wz">
      <div class="wz-head">
        <h1>${adding ? 'Add a Google account' : `Google account: ${account.email || 'Current account'}`}</h1>
      </div>
      <div class="wz-body">
        <form id="ga-form" class="pw-form" method="post" action="${action}">
          <label>Email
            <input type="email" name="email" value="${account.email}" autocomplete="off" spellcheck="false" required />
            ${errors.email ? html`<small>${errors.email}</small>` : raw('')}</label>
          <label>Flow project address
            <input name="flow_project" value="${account.flow_project}" spellcheck="false" placeholder="https://flow.google.com/u/1/project/…" />
            ${errors.flow_project ? html`<small>${errors.flow_project}</small>` : raw('')}</label>
        </form>
      </div>
      <div class="wz-foot"><a class="ns-btn quiet" href="/new-website/platform#google-accounts">Cancel</a><button class="ns-btn primary" form="ga-form">${adding ? 'Add account' : 'Save'}</button></div>
    </div>`;
}

const STEP_NAMES = ['AI connection', 'Timezone', 'Automation', 'Images', 'Notifications', 'Review'];

const EXTRA_CSS = `
.pf-keys { list-style: none; margin: 0 0 24px; padding: 0; border-top: 1px solid var(--line); }
.pf-keys li { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.pf-keys li.gone b, .pf-keys li.gone span { text-decoration: line-through; color: var(--faint); }
.pf-keys span { display: block; color: var(--faint); font-size: 13px; }
.pf-keys .pf-refused, .pf-refused { color: var(--bad); font-weight: 600; }
.pf-keys button { height: 32px; padding: 0 12px; font-size: 13px; }
.pf-models { display: flex; flex-wrap: wrap; gap: 8px 20px; }
.pf-models label { display: flex; align-items: center; gap: 8px; font-weight: 500; font-size: 14px; margin: 0; cursor: pointer; }
.pf-models input { width: 18px; height: 18px; flex: none; margin: 0; padding: 0; }
.pf-models label { white-space: nowrap; }
.pf-sub { font: 600 16px var(--display); margin: 8px 0 14px; }
.pf-bulk { margin-top: 20px; border-top: 1px solid var(--line); padding-top: 16px; }
.pf-bulk summary { cursor: pointer; font-weight: 600; font-size: 15px; color: var(--accent); }
.pf-bulk[open] summary { margin-bottom: 14px; }
.pf-warn { margin: -4px 0 20px; font-size: 14px; border-color: var(--bad); background: var(--bad-tint); padding: 12px 16px; border-radius: var(--r-ctl); border: 1px solid; border-left-width: 4px; color: var(--ink); font-weight: 500; }
.pf-status { font-size: 14px; margin: 0 0 20px; border-color: var(--good); background: var(--good-tint); padding: 12px 16px; border-radius: var(--r-ctl); border: 1px solid; border-left-width: 4px; color: var(--ink); font-weight: 500; }
.pf-status.bad { border-color: var(--bad); background: var(--bad-tint); }
.pf-test { display: flex; align-items: center; gap: 12px; margin-top: -4px; }
.pf-test span { font-size: 14px; font-weight: 500; }
`;

const select = (name: string, current: string, options: { value: string; label: string }[]): Html =>
  html`<select id="wz-${name}" name="${name}">${options.map(
    (o) => html`<option value="${o.value}" ${o.value === current ? raw('selected') : raw('')}>${o.label}</option>`,
  )}</select>`;

const numberField = (v: PlatformView, key: string, label: string, hint: string): Html => {
  const [min, max] = NUMBER_RANGES[key]!;
  return field(key, label, html`<input id="wz-${key}" name="${key}" inputmode="numeric" value="${v.value(key)}" />`, {
    hint: `${hint} (${min} to ${max})`,
  });
};

/**
 * The platform wizard. With a section (once the platform is set up), it opens
 * on that one part alone, with Cancel and Save: no walking through the steps.
 */
export function platformWizardPage(v: PlatformView, section = -1): Html {
  const one = section >= 0 && section < STEP_NAMES.length - 1;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(EXTRA_CSS)}</style>
    <div class="wz">
      <div class="wz-head">
        <h1>${one ? `Change: ${STEP_NAMES[section]}` : v.done ? 'Platform settings' : 'Set up the platform'}</h1>
        <p class="wz-id">${one ? 'Only this part changes.' : 'Nothing is saved until the last step.'}</p>
        <div class="wz-bar" id="wz-bar" ${raw(one ? 'style="display:none"' : '')}>${STEP_NAMES.map(() => html`<i></i>`)}</div>
        <div class="wz-stepname" id="wz-stepname" ${raw(one ? 'style="display:none"' : '')}></div>
      </div>

      <form id="wz-form" autocomplete="off" novalidate>
        <input type="hidden" name="removeKeys" value="" />
        <input type="hidden" name="newKeyModels" value="" />
        <div class="wz-body">
          <div class="wz-step">
            <h2>AI connection</h2>
            <p>Every keyword search and article is written by this AI. A new key is tested with a real request before it is accepted.</p>
            ${field('llm_base_url', 'Provider address', html`<input id="wz-llm_base_url" name="llm_base_url" spellcheck="false" value="${v.value('llm_base_url')}" />`, {
              hint: 'Ollama Cloud is https://ollama.com.',
            })}
            ${v.keys.length
              ? html`<div class="pf-sub">Saved keys</div>
                <ul class="pf-keys">${v.keys.map(
                  (k) => html`<li data-key="${k.id}"><div><b>${k.name}</b><span>${k.models.join(', ')}</span>${!k.enabled && k.lastError ? html`<span class="pf-refused">Not accepted: ${k.lastError.slice(0, 140)}</span>` : raw('')}</div>
                    <button type="button" class="ns-btn danger small" data-remove="${k.id}">Remove</button></li>`,
                )}</ul>`
              : raw('')}
            <div class="pf-sub">${v.keys.length ? 'Add another key' : 'Add a key'}</div>
            <div class="wz-two">
              ${field('newKeyName', 'Name', html`<input id="wz-newKeyName" name="newKeyName" maxlength="40" placeholder="Main key" />`)}
              ${field('newKeyValue', 'API key', html`<input id="wz-newKeyValue" name="newKeyValue" type="password" spellcheck="false" />`, {
                hint: 'On ollama.com: Settings → Keys.',
              })}
            </div>
            <div class="wz-field">
              <label>Models this key can run</label>
              <div class="pf-models">${AI_MODELS.map(
                (m) => html`<label><input type="checkbox" data-model="${m}" checked /> ${m}</label>`,
              )}</div>
              <div class="wz-hint">Each ticked model gets one tiny test request, so this can take a minute.</div>
              <div class="wz-err" data-err="newKeyModels"></div>
            </div>
            <details class="pf-bulk">
              <summary>Paste many keys at once</summary>
              ${field('bulkKeys', 'Keys, one per line', html`<textarea id="wz-bulkKeys" name="bulkKeys" rows="6" spellcheck="false" placeholder="sk-first-key&#10;sk-second-key&#10;Backup = sk-third-key"></textarea>`, {
                hint: 'A bare key gets a name like Key 01. Write "name = key" to choose one. They all run the models ticked above. Each is tested when you save; a key that is not accepted is kept in red and the others are added.',
              })}
            </details>
          </div>

          <div class="wz-step">
            <h2>Timezone</h2>
            <p>Decides when a publishing day starts and ends, and the dates on scheduled posts.</p>
            ${field('timezone', 'Timezone', select('timezone', v.value('timezone'), TIMEZONES.map((t) => ({ value: t, label: t }))))}
          </div>

          <div class="wz-step">
            <h2>Retries</h2>
            <p>When a step fails (writing, pictures), the platform can try it again on its own.</p>
            <div class="wz-two">
              ${field('auto_retry_enabled', 'Retry failed steps', select('auto_retry_enabled', v.value('auto_retry_enabled'), [
                { value: 'true', label: 'Yes, automatically' },
                { value: 'false', label: 'No' },
              ]))}
              ${numberField(v, 'auto_retry_max', 'Attempts', 'Extra tries after a failure')}
            </div>
            <div class="wz-two">
              ${numberField(v, 'auto_retry_delay_minutes', 'Wait before retrying', 'Minutes')}
            </div>
          </div>

          <div class="wz-step">
            <h2>Images</h2>
            <p>Where and how article images are made.</p>
            <div class="pf-status ${v.imageProblem ? 'bad' : ''}">${v.imageProblem ? `Image service: ${v.imageProblem}` : 'Image service: connected.'}</div>
            ${field('flow_project_id', 'Shared Google Flow project', html`<input id="wz-flow_project_id" name="flow_project_id" spellcheck="false" value="${v.value('flow_project_id')}" placeholder="https://flow.google.com/project/…" />`, {
              optional: 'optional',
              hint: 'The whole address of the project, copied from the browser while it is open in Flow. The image service opens exactly this address, with the right Google account. Used by every website that has no project of its own.',
            })}
            ${field('public_base_url', 'Public address of this platform', html`<input id="wz-public_base_url" name="public_base_url" spellcheck="false" value="${v.value('public_base_url')}" placeholder="https://dashboard.example.com" />`, {
              optional: 'needed for sharing',
              hint: 'Where this platform answers on the internet. Buffer fetches pin and post pictures from here, by links that expire. Must be https.',
            })}
            <div class="wz-two">
              ${field('image_model', 'Image model', select('image_model', v.value('image_model'), [...IMAGE_MODELS]))}
              ${numberField(v, 'image_gap_seconds', 'Pause between images', 'Seconds')}
            </div>
          </div>

          <div class="wz-step">
            <h2>Notifications</h2>
            <p>A Telegram message when something needs you: an image sign-in, a website failing, an article waiting.</p>
            ${field('telegram_enabled', 'Telegram messages', select('telegram_enabled', v.value('telegram_enabled'), [
              { value: 'false', label: 'Off' },
              { value: 'true', label: 'On' },
            ]))}
            <div class="wz-two">
              ${field('telegram_bot_token', 'Bot token', html`<input id="wz-telegram_bot_token" name="telegram_bot_token" type="password" spellcheck="false"
                placeholder="${v.hasTelegramToken ? 'Leave empty to keep the saved token' : '123456789:ABC…'}" />`, { hint: 'From @BotFather.' })}
              ${field('telegram_chat_id', 'Chat ID', html`<input id="wz-telegram_chat_id" name="telegram_chat_id" spellcheck="false" value="${v.value('telegram_chat_id')}" />`, {
                hint: 'Ask @userinfobot after messaging your bot.',
              })}
            </div>
            <div class="pf-test"><button type="button" class="ns-btn" id="pf-tg">Send test message</button><span id="pf-tg-result" role="status"></span></div>
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
    ${raw(script(v, one ? section : -1))}
  `;
}

const script = (v: PlatformView, section: number): string => `<script>
(function () {
  var NAMES = ${JSON.stringify(STEP_NAMES)};
  var SECTION = ${section};
  var KEYS = ${JSON.stringify(v.keys.map((k) => ({ id: k.id, name: k.name, models: k.models })))};
  var HAS_TG = ${v.hasTelegramToken ? 'true' : 'false'};
  var form = document.getElementById('wz-form');
  var steps = [].slice.call(form.querySelectorAll('.wz-step'));
  var cur = SECTION >= 0 ? SECTION : 0, busy = false, removed = [];
  var $ = function (id) { return document.getElementById(id); };
  var f = function (n) { return form.elements[n]; };
  var val = function (n) { return (f(n).value || '').trim(); };
  var opt = function (n) { return f(n).selectedOptions[0].text; };

  function syncHidden() {
    f('removeKeys').value = removed.join(',');
    f('newKeyModels').value = [].slice.call(form.querySelectorAll('[data-model]')).filter(function (c) { return c.checked; })
      .map(function (c) { return c.getAttribute('data-model'); }).join(',');
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
    $('wz-next').textContent = cur === NAMES.length - 1 ? 'Save platform settings' : 'Next';
    if (cur === NAMES.length - 1) summary();
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
    syncHidden();
    var p = new URLSearchParams(new FormData(form));
    Object.keys(extra || {}).forEach(function (k) { p.set(k, extra[k]); });
    return fetch(url, { method: 'POST', body: p }).then(function (r) { return r.json(); });
  }

  function summary() {
    var kept = KEYS.filter(function (k) { return removed.indexOf(k.id) < 0; }).map(function (k) { return k.name; });
    if (val('newKeyName')) kept.push(val('newKeyName') + ' (new, tested)');
    var pasted = val('bulkKeys').split('\\n').filter(function (l) { l = l.trim(); return l && l.charAt(0) !== '#'; }).length;
    if (pasted) kept.push(pasted + ' pasted key' + (pasted > 1 ? 's' : '') + ' (new, tested)');
    var groups = [
      [0, 'AI connection', [['Provider', val('llm_base_url')], ['Keys', kept.join(', ') || '—']]],
      [1, 'Timezone', [['Timezone', val('timezone')]]],
      [2, 'Retries', [['Retries', val('auto_retry_enabled') === 'true' ? val('auto_retry_max') + ' attempt(s), ' + val('auto_retry_delay_minutes') + ' minutes apart' : 'Off']]],
      [3, 'Images', [['Shared Flow project', val('flow_project_id') || 'Not set'], ['Image model', opt('image_model')], ['Pause between images', val('image_gap_seconds') + ' seconds'], ['Public address', val('public_base_url') || 'Not set']]],
      [4, 'Notifications', [['Telegram', opt('telegram_enabled')], ['Bot token', val('telegram_bot_token') ? 'New token' : (HAS_TG ? 'Saved token kept' : 'Not set')], ['Chat ID', val('telegram_chat_id') || '—']]]
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

  // A problem in the pasted keys must be seen, so their box opens.
  var shownErrors = showErrors;
  showErrors = function (errors) { if (errors && errors.bulkKeys) form.querySelector('.pf-bulk').open = true; shownErrors(errors); };

  function setBusy(on, label) {
    busy = on;
    $('wz-next').disabled = on; $('wz-back').disabled = on;
    $('wz-next').classList.toggle('busy', on);
    if (on) $('wz-next').textContent = label; else draw();
  }

  form.querySelectorAll('[data-remove]').forEach(function (b) {
    b.onclick = function () {
      var id = Number(b.getAttribute('data-remove'));
      var i = removed.indexOf(id);
      if (i < 0) removed.push(id); else removed.splice(i, 1);
      b.closest('li').classList.toggle('gone', i < 0);
      b.textContent = i < 0 ? 'Undo' : 'Remove';
    };
  });

  $('wz-back').onclick = function () {
    if (SECTION >= 0) { location.href = '/new-website/platform'; return; }
    if (!busy && cur) { cur--; showErrors({}); draw(); }
  };

  form.onsubmit = function (e) {
    e.preventDefault();
    if (busy) return;
    $('wz-saveerr').textContent = '';
    if (cur === NAMES.length - 1 || SECTION >= 0) {
      setBusy(true, val('bulkKeys') ? 'Testing the keys and saving…' : 'Saving…');
      post('/new-website/platform/save').then(function (r) {
        if (r.saved) { location.href = r.redirect + '?ok=' + encodeURIComponent(r.message || 'Platform settings saved.'); return; }
        busy = false;
        if (SECTION < 0) cur = r.step || 0;
        else if ((r.step || 0) !== SECTION) $('wz-saveerr').textContent = Object.keys(r.errors || {}).map(function (k) { return r.errors[k]; }).join(' ');
        showErrors(r.errors); setBusy(false);
      }).catch(function () { busy = false; $('wz-saveerr').textContent = 'Could not save. Try again.'; setBusy(false); });
      return;
    }
    setBusy(true, cur === 0 && val('newKeyValue') ? 'Testing the key…' : 'Checking…');
    post('/new-website/platform/check', { step: cur }).then(function (r) {
      showErrors(r.errors);
      if (!Object.keys(r.errors || {}).length) cur++;
      busy = false; setBusy(false);
    }).catch(function () { busy = false; setBusy(false); });
  };

  $('pf-tg').onclick = function () {
    var out = $('pf-tg-result');
    out.style.color = ''; out.textContent = 'Sending…';
    $('pf-tg').disabled = true;
    post('/new-website/platform/telegram-test').then(function (r) {
      $('pf-tg').disabled = false;
      out.style.color = r.ok ? 'var(--good)' : 'var(--bad)';
      out.textContent = r.ok ? 'Sent. Check Telegram.' : r.error;
    }).catch(function () { $('pf-tg').disabled = false; out.textContent = 'Could not send. Try again.'; });
  };

  draw();
})();
</script>`;

/** Change the sign-in password: the current one, then the new one twice. */
export function passwordPage(generated: boolean, error = ''): Html {
  return html`
    <style>${raw(WIZARD_CSS)}${raw(PAGE_CSS)}
      .pw-form { display: grid; gap: 16px; max-width: 460px; }
      .pw-form label { display: grid; gap: 6px; font-weight: 600; }
      .pw-form input { height: 42px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--page); color: var(--ink); font: inherit; }
      .pw-form small { font-weight: 400; color: var(--soft); }</style>
    <div class="wz">
      <div class="wz-head">
        <h1>Change the password</h1>
        <p class="wz-id">The password you sign in with. ${generated ? 'You are still on the one generated on first start, from the server log.' : ''} The new one applies from the next sign-in; this session stays open.</p>
      </div>
      <div class="wz-body">
        ${error ? html`<p class="kw-seo-problems" role="alert" style="margin:0 0 16px">${error}</p>` : raw('')}
        <form id="pw-form" class="pw-form" method="post" action="/new-website/platform/password">
          <label>Current password${generated ? html`<small>The generated one, from the server log.</small>` : raw('')}
            <input type="password" name="current" autocomplete="current-password" required /></label>
          <label>New password<small>At least 10 characters.</small>
            <input type="password" name="next" autocomplete="new-password" minlength="10" required /></label>
          <label>New password again
            <input type="password" name="confirm" autocomplete="new-password" minlength="10" required /></label>
        </form>
      </div>
      <div class="wz-foot"><a class="ns-btn quiet" href="/new-website/platform">Cancel</a><button class="ns-btn primary" form="pw-form">Change the password</button></div>
    </div>`;
}
