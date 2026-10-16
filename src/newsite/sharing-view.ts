import { html, raw, type Html } from '../web/views/layout.js';
import type { NewWebsiteRow } from './repo.js';
import type { SeoRow } from './seo.js';
import type { ChannelRow } from './channels.js';
import type { SocialPostRow } from './social.js';
import type { PictureRow } from './pictures.js';
import { WIZARD_CSS } from './view.js';
import { CHEV, CSS, OVERVIEW_CSS, labelOf, missingChannels, shareCard, sharingBusy } from './keywords-view.js';

/**
 * The Sharing page: the last step of the platform. Every published article,
 * by website, with the post each channel made from it: its words, its
 * picture, where it stands, and what you can do. Posts start by themselves
 * once an article is published; the Share articles wizard is for the rest.
 */

/** One published article, with the keyword plan it came from. */
export interface SharingArticle {
  row: SeoRow;
  intent: string;
  planId: number;
  pillar: string;
}

export interface SharingSite {
  site: NewWebsiteRow;
  /** The channels this website shares on. */
  channels: ChannelRow[];
  articles: SharingArticle[];
  posts: SocialPostRow[];
  pictures: PictureRow[];
  /** Articles of this website not published yet. */
  unpublished: number;
}

const SHARING_CSS = `
.sh-sum { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; }
.sh-channels { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 0; font-size: 14px; color: var(--soft); }
.sh-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 16px; }
.sh-plan { color: var(--faint); font-size: 13px; margin: 18px 0 8px; }
.sh-plan a { color: var(--soft); }
.sh-pick { display: grid; gap: 10px; }
.sh-pick .ch-option span.sh-missing { display: block; margin-top: 2px; }
`;

/** Where each website stands, in counts. */
function countsOf(s: SharingSite) {
  const postsOf = (id: number) => s.posts.filter((p) => p.seo_id === id);
  const toShare = s.articles.filter((a) => missingChannels(postsOf(a.row.id), s.channels).length).length;
  return {
    published: s.articles.length,
    shared: s.articles.filter((a) => postsOf(a.row.id).length > 0 && postsOf(a.row.id).every((p) => p.status === 'sent')).length,
    making: s.posts.filter((p) => p.status === 'pending' || p.status === 'picture' || p.status === 'waiting').length,
    failed: s.posts.filter((p) => p.status === 'failed').length,
    toShare,
  };
}

function siteCard(s: SharingSite, allChannels: ChannelRow[], open: boolean, plan: { id: number; pillar: string } | null): Html {
  const c = countsOf(s);
  const articles = plan ? s.articles.filter((a) => a.planId === plan.id) : s.articles;
  // Grouped by keyword plan, in the order the plans were made.
  const plans = [...new Map(articles.map((a) => [a.planId, a.pillar])).entries()];
  const postsOf = (id: number) => s.posts.filter((p) => p.seo_id === id);
  return html`<article class="ko-site ${open ? 'open' : ''}" id="website-${String(s.site.id)}" data-id="${String(s.site.id)}">
    <button type="button" class="ko-head" aria-expanded="${open ? 'true' : 'false'}">
      <span class="ko-title"><span class="ko-name">${s.site.name}</span><span class="ko-domain">${s.site.domain}</span></span>
      <span class="ko-stats">
        <span><b>${String(c.published)}</b> published</span>
        <span><b>${String(c.shared)}</b> shared</span>
        ${c.making ? html`<span class="ns-badge busy">${String(c.making)} being made</span>` : raw('')}
        ${c.failed ? html`<span class="ns-badge bad">${String(c.failed)} failed</span>` : raw('')}
        ${c.toShare ? html`<span class="ns-badge">${String(c.toShare)} not on every channel</span>` : raw('')}
      </span>
      ${raw(CHEV)}
    </button>
    <div class="ko-body">
      ${s.channels.length
        ? html`<div class="sh-channels"><span>Shares on</span>${s.channels.map((ch) => html`<span class="ns-tag">${ch.name} · ${labelOf(ch.platform)}</span>`)}<a class="ns-btn small" href="/new-website/${String(s.site.id)}/edit?section=4">Change</a></div>`
        : html`<div class="ns-alert info" style="margin-top:16px"><b>${s.site.name} shares on no channel yet.</b> Pick its channels in the website’s settings, or add a channel first.
            <div class="kw-share-actions"><a class="ns-btn small" href="/new-website/${String(s.site.id)}/edit?section=4">Pick channels</a><a class="ns-btn small" href="/new-website/channels">Add a channel</a></div></div>`}
      ${plan ? html`<div class="sh-filter"><span class="ns-tag">Keyword plan: ${plan.pillar}</span><a class="ns-btn small" href="/new-website/sharing#website-${String(s.site.id)}">Show every article</a></div>` : raw('')}
      ${plans.length
        ? plans.map(([planId, pillar]) => html`
            <p class="sh-plan">From the keyword plan <a href="/new-website/keywords/plan/${String(planId)}/publish">${pillar}</a></p>
            <ul class="acc-list">${articles
              .filter((a) => a.planId === planId)
              .map((a) => shareCard(a.row, a.intent, postsOf(a.row.id), s.channels, allChannels, a.planId, s.pictures))}</ul>`)
        : html`<p class="ko-none">No published article${plan ? ' in this keyword plan' : ''} yet.</p>`}
      ${s.unpublished && !plan ? html`<p class="ko-none">${String(s.unpublished)} more article${s.unpublished === 1 ? '' : 's'} show here once published.</p>` : raw('')}
    </div>
  </article>`;
}

export function sharingPage(sites: SharingSite[], allChannels: ChannelRow[], plan: { id: number; pillar: string; websiteId: number } | null = null): Html {
  const total = sites.reduce(
    (t, s) => {
      const c = countsOf(s);
      return { published: t.published + c.published, making: t.making + c.making, failed: t.failed + c.failed, toShare: t.toShare + c.toShare };
    },
    { published: 0, making: 0, failed: 0, toShare: 0 },
  );
  const busy = sites.some((s) => sharingBusy(s.posts));
  return html`
    <style>${raw(CSS)}${raw(OVERVIEW_CSS)}${raw(SHARING_CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Sharing</h1>
        <p class="ns-lede">The last step. Once an article is published, each of its website’s channels makes its own post from it, by that channel’s rules: the words, then the picture, then it is sent. Everything is here, by website. The article link is never in a post’s words.</p>
      </div>
      ${sites.length ? html`<a class="ns-btn primary" href="/new-website/sharing/new">Share articles</a>` : raw('')}
    </div>
    ${sites.length
      ? html`<div class="sh-sum">
          <span class="ns-badge ok">${String(total.published)} published article${total.published === 1 ? '' : 's'}</span>
          ${total.making ? html`<span class="ns-badge busy">${String(total.making)} post${total.making === 1 ? '' : 's'} being made</span>` : raw('')}
          ${total.failed ? html`<span class="ns-badge bad">${String(total.failed)} failed</span>` : raw('')}
          ${total.toShare ? html`<span class="ns-badge">${String(total.toShare)} not on every channel</span>` : raw('')}
        </div>
        <div class="ko-cards" ${busy ? raw('data-watch="1"') : raw('')}>${sites.map((s) =>
          siteCard(s, allChannels, sites.length === 1 || plan?.websiteId === s.site.id, plan?.websiteId === s.site.id ? plan : null))}</div>`
      : html`<div class="ko-empty"><h2>Add a website first</h2><p>Articles are shared once they are published on a website.</p><a class="ns-btn primary" href="/new-website/add">Add website</a></div>`}
    ${raw(SHARING_SCRIPT)}`;
}

/** Opens and closes the cards (each remembers, in this browser), and reloads while posts are being made. */
const SHARING_SCRIPT = `<script>
(function () {
  document.querySelectorAll('.ko-site').forEach(function (card) {
    var key = 'sh-site-open-' + card.getAttribute('data-id');
    var head = card.querySelector('.ko-head');
    function set(open) { card.classList.toggle('open', open); head.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    var saved = null;
    try { saved = localStorage.getItem(key); } catch (e) {}
    if (saved !== null && !card.classList.contains('open')) set(saved === '1');
    if (location.hash === '#' + card.id) set(true);
    head.addEventListener('click', function () {
      var open = !card.classList.contains('open');
      set(open);
      try { localStorage.setItem(key, open ? '1' : '0'); } catch (e) {}
    });
  });
  document.querySelectorAll('.acc-head').forEach(function (b) {
    b.addEventListener('click', function () {
      var li = b.closest('.acc');
      var open = li.classList.toggle('open');
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
  if (!document.querySelector('[data-watch]')) return;
  var seen;
  setInterval(function () {
    fetch('/new-website/sharing/state').then(function (r) { return r.json(); }).then(function (r) {
      if (seen !== undefined && seen !== r.key) location.reload();
      seen = r.key;
    }).catch(function () {});
  }, 5000);
})();
</script>`;

/* -- The Share articles wizard: the website, then its articles --------------- */

const STEPS = ['Website', 'Articles'];

function shareWizard(step: number, body: Html, foot: Html, error = ''): Html {
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}${raw(OVERVIEW_CSS)}${raw(SHARING_CSS)}</style>
    <div class="wz">
      <div class="wz-head">
        <h1>Share articles</h1>
        <p class="wz-id">Published articles, shared on the channels they are not on yet.</p>
        <div class="wz-bar" style="grid-template-columns:repeat(${STEPS.length},1fr)">${STEPS.map((_, i) => html`<i class="${i <= step ? 'on' : ''}"></i>`)}</div>
        <div class="wz-stepname">Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}</div>
      </div>
      <div class="wz-body">${error ? html`<p class="kw-seo-problems" role="alert" style="margin:0 0 16px">${error}</p>` : raw('')}${body}</div>
      <div class="wz-foot">${foot}</div>
    </div>`;
}

export function shareWebsiteStep(sites: SharingSite[], chosen = 0): Html {
  const first = chosen || sites.find((s) => countsOf(s).toShare)?.site.id || sites[0]?.site.id;
  return shareWizard(
    0,
    html`<form id="sh-form" method="get" action="/new-website/sharing/new/articles">
      <h2>Website</h2>
      <p>Which website’s articles to share. Each one is shared on that website’s own channels.</p>
      <div class="sh-pick">${sites.map((s) => {
        const c = countsOf(s);
        return html`<label class="ch-option"><input type="radio" name="website" value="${String(s.site.id)}" ${s.site.id === first ? raw('checked') : raw('')} />
          <div><b>${s.site.name} · ${s.site.domain}</b><span>${String(c.published)} published · ${c.toShare ? `${c.toShare} not on every channel` : 'all shared'} · ${s.channels.length ? `${s.channels.length} channel${s.channels.length === 1 ? '' : 's'}` : 'no channel yet'}</span></div></label>`;
      })}</div>
    </form>`,
    html`<a class="ns-btn quiet" href="/new-website/sharing">Cancel</a><button class="ns-btn primary" form="sh-form">Next</button>`,
  );
}

export function shareArticlesStep(s: SharingSite): Html {
  const postsOf = (id: number) => s.posts.filter((p) => p.seo_id === id);
  const open = s.articles.map((a) => ({ a, missing: missingChannels(postsOf(a.row.id), s.channels) })).filter((x) => x.missing.length);
  const error = !s.channels.length
    ? `${s.site.name} shares on no channel yet. Pick its channels in the website’s settings first.`
    : '';
  return shareWizard(
    1,
    html`<form id="sh-form" method="post" action="/new-website/sharing/share">
      <input type="hidden" name="websiteId" value="${String(s.site.id)}" />
      <h2>Articles</h2>
      <p>${s.site.name}’s published articles that are not on every channel yet. Each ticked one gets a post on each channel it is missing from, made from the article by that channel’s rules.</p>
      ${open.length
        ? html`<div class="sh-pick">${open.map(({ a, missing }) => html`<label class="ch-option"><input type="checkbox" name="seo" value="${String(a.row.id)}" checked />
            <div><b>${a.row.title || a.row.keyword}</b><span class="sh-missing">Missing on ${missing.map((m) => `${m.name} (${labelOf(m.platform)})`).join(', ')}</span></div></label>`)}</div>`
        : html`<p class="ko-none">${s.articles.length ? 'Every published article is already on every channel.' : 'No published article yet.'}</p>`}
    </form>`,
    html`<a class="ns-btn quiet" href="/new-website/sharing/new?website=${String(s.site.id)}">Previous</a>
      ${open.length && s.channels.length
        ? html`<button class="ns-btn primary" form="sh-form">Share</button>`
        : html`<button class="ns-btn primary" disabled>Nothing to share</button>`}`,
    error,
  );
}
