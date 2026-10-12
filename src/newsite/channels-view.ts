import { html, raw, type Html } from '../web/views/layout.js';
import { PLATFORMS, type ChannelRow } from './channels.js';
import { WIZARD_CSS, field } from './view.js';

/**
 * The Channels page and the channel wizards.
 *
 * Every wizard is the same pattern: a few short steps, one page each, plain
 * labels, and a check at the end. A token pasted in step 1 stays on the
 * server between steps (see channels-routes.ts) and is never put back into a
 * page.
 */

const CSS = `
.ch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.ch-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.ch-card.soon { opacity: .6; }
.ch-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.ch-top h2 { font-size: 18px; }
.ch-soon { font-size: 12px; font-weight: 600; color: var(--faint); text-transform: uppercase; letter-spacing: .04em; }
.ch-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ch-list a { display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: var(--r-ctl); background: var(--raised);
  text-decoration: none; font-size: 14px; }
.ch-list a:hover { color: var(--accent); }
.ch-list small { color: var(--faint); white-space: nowrap; }
.ch-none { color: var(--soft); font-size: 14px; margin: 0; }
.ch-card .ns-btn { align-self: flex-start; }
.ch-pick { display: grid; gap: 10px; margin-bottom: 20px; }
.ch-option { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r-ctl); cursor: pointer; }
.ch-option:hover { border-color: var(--line-strong); background: var(--raised); }
.ch-option input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--accent); }
.ch-option b { display: block; font-weight: 600; }
.ch-option span { color: var(--soft); font-size: 13px; }
.ch-option.off { opacity: .55; cursor: not-allowed; }
.ch-warn { color: var(--bad); font-weight: 600; font-size: 14px; border-left: 3px solid var(--bad); padding: 8px 0 8px 12px; margin: 0 0 20px; }
.ch-ok { color: var(--good); font-weight: 600; border-left: 3px solid var(--good); padding: 8px 0 8px 12px; margin: 0 0 16px; }
.ch-bad { color: var(--bad); font-weight: 600; border-left: 3px solid var(--bad); padding: 8px 0 8px 12px; margin: 0 0 16px; }
.ch-facts { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; margin: 0 0 20px; font-size: 14px; }
.ch-facts dt { color: var(--soft); }
.ch-facts dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
@media (max-width: 640px) { .ch-facts { grid-template-columns: 1fr; gap: 2px; } }
`;

const platformLabel = (key: string): string => PLATFORMS.find((p) => p.key === key)?.label ?? key;

/** The Channels page: every platform, its channels, and a way to add one. */
export function channelsPage(channels: ChannelRow[], usedBy: Map<number, number>): Html {
  return html`
    <style>${raw(CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Channels</h1>
        <p class="ns-lede">Where your articles are shared. Set each channel up once here; then each website chooses its channels in its own setup.</p>
      </div>
    </div>
    <div class="ch-grid">
      ${PLATFORMS.map((p) => {
        const mine = channels.filter((c) => c.platform === p.key);
        return html`<section class="ch-card ${p.built ? '' : 'soon'}">
          <div class="ch-top"><h2>${p.label}</h2>${p.built ? raw('') : html`<span class="ch-soon">Coming soon</span>`}</div>
          ${p.built
            ? html`${mine.length
                ? html`<ul class="ch-list">${mine.map(
                    (c) => html`<li><a href="/new-website/channels/${c.id}"><span>${c.name}</span><small>${(usedBy.get(c.id) ?? 0) === 1 ? '1 website' : `${usedBy.get(c.id) ?? 0} websites`}</small></a></li>`,
                  )}</ul>`
                : html`<p class="ch-none">No ${p.label} channel yet.</p>`}
                <a class="ns-btn ${mine.length ? 'quiet' : 'primary'}" href="/new-website/channels/${p.key}/new">Add ${p.label}</a>`
            : html`<p class="ch-none">Through Buffer, later.</p>`}
        </section>`;
      })}
    </div>`;
}

/** The shell every channel wizard step shares. */
function wizard(title: string, sub: string, names: string[], step: number, body: Html, foot: Html, error = ''): Html {
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    <div class="wz">
      <div class="wz-head">
        <h1>${title}</h1>
        <p class="wz-id">${sub}</p>
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

const back = html`<a class="ns-btn quiet" href="/new-website/channels">Cancel</a>`;

/* -- Pinterest ------------------------------------------------------------ */

const PIN_STEPS = ['Connect', 'Pick the channel', 'Check'];

export function pinterestConnectStep(error = ''): Html {
  return wizard(
    'Add Pinterest',
    'Through a Buffer account',
    PIN_STEPS,
    0,
    html`<form id="ch-form" method="post" action="/new-website/channels/pinterest/connect">
      <h2>Connect</h2>
      <p>Paste the Buffer access token of the account this Pinterest channel is in. Each Pinterest channel has its own Buffer account.</p>
      ${field('bufferToken', 'Buffer access token', html`<input id="wz-bufferToken" name="bufferToken" type="password" spellcheck="false" autocomplete="off" required />`, {
        hint: 'In Buffer: Settings → API → Access token.',
      })}
    </form>`,
    html`${back}<button class="ns-btn primary" form="ch-form">Next</button>`,
    error,
  );
}

export interface PinChoice {
  id: string;
  name: string;
  boards: number;
}

export function pinterestPickStep(draft: string, choices: PinChoice[], error = ''): Html {
  return wizard(
    'Add Pinterest',
    'Through a Buffer account',
    PIN_STEPS,
    1,
    html`<form id="ch-form" method="post" action="/new-website/channels/pinterest/save">
      <input type="hidden" name="draft" value="${draft}" />
      <h2>Pick the channel</h2>
      <p>The Pinterest channels in this Buffer account. Pins go to the boards of the one you pick; the AI chooses the board for each article.</p>
      <div class="ch-pick">
        ${choices.map(
          (c, i) => html`<label class="ch-option"><input type="radio" name="channelId" value="${c.id}" ${i === 0 ? raw('checked') : raw('')} />
            <div><b>${c.name}</b><span>${c.boards === 1 ? '1 board' : `${c.boards} boards`}</span></div></label>`,
        )}
      </div>
      <label class="wz-check"><input type="checkbox" name="multiWebsite" value="1" /> Connect this channel to multiple websites</label>
    </form>`,
    html`<a class="ns-btn quiet" href="/new-website/channels/pinterest/new">Previous</a><button class="ns-btn primary" form="ch-form">Next: check</button>`,
    error,
  );
}

/* -- Facebook ------------------------------------------------------------- */

const FB_STEPS = ['Connect', 'Pick pages', 'Check', 'Buffer plan', 'What to post'];

export function facebookConnectStep(error = ''): Html {
  return wizard(
    'Add Facebook',
    'Facebook pages',
    FB_STEPS,
    0,
    html`<form id="ch-form" method="post" action="/new-website/channels/facebook/connect">
      <h2>Connect</h2>
      <p>Paste the Facebook business access token (a system user token from Business Manager). It needs <b>pages_manage_posts</b> and <b>pages_manage_engagement</b>, so the platform can post and add the link comment.</p>
      ${field('fbToken', 'Facebook access token', html`<input id="wz-fbToken" name="fbToken" type="password" spellcheck="false" autocomplete="off" required />`)}
    </form>`,
    html`${back}<button class="ns-btn primary" form="ch-form">Next</button>`,
    error,
  );
}

export function facebookPickStep(draft: string, pages: { id: string; name: string; taken: boolean }[], error = ''): Html {
  return wizard(
    'Add Facebook',
    'Facebook pages',
    FB_STEPS,
    1,
    html`<form id="ch-form" method="post" action="/new-website/channels/facebook/check">
      <input type="hidden" name="draft" value="${draft}" />
      <h2>Pick pages</h2>
      <p>Each page you pick becomes its own channel. Websites choose their pages in their own setup.</p>
      <div class="ch-pick">
        ${pages.map(
          (p) => html`<label class="ch-option"><input type="checkbox" name="pageId" value="${p.id}" />
            <div><b>${p.name}</b><span>${p.taken ? 'Already a channel: picking it again updates it' : `Page ${p.id}`}</span></div></label>`,
        )}
      </div>
    </form>`,
    html`<a class="ns-btn quiet" href="/new-website/channels/facebook/new">Previous</a><button class="ns-btn primary" form="ch-form">Next: check</button>`,
    error,
  );
}

export function facebookCheckStep(draft: string, results: { name: string; ok: boolean; error?: string }[]): Html {
  const allOk = results.every((r) => r.ok);
  return wizard(
    'Add Facebook',
    'Facebook pages',
    FB_STEPS,
    2,
    html`<form id="ch-form" method="get" action="/new-website/channels/facebook/plan">
      <input type="hidden" name="draft" value="${draft}" />
      <h2>Check</h2>
      <p>Each page was asked for its posting token.</p>
      ${results.map((r) => (r.ok ? html`<p class="ch-ok">${r.name}: connected.</p>` : html`<p class="ch-bad">${r.name}: ${r.error}</p>`))}
    </form>`,
    html`<a class="ns-btn quiet" href="/new-website/channels/facebook/new">Start again</a>${allOk
      ? html`<button class="ns-btn primary" form="ch-form">Next</button>`
      : html`<span class="wz-hint">Fix the pages that failed, then start again.</span>`}`,
  );
}

export const BUFFER_FREE_WARNING =
  "Buffer’s free plan cannot add the link in the first comment. The link comment is posted through the Facebook API with this page's token, or upgrade Buffer to a paid plan to unlock first comments.";

export function facebookPlanStep(draft: string): Html {
  return wizard(
    'Add Facebook',
    'Facebook pages',
    FB_STEPS,
    3,
    html`<form id="ch-form" method="get" action="/new-website/channels/facebook/post">
      <input type="hidden" name="draft" value="${draft}" />
      <h2>Buffer plan</h2>
      <p>The article link always goes in the first comment, never in the post. The platform cannot see your Buffer plan, so tell it here.</p>
      <label class="wz-check" style="margin:0 0 16px"><input type="checkbox" name="paidBuffer" value="1" id="ch-paid" /> I have a paid Buffer plan (first comment unlocked)</label>
      <p class="ch-warn" id="ch-warn">${BUFFER_FREE_WARNING}</p>
      <script>
        (function () {
          var box = document.getElementById('ch-paid'), warn = document.getElementById('ch-warn');
          box.addEventListener('change', function () { warn.style.display = box.checked ? 'none' : ''; });
        })();
      </script>
    </form>`,
    html`<a class="ns-btn quiet" href="javascript:history.back()">Previous</a><button class="ns-btn primary" form="ch-form">Next</button>`,
  );
}

export function facebookPostStep(draft: string, paidBuffer: boolean, error = ''): Html {
  return wizard(
    'Add Facebook',
    'Facebook pages',
    FB_STEPS,
    4,
    html`<form id="ch-form" method="post" action="/new-website/channels/facebook/save">
      <input type="hidden" name="draft" value="${draft}" />
      <input type="hidden" name="paidBuffer" value="${paidBuffer ? '1' : ''}" />
      <h2>What to post</h2>
      <p>For each article, these go to every page you picked. One of them or both.</p>
      <div class="ch-pick">
        <label class="ch-option"><input type="checkbox" name="postImage" value="1" checked />
          <div><b>Image post</b><span>The article's feature picture with a short post written for Facebook. The link goes in the first comment.</span></div></label>
        <label class="ch-option"><input type="checkbox" name="postReel" value="1" />
          <div><b>Reel</b><span>A short video made from the article's pictures (uses Google Flow video credits). The link goes in the first comment. Reels for the new websites come next: picking it now saves the choice.</span></div></label>
      </div>
      <label class="wz-check"><input type="checkbox" name="multiWebsite" value="1" /> Connect these pages to multiple websites</label>
    </form>`,
    html`<a class="ns-btn quiet" href="javascript:history.back()">Previous</a><button class="ns-btn primary" form="ch-form">Save</button>`,
    error,
  );
}

/* -- One channel ---------------------------------------------------------- */

export function channelPage(c: ChannelRow, websites: string[], check: { ok: boolean; text: string } | null): Html {
  const isFb = c.platform === 'facebook';
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">${c.name}</h1>
        <p class="ns-lede">${platformLabel(c.platform)} channel</p>
      </div>
      <a class="ns-btn quiet" href="/new-website/channels">All channels</a>
    </div>
    ${check ? html`<p class="${check.ok ? 'ch-ok' : 'ch-bad'}">${check.text}</p>` : raw('')}
    <dl class="ch-facts">
      <dt>Platform</dt><dd>${platformLabel(c.platform)}${isFb ? ' (Facebook API)' : ' (through Buffer)'}</dd>
      <dt>Used by</dt><dd>${websites.length ? websites.join(', ') : 'No website yet: pick it in a website’s setup.'}</dd>
      ${isFb ? html`<dt>Posts</dt><dd>${[c.post_image ? 'Image post' : '', c.post_reel ? 'Reel (coming next)' : ''].filter(Boolean).join(' and ') || 'Nothing'}</dd>` : raw('')}
    </dl>
    <form method="post" action="/new-website/channels/${c.id}/settings" class="wz" style="max-width:none">
      <div class="wz-body">
        <h2 style="font-size:18px;margin:0 0 16px">Settings</h2>
        <label class="wz-check" style="margin:0 0 12px"><input type="checkbox" name="multiWebsite" value="1" ${c.multi_website ? raw('checked') : raw('')} /> Connect this channel to multiple websites</label>
        ${isFb
          ? html`<label class="wz-check" style="margin:0 0 12px"><input type="checkbox" name="paidBuffer" value="1" ${c.paid_buffer ? raw('checked') : raw('')} /> I have a paid Buffer plan (first comment unlocked)</label>
            ${c.paid_buffer ? raw('') : html`<p class="ch-warn">${BUFFER_FREE_WARNING}</p>`}
            <label class="wz-check" style="margin:0 0 12px"><input type="checkbox" name="postImage" value="1" ${c.post_image ? raw('checked') : raw('')} /> Post an image post for each article</label>
            <label class="wz-check" style="margin:0 0 12px"><input type="checkbox" name="postReel" value="1" ${c.post_reel ? raw('checked') : raw('')} /> Post a reel for each article (coming next)</label>`
          : raw('')}
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
