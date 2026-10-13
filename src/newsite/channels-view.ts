import { html, raw, type Html } from '../web/views/layout.js';
import { PLATFORMS, VIAS, viaLabel, type ChannelRow, type Platform, type Via } from './channels.js';
import { WIZARD_CSS, field } from './view.js';

/**
 * The Channels page and the channel wizards.
 *
 * Buffer and the platforms' own APIs are kept apart everywhere: each platform
 * card has a "Through Buffer" part and, where the platform has one we use, a
 * "Through the API" part, each with its own wizard. A wizard is a few short
 * steps, one page each, ending with the websites the channel posts for and a
 * check. A token pasted in step 1 stays on the server between steps (see
 * channels-routes.ts) and is never put back into a page.
 */

const CSS = `
.ch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.ch-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.ch-card.soon { opacity: .6; }
.ch-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.ch-top h2 { font-size: 18px; }
.ch-soon { font-size: 12px; font-weight: 600; color: var(--faint); text-transform: uppercase; letter-spacing: .04em; }
.ch-via { border-top: 1px solid var(--line); padding-top: 12px; display: grid; gap: 8px; }
.ch-via-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.ch-via h3 { font: 600 12px var(--body); text-transform: uppercase; letter-spacing: .05em; color: var(--soft); }
.ch-via .ns-btn { height: 32px; padding: 0 12px; font-size: 13px; }
.ch-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ch-list a { display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: var(--r-ctl); background: var(--raised);
  text-decoration: none; font-size: 14px; }
.ch-list a:hover { color: var(--accent); }
.ch-list small { color: var(--faint); white-space: nowrap; }
.ch-none { color: var(--soft); font-size: 14px; margin: 0; }
.ch-pick { display: grid; gap: 10px; margin-bottom: 20px; }
.ch-option { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r-ctl); cursor: pointer; }
.ch-option:hover { border-color: var(--line-strong); background: var(--raised); }
.ch-option input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--accent); }
.ch-option b { display: block; font-weight: 600; }
.ch-option span { color: var(--soft); font-size: 13px; }
.ch-warn { color: var(--bad); font-weight: 600; font-size: 14px; border-left: 3px solid var(--bad); padding: 8px 0 8px 12px; margin: 0 0 20px; }
.ch-ok { color: var(--good); font-weight: 600; border-left: 3px solid var(--good); padding: 8px 0 8px 12px; margin: 0 0 16px; }
.ch-bad { color: var(--bad); font-weight: 600; border-left: 3px solid var(--bad); padding: 8px 0 8px 12px; margin: 0 0 16px; }
.ch-facts { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; margin: 0 0 20px; font-size: 14px; }
.ch-facts dt { color: var(--soft); }
.ch-facts dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.ch-sec { font: 600 15px var(--display); margin: 20px 0 10px; }
.ch-sec:first-child { margin-top: 0; }
@media (max-width: 640px) { .ch-facts { grid-template-columns: 1fr; gap: 2px; } }
`;

export const platformLabel = (key: string): string => PLATFORMS.find((p) => p.key === key)?.label ?? key;

const VIA_TITLE: Record<Via, string> = { buffer: 'Through Buffer', api: 'Through the API' };

const sites = (n: number): string => (n === 1 ? '1 website' : `${n} websites`);

/** The Channels page: every platform, its channels by how they post, and a way to add one. */
export function channelsPage(channels: ChannelRow[], usedBy: Map<number, number>): Html {
  return html`
    <style>${raw(CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Channels</h1>
        <p class="ns-lede">Where your articles are shared. Each channel posts one way only: through Buffer, or through the platform’s own API.</p>
      </div>
    </div>
    <div class="ch-grid">
      ${PLATFORMS.map((p) => {
        if (!p.built) {
          return html`<section class="ch-card soon">
            <div class="ch-top"><h2>${p.label}</h2><span class="ch-soon">Coming soon</span></div>
            <p class="ch-none">Later.</p>
          </section>`;
        }
        const key = p.key as Platform;
        return html`<section class="ch-card">
          <div class="ch-top"><h2>${p.label}</h2></div>
          ${VIAS[key].map((via) => {
            const mine = channels.filter((c) => c.platform === key && c.via === via);
            return html`<div class="ch-via">
              <div class="ch-via-head"><h3>${VIA_TITLE[via]}</h3>
                <a class="ns-btn ${mine.length ? 'quiet' : 'primary'}" href="/new-website/channels/${key}/${via}/new">Add</a></div>
              ${mine.length
                ? html`<ul class="ch-list">${mine.map(
                    (c) => html`<li><a href="/new-website/channels/${c.id}"><span>${c.name}</span><small>${sites(usedBy.get(c.id) ?? 0)}</small></a></li>`,
                  )}</ul>`
                : html`<p class="ch-none">None yet.</p>`}
            </div>`;
          })}
        </section>`;
      })}
    </div>`;
}

/* -- The wizards ---------------------------------------------------------- */

/** The steps of each wizard, by platform and how it posts. */
export function stepsOf(platform: Platform, via: Via): string[] {
  if (via === 'api') return ['Connect', 'Pick pages', 'Check', 'What to post', 'Websites'];
  return platform === 'pinterest'
    ? ['Connect', 'Pick the channel', 'Websites', 'Check']
    : ['Connect', 'Pick pages', 'Buffer plan', 'What to post', 'Websites', 'Check'];
}

export interface WizardContext {
  platform: Platform;
  via: Via;
  draft?: string;
}

const titleOf = (w: WizardContext): string => `Add ${platformLabel(w.platform)}`;
const subOf = (w: WizardContext): string => (w.via === 'buffer' ? 'Through a Buffer account' : 'Through the Facebook API');
const base = (w: WizardContext): string => `/new-website/channels/${w.platform}/${w.via}`;

/** The shell every channel wizard step shares. */
function wizard(w: WizardContext, stepName: string, body: Html, foot: Html, error = ''): Html {
  const names = stepsOf(w.platform, w.via);
  const step = Math.max(0, names.indexOf(stepName));
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    <div class="wz">
      <div class="wz-head">
        <h1>${titleOf(w)}</h1>
        <p class="wz-id">${subOf(w)}</p>
        <div class="wz-bar" style="grid-template-columns:repeat(${names.length},1fr)">${names.map((_, i) => html`<i class="${i <= step ? 'on' : ''}"></i>`)}</div>
        <div class="wz-stepname">Step ${step + 1} of ${names.length}: ${names[step]}</div>
      </div>
      <div class="wz-body">
        ${error ? html`<p class="ch-bad" role="alert">${error}</p>` : raw('')}
        ${body}
      </div>
      <div class="wz-foot">${foot}</div>
    </div>`;
}

const cancel = html`<a class="ns-btn quiet" href="/new-website/channels">Cancel</a>`;
const draftInput = (w: WizardContext): Html => html`<input type="hidden" name="draft" value="${w.draft ?? ''}" />`;
const next = (label = 'Next'): Html => html`<button class="ns-btn primary" form="ch-form">${label}</button>`;
const checked = (on: boolean): Html => raw(on ? 'checked' : '');

export function connectStep(w: WizardContext, error = ''): Html {
  const buffer = w.via === 'buffer';
  return wizard(
    w,
    'Connect',
    html`<form id="ch-form" method="post" action="${base(w)}/connect">
      <h2>Connect</h2>
      ${buffer
        ? html`<p>Paste the Buffer access token of the account your ${platformLabel(w.platform)} ${w.platform === 'facebook' ? 'pages are' : 'channel is'} in.</p>
          ${field('token', 'Buffer access token', html`<input id="wz-token" name="token" type="password" spellcheck="false" autocomplete="off" required />`, {
            hint: 'In Buffer: Settings → API → Access token.',
          })}`
        : html`<p>Paste the Facebook business access token (a system user token from Business Manager). It needs <b>pages_manage_posts</b> and <b>pages_manage_engagement</b>, so the platform can post and add the link comment.</p>
          ${field('token', 'Facebook access token', html`<input id="wz-token" name="token" type="password" spellcheck="false" autocomplete="off" required />`)}`}
    </form>`,
    html`${cancel}${next()}`,
    error,
  );
}

export interface PickChoice {
  id: string;
  name: string;
  /** A line under the name: boards, page id, or "already a channel". */
  note: string;
}

/** Pick the channel (Pinterest, one) or the pages (Facebook, one or more). */
export function pickStep(w: WizardContext, choices: PickChoice[], error = ''): Html {
  const one = w.platform === 'pinterest';
  return wizard(
    w,
    one ? 'Pick the channel' : 'Pick pages',
    html`<form id="ch-form" method="post" action="${base(w)}/pick">
      ${draftInput(w)}
      <h2>${one ? 'Pick the channel' : 'Pick pages'}</h2>
      <p>${one
        ? 'The Pinterest channels in this Buffer account. Pins go to the boards of the one you pick; the AI chooses the board for each article.'
        : w.via === 'buffer'
          ? 'The Facebook pages connected in this Buffer account. Each page you pick becomes its own channel.'
          : 'The pages this token can post to. Each page you pick becomes its own channel.'}</p>
      <div class="ch-pick">
        ${choices.map(
          (c, i) => html`<label class="ch-option"><input type="${one ? 'radio' : 'checkbox'}" name="pick" value="${c.id}" ${checked(one && i === 0)} />
            <div><b>${c.name}</b><span>${c.note}</span></div></label>`,
        )}
      </div>
    </form>`,
    html`<a class="ns-btn quiet" href="${base(w)}/new">Previous</a>${next()}`,
    error,
  );
}

/** Facebook through the API: each picked page asked for its posting token. */
export function checkStep(w: WizardContext, results: { name: string; ok: boolean; error?: string }[]): Html {
  const allOk = results.every((r) => r.ok);
  return wizard(
    w,
    'Check',
    html`<form id="ch-form" method="post" action="${base(w)}/checked">
      ${draftInput(w)}
      <h2>Check</h2>
      <p>Each page was asked for its posting token.</p>
      ${results.map((r) => (r.ok ? html`<p class="ch-ok">${r.name}: connected.</p>` : html`<p class="ch-bad">${r.name}: ${r.error}</p>`))}
    </form>`,
    html`<a class="ns-btn quiet" href="${base(w)}/new">Start again</a>${allOk ? next() : html`<span class="wz-hint">Fix the pages that failed, then start again.</span>`}`,
  );
}

export const BUFFER_FREE_WARNING =
  'Buffer’s free plan cannot add a first comment, so posts on this channel go out without the article link (the link is never put in the post itself). Upgrade Buffer to a paid plan to unlock first comments, or connect this page through the API instead.';

const paidBox = (on: boolean): Html => html`
  <label class="wz-check" style="margin:0 0 16px"><input type="checkbox" name="paidBuffer" value="1" id="ch-paid" ${checked(on)} /> I have a paid Buffer plan (first comment unlocked)</label>
  <p class="ch-warn" id="ch-warn" ${raw(on ? 'style="display:none"' : '')}>${BUFFER_FREE_WARNING}</p>
  <script>
    (function () {
      var box = document.getElementById('ch-paid'), warn = document.getElementById('ch-warn');
      box.addEventListener('change', function () { warn.style.display = box.checked ? 'none' : ''; });
    })();
  </script>`;

/** Facebook through Buffer: the plan decides whether the link comment can be added. */
export function planStep(w: WizardContext, paid: boolean): Html {
  return wizard(
    w,
    'Buffer plan',
    html`<form id="ch-form" method="post" action="${base(w)}/plan">
      ${draftInput(w)}
      <h2>Buffer plan</h2>
      <p>The article link always goes in the first comment, never in the post. The platform cannot see your Buffer plan, so tell it here.</p>
      ${paidBox(paid)}
    </form>`,
    html`${cancel}${next()}`,
  );
}

/** Facebook: an image post, a reel, or both. */
export function postStep(w: WizardContext, picks: { image: boolean; reel: boolean }, error = ''): Html {
  return wizard(
    w,
    'What to post',
    html`<form id="ch-form" method="post" action="${base(w)}/what">
      ${draftInput(w)}
      <h2>What to post</h2>
      <p>For each article, these go to every page you picked. One of them or both.</p>
      <div class="ch-pick">
        <label class="ch-option"><input type="checkbox" name="postImage" value="1" ${checked(picks.image)} />
          <div><b>Image post</b><span>The article's feature picture with a short post written for Facebook. The link goes in the first comment.</span></div></label>
        <label class="ch-option"><input type="checkbox" name="postReel" value="1" ${checked(picks.reel)} />
          <div><b>Reel</b><span>A short video made from the article's pictures (uses Google Flow video credits). The link goes in the first comment. Reels for the new websites come next: picking it now saves the choice.</span></div></label>
      </div>
    </form>`,
    html`${cancel}${next()}`,
    error,
  );
}

export interface WebsiteChoice {
  id: number;
  name: string;
  domain: string;
  checked: boolean;
}

/** The websites boxes and the multiple-websites box, shared by the wizards and the channel page. */
function websiteBoxes(websites: WebsiteChoice[], multi: boolean): Html {
  return html`
    ${websites.length
      ? html`<div class="ch-pick">${websites.map(
          (s) => html`<label class="ch-option"><input type="checkbox" name="websiteId" value="${String(s.id)}" ${checked(s.checked)} />
            <div><b>${s.name}</b><span class="ns-mono">${s.domain}</span></div></label>`,
        )}</div>`
      : html`<p class="ch-none" style="margin-bottom:16px">No website yet. Add one on the <a href="/new-website">Websites</a> page; you can then pick this channel there or here.</p>`}
    <label class="wz-check" style="margin:0 0 4px"><input type="checkbox" name="multiWebsite" value="1" ${checked(multi)} /> Connect this channel to multiple websites</label>
    <div class="wz-hint">Without it, the channel posts for one website only.</div>`;
}

export function websitesStep(w: WizardContext, websites: WebsiteChoice[], multi: boolean, error = ''): Html {
  const last = w.via === 'api';
  return wizard(
    w,
    'Websites',
    html`<form id="ch-form" method="post" action="${base(w)}/save">
      ${draftInput(w)}
      <h2>Websites</h2>
      <p>Which websites share their articles on this channel. You can change it later, here or in a website’s own settings.</p>
      ${websiteBoxes(websites, multi)}
    </form>`,
    html`${cancel}${next(last ? 'Save' : 'Save and check')}`,
    error,
  );
}

/* -- One channel ---------------------------------------------------------- */

export function channelPage(c: ChannelRow, websites: WebsiteChoice[], check: { ok: boolean; text: string } | null): Html {
  const isFb = c.platform === 'facebook';
  const used = websites.filter((s) => s.checked).map((s) => s.name);
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">${c.name}</h1>
        <p class="ns-lede">${platformLabel(c.platform)} channel, ${c.via === 'buffer' ? 'through Buffer' : 'through the Facebook API'}</p>
      </div>
      <a class="ns-btn quiet" href="/new-website/channels">All channels</a>
    </div>
    ${check ? html`<p class="${check.ok ? 'ch-ok' : 'ch-bad'}">${check.text}</p>` : raw('')}
    <dl class="ch-facts">
      <dt>Platform</dt><dd>${platformLabel(c.platform)}</dd>
      <dt>Posts through</dt><dd>${viaLabel(c.via)}</dd>
      <dt>Used by</dt><dd>${used.length ? used.join(', ') : 'No website yet'}</dd>
      ${isFb ? html`<dt>Posts</dt><dd>${[c.post_image ? 'Image post' : '', c.post_reel ? 'Reel (coming next)' : ''].filter(Boolean).join(' and ') || 'Nothing'}</dd>` : raw('')}
    </dl>
    <form method="post" action="/new-website/channels/${c.id}/settings" class="wz" style="max-width:none">
      <div class="wz-body">
        <h2 class="ch-sec">Websites</h2>
        ${websiteBoxes(websites, Boolean(c.multi_website))}
        ${isFb
          ? html`<h2 class="ch-sec">What to post</h2>
            <label class="wz-check" style="margin:0 0 12px"><input type="checkbox" name="postImage" value="1" ${checked(Boolean(c.post_image))} /> An image post for each article</label>
            <label class="wz-check" style="margin:0 0 12px"><input type="checkbox" name="postReel" value="1" ${checked(Boolean(c.post_reel))} /> A reel for each article (coming next)</label>`
          : raw('')}
        ${isFb && c.via === 'buffer' ? html`<h2 class="ch-sec">Buffer plan</h2>${paidBox(Boolean(c.paid_buffer))}` : raw('')}
      </div>
      <div class="wz-foot">
        <button class="ns-btn quiet" formaction="/new-website/channels/${c.id}/check">Check the connection</button>
        <button class="ns-btn primary">Save settings</button>
      </div>
    </form>
    <form method="post" action="/new-website/channels/${c.id}/delete" style="margin-top:24px" onsubmit="return confirm('Remove this channel? Websites stop posting to it.')">
      <button class="ns-btn quiet kw-remove">Remove this channel</button>
    </form>`;
}
