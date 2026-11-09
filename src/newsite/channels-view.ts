import { html, raw, type Html } from '../web/views/layout.js';
import { apiName, channelColor, PLATFORMS, takesReels, videoOnly, viasOf, viaLabel, type ChannelRow, type Platform, type Via } from './channels.js';
import type { RulesCheck } from './platform-rules.js';
import { commentsThroughApi, COMMENT_PLATFORMS } from './first-comment.js';
import { WIZARD_CSS, field } from './view.js';
import type { NewWebsiteRow } from './repo.js';

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
.ch-cards { display: grid; gap: 20px; }
.ch-group { margin: 0 0 32px; }
.ch-group-title { display: flex; align-items: center; gap: 10px; font-size: 20px; margin: 0 0 12px; }
.ch-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--ch-color); flex: none; }
.ch-count { font: 500 14px var(--body); color: var(--faint); }
/* A light wash of the platform's colour: the text stays on a calm background. */
.ch-site { background: color-mix(in srgb, var(--ch-color, #8a94a3) 7%, var(--surface)); border: 1px solid color-mix(in srgb, var(--ch-color, #8a94a3) 22%, var(--line));
  border-left: 4px solid var(--ch-color, #8a94a3); border-radius: var(--r-card); padding: 18px 24px; box-shadow: var(--shadow); }
:root.dark .ch-site { background: color-mix(in srgb, var(--ch-color, #8a94a3) 9%, var(--surface)); }
.ch-site-top { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.ch-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 4px 0; background: none; border: 0; color: var(--ink);
  font: inherit; text-align: left; cursor: pointer; }
.ch-toggle-text { flex: 1; min-width: 0; }
.ch-name { display: block; font: 700 20px/1.25 var(--display); letter-spacing: -.015em; }
.ch-toggle:hover .ch-name { text-decoration: underline; }
.ch-chev { width: 20px; height: 20px; flex: none; color: var(--soft); transition: transform .2s ease; }
.ch-site.open .ch-chev { transform: rotate(180deg); }
.ch-site[data-toggle]:not(.open) .ch-parts { display: none; }
.ch-site-top form { margin: 0; }
.ch-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 4px; color: var(--soft); font-size: 14px; }
.ch-meta > * + *::before { content: '\\00B7'; margin-right: 10px; color: var(--faint); }
.ch-parts { display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; margin-top: 18px; border-top: 1px solid var(--line); }
.ch-part { padding: 16px 0 10px; border-bottom: 1px solid var(--line); }
.ch-part-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 6px; }
.ch-part h3 { font-size: 15px; }
.ch-part dl { margin: 0; }
.ch-part dl div { display: grid; grid-template-columns: 140px 1fr; gap: 12px; padding: 4px 0; align-items: baseline; }
.ch-part dt { color: var(--faint); font-size: 14px; }
.ch-part dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.ch-empty { border: 1px dashed var(--line-strong); border-radius: var(--r-card); padding: 56px 32px; text-align: center; }
.ch-empty h2 { font-size: 22px; margin-bottom: 8px; }
.ch-empty p { color: var(--soft); margin: 0 auto 24px; max-width: 46ch; }
.ch-pick-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
.wz.ch-wz-wide { max-width: 1160px; }
.ch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.ch-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 20px; display: flex; flex-direction: column; gap: 14px; box-shadow: var(--shadow); }
.ch-card.soon { background: transparent; box-shadow: none; border-style: dashed; }
.ch-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.ch-top h2 { font-size: 18px; }
.ch-rules { text-decoration: none; }
.ch-rules-box { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 20px 24px; margin: 0 0 20px; box-shadow: var(--shadow); }
.ch-rules-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.ch-rules-sum { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 14px 0 0; font-size: 14px; color: var(--soft); }
.ch-editor { width: 100%; min-height: 60vh; padding: 14px 16px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--surface);
  color: var(--ink); font: 14px/1.6 var(--mono); resize: vertical; tab-size: 2; }
.ch-editor:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
.ch-editor-help { color: var(--soft); font-size: 14px; margin: 0 0 14px; max-width: 70ch; }
.ch-editor-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
.ch-editor-foot div { display: flex; gap: 10px; }
.ch-rules:hover .ns-badge { text-decoration: underline; }
.ch-soon { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; font: 600 13px/1 var(--body); white-space: nowrap; background: var(--raised); color: var(--soft); border: 1px solid var(--line); }
.ch-via { border-top: 1px solid var(--line); padding-top: 12px; display: grid; gap: 8px; }
.ch-via-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.ch-via h3 { font: 600 14px var(--body); color: var(--soft); }
.ch-via .ns-btn { height: 32px; padding: 0 12px; font-size: 13px; }
.ch-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ch-list a { display: flex; justify-content: space-between; gap: 10px; padding: 9px 12px; border-radius: var(--r-ctl);
  border: 1px solid var(--idle-line); background: var(--idle); color: var(--idle-ink); text-decoration: none; font-size: 14px; font-weight: 500; }
.ch-list a:hover { background: var(--idle-hover); }
.ch-list small { color: var(--idle-ink); white-space: nowrap; font-size: 13px; }
.ch-none { color: var(--faint); font-size: 14px; margin: 0; }
.ch-pick { display: grid; gap: 10px; margin-bottom: 20px; }
.ch-option { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border: 1px solid var(--idle-line); border-radius: var(--r-ctl); cursor: pointer; background: var(--idle); color: var(--idle-ink); }
.ch-option:hover { background: var(--idle-hover); }
.ch-option input { margin-top: 3px; width: 16px; height: 16px; }
.ch-option b { display: block; font-weight: 600; }
.ch-option:has(input:checked) { background: var(--accent-tint); border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); color: var(--ink); }
.ch-option:has(input:checked) span { color: var(--soft); }
.ch-option span { color: var(--idle-ink); font-size: 13px; }
.ch-warn { margin: 0 0 20px; font-size: 14px; border-color: var(--bad); background: var(--bad-tint); padding: 12px 16px; border-radius: var(--r-ctl); border: 1px solid; border-left-width: 4px; color: var(--ink); font-weight: 500; }
.ch-ok { margin: 0 0 16px; border-color: var(--good); background: var(--good-tint); padding: 12px 16px; border-radius: var(--r-ctl); border: 1px solid; border-left-width: 4px; color: var(--ink); font-weight: 500; }
.ch-bad { margin: 0 0 16px; border-color: var(--bad); background: var(--bad-tint); padding: 12px 16px; border-radius: var(--r-ctl); border: 1px solid; border-left-width: 4px; color: var(--ink); font-weight: 500; }
.ch-facts { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; margin: 0 0 20px; font-size: 14px; }
.ch-facts dt { color: var(--faint); }
.ch-facts dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.ch-sec { font: 600 15px var(--display); margin: 20px 0 10px; }
.ch-sec:first-child { margin-top: 0; }
.ch-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 24px; }
.ch-tab { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 16px; border-radius: 999px; text-decoration: none; font-weight: 600; font-size: 14px; background: var(--idle); color: var(--idle-ink); border: 1px solid var(--idle-line); }
.ch-tab:hover { background: var(--idle-hover); }
.ch-tab.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.ch-tab .n { font-variant-numeric: tabular-nums; opacity: .85; }
.ch-site-section { margin: 0 0 32px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 22px 24px; box-shadow: var(--shadow); }
.ch-site-section.ch-unassigned { border-style: dashed; }
.ch-site-section-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.ch-site-section-title-wrap { display: flex; flex-direction: column; gap: 6px; }
.ch-site-section-title { display: flex; align-items: center; gap: 12px; margin: 0; flex-wrap: wrap; }
.ch-site-section-title h2 { margin: 0; font: 700 22px/1.25 var(--display); letter-spacing: -.015em; color: var(--ink); }
.ch-site-section-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; font-size: 13px; color: var(--soft); }
.ch-site-section-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ch-site-empty { border: 1px dashed var(--line-strong); border-radius: var(--r-ctl); padding: 36px 24px; text-align: center; color: var(--soft); }
.ch-site-empty p { margin: 0 0 14px; font-size: 15px; }
@media (max-width: 640px) { .ch-facts, .ch-parts { grid-template-columns: 1fr; gap: 2px; } .ch-part dl div { grid-template-columns: 1fr; gap: 0; } }
`;

export const platformLabel = (key: string): string => PLATFORMS.find((p) => p.key === key)?.label ?? key.charAt(0).toUpperCase() + key.slice(1);

const VIA_TITLE: Record<Via, string> = { buffer: 'Through Buffer', api: 'Through the API' };

const sites = (n: number): string => (n === 1 ? '1 website' : `${n} websites`);

/* -- The wizards ---------------------------------------------------------- */

/** The steps of each wizard, by platform and how it posts. */
export function stepsOf(platform: Platform, via: Via, firstComment = platform === 'facebook'): string[] {
  if (via === 'api') return ['Connect', apiPickName(platform), 'Check', 'What to post', 'Websites'];
  if (platform === 'pinterest') return ['Connect', 'Pick the channel', 'What to post', 'Websites', 'Check'];
  return [
    'Connect',
    platform === 'facebook' ? 'Pick pages' : 'Pick channels',
    ...(firstComment ? ['Buffer plan'] : []),
    ...(takesReels(platform) && !videoOnly(platform) ? ['What to post'] : []),
    'Websites',
    'Check',
  ];
}

export interface WizardContext {
  platform: Platform;
  via: Via;
  draft?: string;
  /** The platform's rules put the link in a first comment (asks about the Buffer plan). */
  firstComment?: boolean;
  /** The website this channel is being added for, if initiated from a website. */
  defaultWebsiteId?: number;
}

const titleOf = (w: WizardContext): string => `Add ${platformLabel(w.platform)}`;
const subOf = (w: WizardContext): string => (w.via === 'buffer' ? 'Through a Buffer account' : `Through ${apiName(w.platform)}`);

/** The pick step of an API wizard: pages, Instagram accounts, or the one Threads profile. */
const apiPickName = (platform: string): string => (platform === 'instagram' ? 'Pick accounts' : platform === 'threads' ? 'Pick the profile' : 'Pick pages');

/** What to paste in an API wizard's first step, per platform. */
function apiTokenField(platform: string): Html {
  if (platform === 'threads') {
    return html`<p>Paste a long-lived Threads access token for your Threads profile (from your Meta app: Use cases → Access the Threads API → User Token Generator). It needs <b>threads_basic</b> and <b>threads_content_publish</b>. It lasts 60 days and the platform renews it by itself.</p>
      ${field('token', 'Threads access token', html`<input id="wz-token" name="token" type="password" spellcheck="false" autocomplete="off" required />`)}`;
  }
  if (platform === 'instagram') {
    return html`<p>Paste the Facebook business access token (a system user token from Business Manager), the same kind as for Facebook pages. The Instagram account must be a business or creator account linked to one of its pages. It needs <b>instagram_basic</b>, <b>instagram_content_publish</b> and <b>pages_show_list</b>.</p>
      ${field('token', 'Facebook access token', html`<input id="wz-token" name="token" type="password" spellcheck="false" autocomplete="off" required />`)}`;
  }
  return html`<p>Paste the Facebook business access token (a system user token from Business Manager). It needs <b>pages_manage_posts</b> and <b>pages_manage_engagement</b>, so the platform can post and add the link comment.</p>
    ${field('token', 'Facebook access token', html`<input id="wz-token" name="token" type="password" spellcheck="false" autocomplete="off" required />`)}`;
}
const base = (w: WizardContext): string => `/new-website/channels/${w.platform}/${w.via}`;

/** The shell every channel wizard step shares. */
function wizard(w: WizardContext, stepName: string, body: Html, foot: Html, error = ''): Html {
  const names = stepsOf(w.platform, w.via, w.firstComment);
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
      ${w.defaultWebsiteId ? html`<input type="hidden" name="website" value="${String(w.defaultWebsiteId)}" />` : raw('')}
      <h2>Connect</h2>
      ${buffer
        ? html`<p>Paste the Buffer access token of the account your ${platformLabel(w.platform)} ${w.platform === 'pinterest' ? 'channel is' : 'channels are'} in.</p>
          ${field('token', 'Buffer access token', html`<input id="wz-token" name="token" type="password" spellcheck="false" autocomplete="off" required />`, {
            hint: 'In Buffer: Settings → API → Access token.',
          })}`
        : apiTokenField(w.platform)}
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
  const one = w.platform === 'pinterest' || (w.via === 'api' && w.platform === 'threads');
  const name = w.via === 'api' ? apiPickName(w.platform) : one ? 'Pick the channel' : w.platform === 'facebook' ? 'Pick pages' : 'Pick channels';
  return wizard(
    w,
    name,
    html`<form id="ch-form" method="post" action="${base(w)}/pick">
      ${draftInput(w)}
      <h2>${name}</h2>
      <p>${w.via === 'api' && w.platform !== 'facebook'
        ? w.platform === 'threads'
          ? 'The Threads profile this token belongs to.'
          : 'The Instagram business accounts linked to the pages this token can post to. Each one you pick becomes its own channel.'
        : one
        ? 'The Pinterest channels in this Buffer account. Pins go to the boards of the one you pick; the AI chooses the board for each article.'
        : w.via === 'api'
          ? 'The pages this token can post to. Each page you pick becomes its own channel.'
          : `The ${platformLabel(w.platform)} ${w.platform === 'facebook' ? 'pages' : 'channels'} connected in this Buffer account. Each one you pick becomes its own channel.`}</p>
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
      <p>${w.platform === 'threads' ? 'Threads was asked whose token this is.' : w.platform === 'instagram' ? 'The page of each account was asked for its posting token.' : 'Each page was asked for its posting token.'}</p>
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
      <p>On the free plan, the link can still be commented through the Facebook Graph API: once the channel is added, open it and use <b>First comment through the API</b>.</p>
    </form>`,
    html`${cancel}${next()}`,
  );
}

/** A channel that takes reels (Facebook, Instagram, Pinterest): an image post, a reel, or both. */
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
          <div><b>Image post</b><span>Its own picture with a short post written from the article, by the channel's rules.</span></div></label>
        <label class="ch-option"><input type="checkbox" name="postReel" value="1" ${checked(picks.reel)} />
          <div><b>Reel</b><span>The article's reel, made once on the Reels page (uses Google Flow video credits), shared here by itself as soon as it is made.</span></div></label>
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

/**
 * The Channels page, the same system as Websites: one "Add channel" button
 * (a wizard), then a card per channel with its settings in parts. Each part
 * has one Change button that opens just that part in the wizard frame.
 */
/** Sort channels by platform order (Buffer list order), then name. */
export function sortChannelsByPlatform(channels: ChannelRow[]): ChannelRow[] {
  const order = (p: string) => {
    const i = PLATFORMS.findIndex((x) => x.key === p);
    return i < 0 ? PLATFORMS.length : i;
  };
  return [...channels].sort((a, b) => order(a.platform) - order(b.platform) || a.name.localeCompare(b.name));
}

/**
 * The Channels page, organized by website.
 * Each website has its own dedicated section containing all its connected social media accounts.
 */
export function channelsPage(
  channels: ChannelRow[],
  websitesOf: Map<number, string[]>,
  rulesOf: Map<number, RulesCheck>,
  websites: NewWebsiteRow[] = [],
  selectedWebsiteId?: number,
): Html {
  // Sort channels by platform order for consistent display
  const sortedChannels = sortChannelsByPlatform(channels);

  // Group channels by website
  const siteChannelsMap = new Map<number, ChannelRow[]>();
  for (const site of websites) {
    const siteChs = sortedChannels.filter((c) => (websitesOf.get(c.id) ?? []).includes(site.name));
    siteChannelsMap.set(site.id, siteChs);
  }

  // Channels not connected to any website
  const unassigned = sortedChannels.filter((c) => (websitesOf.get(c.id) ?? []).length === 0);

  const visibleWebsites = selectedWebsiteId
    ? websites.filter((s) => s.id === selectedWebsiteId)
    : websites;

  const addHref = selectedWebsiteId
    ? `/new-website/channels/add?website=${String(selectedWebsiteId)}`
    : '/new-website/channels/add';

  return html`
    <style>${raw(CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Social channels</h1>
        <p class="ns-lede">Social media accounts organized by website. Manage each website and all its connected social channels (Facebook, Instagram, Pinterest, YouTube, etc.) in one place.</p>
      </div>
      ${channels.length || websites.length ? html`<a class="ns-btn primary" href="${addHref}">Add channel</a>` : raw('')}
    </div>

    ${websites.length > 1
      ? html`<nav class="ch-tabs" aria-label="Filter channels by website">
          <a class="ch-tab ${!selectedWebsiteId ? 'on' : ''}" href="/new-website/channels">
            All websites <span class="n">(${String(websites.length)})</span>
          </a>
          ${websites.map((s) => {
            const count = siteChannelsMap.get(s.id)?.length ?? 0;
            const isSel = selectedWebsiteId === s.id;
            return html`<a class="ch-tab ${isSel ? 'on' : ''}" href="/new-website/channels?website=${String(s.id)}">
              ${s.name} <span class="n">(${String(count)})</span>
            </a>`;
          })}
        </nav>`
      : raw('')}

    ${visibleWebsites.length
      ? html`${visibleWebsites.map((s) => {
          const mine = siteChannelsMap.get(s.id) ?? [];
          return html`<section class="ch-site-section" id="website-${String(s.id)}">
            <div class="ch-site-section-head">
              <div class="ch-site-section-title-wrap">
                <div class="ch-site-section-title">
                  <h2>${s.name}</h2>
                  <span class="ns-mono" style="font-size:14px;color:var(--soft);font-weight:400">${s.domain}</span>
                  <span class="ch-count">${mine.length === 1 ? '1 channel' : `${mine.length} channels`}</span>
                </div>
                <div class="ch-site-section-meta">
                  <span class="ns-badge ${s.social_status === 'paused' ? 'bad' : 'good'}">Social: ${s.social_status === 'paused' ? 'Paused' : 'Active'}</span>
                  ${s.social_daily_target ? html`<span>Target: <b>${String(s.social_daily_target)}/day</b></span>` : raw('')}
                  <span>${s.social_auto_publish === 0 ? 'Manual approval' : 'Auto publish'}</span>
                </div>
              </div>
              <div class="ch-site-section-actions">
                <a class="ns-btn small primary" href="/new-website/channels/add?website=${String(s.id)}">+ Add channel</a>
                <a class="ns-btn small quiet" href="/new-website/${String(s.id)}/edit?section=4">Channel settings</a>
                <a class="ns-btn small quiet" href="/new-website/sharing/site/${String(s.id)}">Social posts</a>
              </div>
            </div>
            ${mine.length
              ? html`<div class="ch-cards">${mine.map((c) => channelCard(c, websitesOf.get(c.id) ?? [], rulesOf.get(c.id)!))}</div>`
              : html`<div class="ch-site-empty">
                  <p>No social media channels connected to <b>${s.name}</b> yet.</p>
                  <a class="ns-btn small primary" href="/new-website/channels/add?website=${String(s.id)}">Connect a channel for ${s.name}</a>
                </div>`}
          </section>`;
        })}
        ${!selectedWebsiteId && unassigned.length
          ? html`<section class="ch-site-section ch-unassigned">
              <div class="ch-site-section-head">
                <div class="ch-site-section-title-wrap">
                  <div class="ch-site-section-title">
                    <h2>Unassigned channels</h2>
                    <span class="ch-count">${unassigned.length === 1 ? '1 channel' : `${unassigned.length} channels`}</span>
                  </div>
                  <div class="ch-site-section-meta">These channels are not connected to any website yet.</div>
                </div>
              </div>
              <div class="ch-cards">${unassigned.map((c) => channelCard(c, [], rulesOf.get(c.id)!))}</div>
            </section>`
          : raw('')}`
      : channels.length
        ? html`<div class="ch-cards">${sortedChannels.map((c) => channelCard(c, websitesOf.get(c.id) ?? [], rulesOf.get(c.id)!))}</div>`
        : html`<div class="ch-empty">
            <h2>No channels yet</h2>
            <p>Add a Pinterest account, a Facebook page or another platform to share your articles on.</p>
            <a class="ns-btn primary" href="/new-website/channels/add">Add channel</a>
          </div>`}
    ${raw(TOGGLE_SCRIPT)}`;
}

/** Channels grouped by platform, in the order of Buffer's list. */
export function groupsOf(channels: ChannelRow[]): [string, ChannelRow[]][] {
  const order = (p: string) => {
    const i = PLATFORMS.findIndex((x) => x.key === p);
    return i < 0 ? PLATFORMS.length : i;
  };
  const platforms = [...new Set(channels.map((c) => c.platform))].sort((a, b) => order(a) - order(b));
  return platforms.map((p) => [p, channels.filter((c) => c.platform === p)]);
}

/** Opens and closes the cards; each card remembers whether it was open, in this browser. */
const TOGGLE_SCRIPT = `<script>
(function () {
  document.querySelectorAll('.ch-site[data-toggle]').forEach(function (card) {
    var key = 'ch-open-' + card.getAttribute('data-id');
    var head = card.querySelector('.ch-toggle');
    function set(open) {
      card.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    var saved = null;
    try { saved = localStorage.getItem(key); } catch (e) {}
    set(saved === '1' || location.hash === '#' + card.id);
    head.addEventListener('click', function () {
      var open = !card.classList.contains('open');
      set(open);
      try { localStorage.setItem(key, open ? '1' : '0'); } catch (e) {}
    });
  });
})();
</script>`;

/** One part of a channel, with the one button that changes it. */
const part = (c: ChannelRow, key: string, title: string, rows: [string, string | Html][], button = 'Change'): Html => html`
  <section class="ch-part">
    <div class="ch-part-head"><h3>${title}</h3><a class="ns-btn small" href="/new-website/channels/${String(c.id)}/edit/${key}">${button}</a></div>
    <dl>${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
  </section>`;

/** A channel's card: its name, then its settings in parts. */
export function channelCard(c: ChannelRow, websites: string[], rules: RulesCheck, alwaysOpen = false): Html {
  const reels = takesReels(c.platform);
  const firstComment = rules.rules?.link === 'first_comment';
  return html`<article class="ch-site ${alwaysOpen ? 'open' : ''}" id="channel-${String(c.id)}" data-id="${String(c.id)}" ${raw(alwaysOpen ? '' : 'data-toggle')}
      style="--ch-color:${channelColor(c)}">
    <div class="ch-site-top">
      <button type="button" class="ch-toggle" aria-expanded="${alwaysOpen ? 'true' : 'false'}" aria-controls="channel-body-${String(c.id)}">
        <span class="ch-toggle-text">
          <span class="ch-name">${c.name}</span>
          <span class="ch-meta"><span>${platformLabel(c.platform)}</span><span>${c.via === 'buffer' ? 'Through Buffer' : `Through ${apiName(c.platform)}`}</span><span>${websites.length ? websites.join(', ') : 'No website yet'}</span></span>
        </span>
        ${rules.rules ? raw('') : html`<span class="ns-badge bad">Rules have problems</span>`}
        ${alwaysOpen ? raw('') : raw('<svg class="ch-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>')}
      </button>
      <form method="post" action="/new-website/channels/${String(c.id)}/delete" data-name="${c.name}"
            onsubmit="return confirm('Remove ' + this.dataset.name + '? Websites stop posting to it.')">
        <button class="ns-btn danger small">Remove</button>
      </form>
    </div>
    <div class="ch-parts" id="channel-body-${String(c.id)}">
      ${part(c, 'connection', 'Connection', [
        ['Platform', platformLabel(c.platform)],
        ['Posts through', c.via === 'buffer' ? 'Buffer' : apiName(c.platform).replace(/^the /, 'The ')],
      ], 'Check')}
      ${part(c, 'websites', 'Websites', [
        ['Shares articles of', websites.length ? websites.join(', ') : 'No website yet'],
        ['Several websites', c.multi_website ? 'Yes' : 'No, one only'],
      ])}
      ${reels
        ? part(c, 'posts', 'What to post', [['Each article gets', [c.post_image ? 'An image post' : '', c.post_reel ? 'A reel' : ''].filter(Boolean).join(' and ') || 'Nothing']])
        : raw('')}
      ${takesApiComment(c)
        ? part(c, 'comment', 'First comment through the API', [
            ['The article link', commentsThroughApi(c) ? `Commented through the Facebook Graph API once Buffer has posted (${c.platform === 'instagram' ? 'as the Instagram account' : 'as the page'})` : 'Not set up'],
          ], commentsThroughApi(c) ? 'Change' : 'Set up')
        : raw('')}
      ${c.via === 'buffer' && firstComment ? part(c, 'plan', 'Buffer plan', [['Plan', c.paid_buffer ? 'Paid (first comment with the link)' : 'Free (posts go out with no link)']]) : raw('')}
      ${part(c, 'rules', 'Rules', [
        ['State', rules.rules ? html`<span class="ns-badge ok">Rules OK</span>` : html`<span class="ns-badge bad">Rules have problems</span>`],
        ['Each post', rules.rules ? `${rules.rules.postLabel}, with ${rules.rules.fields.join(', ')}` : rules.errors[0] ?? ''],
      ])}
    </div>
  </article>`;
}

/** The page of one channel: its card. */
export function channelPage(c: ChannelRow, websites: string[], rules: RulesCheck): Html {
  return html`
    <style>${raw(CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">${c.name}</h1>
        <p class="ns-lede">${platformLabel(c.platform)} channel. Use Change on a part to edit just that part.</p>
      </div>
      <a class="ns-btn quiet" href="/new-website/channels">All channels</a>
    </div>
    ${channelCard(c, websites, rules, true)}`;
}

/* -- Adding a channel: choose the platform, then how it posts -------------- */

const ADD_STEPS = ['Platform', 'How it posts'];

function addWizard(step: number, body: Html, foot: Html, error = ''): Html {
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    <div class="wz">
      <div class="wz-head">
        <h1>Add a channel</h1>
        <p class="wz-id">Choose where to share, then connect it.</p>
        <div class="wz-bar" style="grid-template-columns:repeat(${ADD_STEPS.length},1fr)">${ADD_STEPS.map((_, i) => html`<i class="${i <= step ? 'on' : ''}"></i>`)}</div>
        <div class="wz-stepname">Step ${step + 1} of ${ADD_STEPS.length}: ${ADD_STEPS[step]}</div>
      </div>
      <div class="wz-body">${error ? html`<p class="ch-bad" role="alert">${error}</p>` : raw('')}${body}</div>
      <div class="wz-foot">${foot}</div>
    </div>`;
}

export function addPlatformStep(platforms: { key: string; label: string; ready: boolean }[], error = '', website = ''): Html {
  return addWizard(
    0,
    html`<form id="ch-form" method="post" action="/new-website/channels/add${website ? `?website=${encodeURIComponent(website)}` : ''}">
      ${website ? html`<input type="hidden" name="website" value="${website}" />` : raw('')}
      <h2>Platform</h2>
      <p>Where this channel shares your articles.</p>
      <div class="ch-pick ch-pick-grid">
        ${platforms.map(
          (p, i) => html`<label class="ch-option"><input type="radio" name="platform" value="${p.key}" ${checked(i === 0)} />
            <div><b>${p.label}</b><span>${p.ready ? 'Ready-made rules' : 'Starts with simple rules you can change'}</span></div></label>`,
        )}
      </div>
    </form>`,
    html`<a class="ns-btn quiet" href="/new-website/channels${website ? `?website=${encodeURIComponent(website)}` : ''}">Cancel</a><button class="ns-btn primary" form="ch-form">Next</button>`,
    error,
  );
}

export function addViaStep(platform: string, website = ''): Html {
  return addWizard(
    1,
    html`<form id="ch-form" method="post" action="/new-website/channels/add/via${website ? `?website=${encodeURIComponent(website)}` : ''}">
      <input type="hidden" name="platform" value="${platform}" />
      ${website ? html`<input type="hidden" name="website" value="${website}" />` : raw('')}
      <h2>How it posts</h2>
      <p>${platformLabel(platform)} can post through Buffer or through its own API. A channel uses one of them only.</p>
      <div class="ch-pick">
        <label class="ch-option"><input type="radio" name="via" value="buffer" checked />
          <div><b>Through Buffer</b><span>Buffer queues the posts and sends them at its times.</span></div></label>
        <label class="ch-option"><input type="radio" name="via" value="api" />
          <div><b>Through ${apiName(platform)}</b><span>${platform === 'facebook'
            ? 'Posts straight to the page, with the link as the first comment.'
            : platform === 'instagram'
              ? 'Posts straight to the account, through the Facebook page it is linked to, at once.'
              : 'Posts straight to your Threads profile, at once.'}</span></div></label>
      </div>
    </form>`,
    html`<a class="ns-btn quiet" href="/new-website/channels/add${website ? `?website=${encodeURIComponent(website)}` : ''}">Previous</a><button class="ns-btn primary" form="ch-form">Next</button>`,
  );
}

/* -- Changing one part of a channel, in the wizard frame --------------------- */

export const PART_TITLE: Record<string, string> = {
  connection: 'Connection',
  websites: 'Websites',
  posts: 'What to post',
  plan: 'Buffer plan',
  comment: 'First comment through the API',
  rules: 'Rules',
};

/** The wizard frame for one part of a saved channel: its title, the part, Cancel and Save. */
export function partPage(c: ChannelRow, key: string, body: Html, opts: { error?: string | string[]; save?: boolean; wide?: boolean } = {}): Html {
  const errors = Array.isArray(opts.error) ? opts.error : opts.error ? [opts.error] : [];
  const back = `/new-website/channels/${String(c.id)}`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    <div class="wz ${opts.wide ? 'ch-wz-wide' : ''}">
      <div class="wz-head">
        <h1>${c.name}: ${PART_TITLE[key] ?? key}</h1>
        <p class="wz-id">${platformLabel(c.platform)} channel. Only this part changes.</p>
      </div>
      <form id="ch-form" method="post" action="${back}/edit/${key}">
        <div class="wz-body">
          ${errors.length
            ? html`<div class="ch-bad" role="alert"><b>Not saved. Fix this and save again:</b><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`
            : raw('')}
          ${body}
        </div>
        <div class="wz-foot">
          <a class="ns-btn quiet" href="${back}">${opts.save === false ? 'Back to the channel' : 'Cancel'}</a>
          ${opts.save === false ? html`<button class="ns-btn primary">Check again</button>` : html`<button class="ns-btn primary">Save</button>`}
        </div>
      </form>
    </div>`;
}

export const connectionPart = (c: ChannelRow, result: { ok: boolean; text: string }): Html =>
  partPage(
    c,
    'connection',
    html`<h2>Connection</h2>
      <p>The platform was asked, just now, whether this channel can still post.</p>
      <p class="${result.ok ? 'ch-ok' : 'ch-bad'}">${result.text}</p>`,
    { save: false },
  );

export const websitesPart = (c: ChannelRow, websites: WebsiteChoice[], error = ''): Html =>
  partPage(c, 'websites', html`<h2>Websites</h2><p>Which websites share their articles on this channel.</p>${websiteBoxes(websites, Boolean(c.multi_website))}`, { error });

export const postsPart = (c: ChannelRow, error = ''): Html =>
  partPage(
    c,
    'posts',
    html`<h2>What to post</h2><p>For each article. One of them or both.</p>
      <div class="ch-pick">
        <label class="ch-option"><input type="checkbox" name="postImage" value="1" ${checked(Boolean(c.post_image))} />
          <div><b>Image post</b><span>Its own picture and words, made from the article.</span></div></label>
        <label class="ch-option"><input type="checkbox" name="postReel" value="1" ${checked(Boolean(c.post_reel))} />
          <div><b>Reel</b><span>The article's reel, made once on the Reels page, shared here by itself as soon as it is made. Without it, reels can still be sent here from the Reels page.</span></div></label>
      </div>`,
    { error },
  );

/** A Buffer channel whose posts can get their first comment through the Graph API. */
export const takesApiComment = (c: Pick<ChannelRow, 'via' | 'platform'>): boolean =>
  c.via === 'buffer' && (COMMENT_PLATFORMS as readonly string[]).includes(c.platform);

/**
 * The first comment through the API: a Facebook token, then the page (or the
 * Instagram account linked to a page) that this Buffer channel is.
 */
export function commentPart(
  c: ChannelRow,
  opts: { choices?: PickChoice[]; draft?: string; selected?: string; error?: string; hasToken?: boolean } = {},
): Html {
  const ig = c.platform === 'instagram';
  const what = ig ? 'Instagram account' : 'page';
  const body = opts.choices
    ? html`<h2>Which ${what} is this?</h2>
        <p>Pick the ${what} that Buffer posts to on this channel. The link is commented there.</p>
        <input type="hidden" name="draft" value="${opts.draft ?? ''}" />
        <div class="ch-pick">${opts.choices.map(
          (ch) => html`<label class="ch-option"><input type="radio" name="pick" value="${ch.id}" ${checked(ch.id === opts.selected)} required />
            <div><b>${ch.name}</b><span>${ch.note}</span></div></label>`,
        )}</div>`
    : html`<h2>First comment through the API</h2>
        <p>Buffer keeps posting. Once a post is out, the platform finds it on ${ig ? 'Instagram' : 'the page'} and adds the article link as its first comment through the Facebook Graph API.${ig ? ' Instagram does not make the link clickable, but people can copy it.' : ''}</p>
        <p>Paste the Facebook business access token (a system user token from Business Manager). It needs <b>pages_show_list</b>, <b>pages_read_engagement</b> and ${ig ? html`<b>instagram_basic</b> and <b>instagram_manage_comments</b>` : html`<b>pages_manage_engagement</b>`}.${opts.hasToken ? ' Leave it empty to use the token already saved.' : ''}</p>
        ${field('token', 'Facebook access token', html`<input id="wz-token" name="token" type="password" spellcheck="false" autocomplete="off" ${raw(opts.hasToken ? '' : 'required')} />`)}
        ${commentsThroughApi(c) ? html`<label class="ch-option"><input type="checkbox" name="off" value="1" /><div><b>Stop commenting through the API</b><span>Posts then get the link only from Buffer's paid plan, or none.</span></div></label>` : raw('')}`;
  return partPage(c, 'comment', body, { error: opts.error });
}

export const planPart = (c: ChannelRow): Html =>
  partPage(c, 'plan', html`<h2>Buffer plan</h2><p>The article link goes in the first comment, never in the post. The platform cannot see your Buffer plan, so tell it here.</p>${paidBox(Boolean(c.paid_buffer))}`);

/** The channel's rules in a plain text box: read, change, save. */
export const rulesPart = (c: ChannelRow, text: string, errors: string[] = []): Html =>
  partPage(
    c,
    'rules',
    html`<h2>Rules</h2>
      <p>What this channel writes and makes for each published article. Change the text and click Save: this channel’s next post uses it. Other channels keep their own rules.</p>
      <p class="ch-editor-help">The lines between the two <code>---</code> say what to make: <b>fields</b> are what the AI writes, <b>post_text</b> is the field that becomes the post, <b>picture_shape</b> is PORTRAIT_3_4 or HORIZONTAL, <b>link</b> is pin_link, first_comment or none. Under <b>## Limits</b>, a line like <code>- title_chars: 40-100</code> is checked on every post.</p>
      <textarea id="ch-rules-text" name="rules" class="ch-editor" spellcheck="false" aria-label="Rules">${text}</textarea>
      <label class="wz-check" style="margin:12px 0 0"><input type="checkbox" name="reset" value="1" /> Replace them with the default rules for ${platformLabel(c.platform)}</label>`,
    { error: errors, wide: true },
  );
