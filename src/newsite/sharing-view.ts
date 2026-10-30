import { html, raw, type Html } from '../web/views/layout.js';
import type { NewWebsiteRow } from './repo.js';
import type { SeoRow } from './seo.js';
import { PLATFORMS, channelColor, channelPageLink, postLinkOf, takesReels, type ChannelRow } from './channels.js';
import type { SocialPostRow } from './social.js';
import type { PictureRow } from './pictures.js';
import type { ReelRow } from './reels.js';
import { LONG_REEL_SECONDS, longReelProgress, type ReelKind } from './long-reels.js';
import type { MusicRow } from './music.js';
import type { ReelShareRow } from './reel-shares.js';
import { WIZARD_CSS } from './view.js';
import { CSS, OVERVIEW_CSS, labelOf, missingChannels, sharePostRow, sharingBusy } from './keywords-view.js';

/**
 * The Sharing page: the last step of the platform. Every published article,
 * by website, with the post each channel made from it: its words, its
 * picture, where it stands, and what you can do. Posts start by themselves
 * once an article is published; the Share articles wizard is for the rest.
 *
 * Reels have their own card: each article's one reel is made and managed
 * there, then sent to the channels that take reels. A channel's page only
 * shows where each reel stands on that channel.
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
  reels: ReelRow[];
  /** Each made reel on each channel it is shared on. */
  reelShares: ReelShareRow[];
}

const SHARING_CSS = `
.sh-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 14px; font-size: 14px; color: var(--soft); }
.sh-crumbs a { color: var(--soft); text-decoration: none; font-weight: 500; }
.sh-crumbs a:hover { color: var(--accent-text); text-decoration: underline; }
.sh-crumbs .sep { color: var(--faint); }
.sh-crumbs b { color: var(--ink); font-weight: 600; }
.sh-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: 20px; }
.sh-card { display: flex; flex-direction: column; gap: 16px; min-height: 150px; padding: 22px 24px; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-card); box-shadow: var(--shadow); color: var(--ink); text-decoration: none; transition: border-color .15s ease, transform .15s ease; }
.sh-card:hover { border-color: var(--accent); transform: translateY(-1px); }
.sh-card:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.sh-card-title { font: 700 19px/1.25 var(--display); letter-spacing: -.01em; }
.sh-card-sub { display: block; margin-top: 3px; color: var(--soft); font: 13px var(--mono); }
.sh-nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: auto; }
.sh-num { padding: 10px 12px; border-radius: var(--r-ctl); background: var(--raised); min-width: 0; }
.sh-num b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; color: var(--ink); }
.sh-num span { display: block; font-size: 13px; line-height: 1.35; color: var(--soft); }
.sh-num.bad { background: var(--bad-tint); } .sh-num.bad b { color: var(--bad); }
.sh-num.busy { background: var(--idle); } .sh-num.busy b, .sh-num.busy span { color: var(--idle-ink); }
.sh-open { font-size: 13px; font-weight: 600; color: var(--accent-text); }
.sh-ch { background: color-mix(in srgb, var(--ch-color) 7%, var(--surface)); border-color: color-mix(in srgb, var(--ch-color) 25%, var(--line)); border-top: 4px solid var(--ch-color); }
.sh-ch:hover { border-color: var(--ch-color); }
.sh-ch-head { display: flex; align-items: center; gap: 10px; }
.sh-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--ch-color); flex: none; }
.sh-platform { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--soft); }
.sh-reels-line { font-size: 13px; color: var(--soft); }
.sh-band { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 20px; padding: 18px 22px; margin: 0 0 18px;
  background: color-mix(in srgb, var(--ch-color) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--ch-color) 25%, var(--line));
  border-left: 5px solid var(--ch-color); border-radius: var(--r-card); }
.sh-band h1 { margin: 0; font: 700 24px/1.2 var(--display); }
.sh-band p { margin: 4px 0 0; color: var(--soft); font-size: 14px; }
.sh-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 18px; }
.sh-tab { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 16px; border-radius: 999px; text-decoration: none; font-weight: 600; font-size: 14px;
  background: var(--idle); color: var(--idle-ink); border: 1px solid var(--idle-line); }
.sh-tab:hover { background: var(--idle-hover); }
.sh-tab.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.sh-tab .n { font-variant-numeric: tabular-nums; opacity: .85; }
.sh-panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); padding: 6px 22px 18px; }
.sh-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 14px 0 6px; font-size: 13px; color: var(--soft); }
.sh-legend-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin: 14px 0 0; font-size: 14px; color: var(--soft); line-height: 1.5; }
.sh-legend-row p { margin: 0; flex: 1 1 320px; }
.sh-articles { list-style: none; margin: 0; padding: 0; }
.sh-article { padding: 14px 0; border-bottom: 1px solid var(--line); }
.sh-article:last-child { border-bottom: 0; }
.sh-article > .kw-share-list { border-top: 0; margin: 0; }
.sh-steps { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.sh-step { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--idle); color: var(--idle-ink); }
.sh-step.done { background: var(--good-tint); color: var(--good); }
.sh-step.now { background: var(--accent); color: #fff; }
.sh-step.bad { background: var(--bad-tint); color: var(--bad); }
.sh-none-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.sh-none-row b { font-size: 15px; }
.sh-none-row form { margin: 0; }
.sh-empty { color: var(--soft); padding: 18px 0 6px; margin: 0; }
.sh-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 16px; }
/* A reel: its 9:16 video on the left, what it is and what to do on the right. */
.sh-reel-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 14px; padding-top: 16px; }
.sh-reel { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 16px; align-items: start; min-width: 0;
  background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-card); padding: 14px; }
.sh-reel-media video, .sh-reel-media .sh-reel-empty { display: block; width: 150px; aspect-ratio: 9 / 16; border-radius: 8px; background: var(--surface); object-fit: cover; border: 1px solid var(--line); }
.sh-reel-media .sh-reel-empty { display: grid; place-items: center; padding: 10px; text-align: center; color: var(--soft); font-size: 13px; line-height: 1.4; }
.sh-reel-media .sh-reel-empty.bad { color: var(--bad); background: var(--bad-tint); border-color: transparent; }
.sh-reel-body { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; min-width: 0; }
.sh-reel-body > * { max-width: 100%; }
.sh-reel-title { font-size: 15px; font-weight: 600; line-height: 1.35; color: var(--ink); overflow-wrap: anywhere; }
.sh-reel-body .kw-seo-problems { margin: 0; width: 100%; font-size: 13px; overflow-wrap: anywhere; }
.sh-reel-body details { width: 100%; font-size: 13px; color: var(--soft); }
.sh-reel-body details summary { cursor: pointer; }
.sh-reel-body details pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; max-height: 240px; overflow: auto; margin: 8px 0 0; padding: 10px; background: var(--surface); border-radius: 6px; }
.sh-reel-body form { margin: 0; }
@media (max-width: 520px) { .sh-reel { grid-template-columns: 1fr; } .sh-reel-media video, .sh-reel-media .sh-reel-empty { width: 100%; max-width: 220px; } }
.sh-hook { width: 100%; font-size: 14px; line-height: 1.45; color: var(--ink); background: var(--surface); border-left: 3px solid var(--accent); padding: 8px 10px; border-radius: 6px; overflow-wrap: anywhere; }
.sh-hook small { display: block; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin-bottom: 2px; }
.sh-pick { display: grid; gap: 10px; }
/* The Reels page: one full-width card per reel that opens and closes. */
.rl-list { padding-top: 16px; }
.rl-site { margin: 22px 0 0; font-size: 17px; }
.rl .acc-head b { flex: 1 1 280px; font-size: 15px; }
.rl-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.rl-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--idle); color: var(--idle-ink); }
.rl-chip .sh-dot { width: 8px; height: 8px; }
.rl-chip.ok { background: var(--good-tint); color: var(--good); }
.rl-chip.bad { background: var(--bad-tint); color: var(--bad); }
.rl-body { padding: 0 18px 18px; }
.rl-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0 16px; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.rl-actions form { margin: 0; }
.rl-kind { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 14px; }
.rl-kind select, .mu-list select { font: inherit; padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--surface); color: var(--ink); }
.mu-list { list-style: none; padding: 0; margin: 0 0 16px; }
.mu-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.mu-list audio { height: 32px; max-width: 100%; }
.mu-bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; }
.rl-grid { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 24px; align-items: start; }
.rl-grid .sh-reel-media video, .rl-grid .sh-reel-media .sh-reel-empty { width: 200px; }
.rl-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.rl-main .kw-seo-problems { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.rl-h { margin: 4px 0 0; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--soft); }
.rl-main form { margin: 0; }
.rl-dests { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; }
.rl-dest { display: grid; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); align-items: center; gap: 8px 12px; padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: 14px; }
.rl-dest:last-child { border-bottom: 0; }
.rl-dest.off { opacity: .6; }
.rl-name { display: flex; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
.rl-state { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.rl-state form { margin: 0; }
.rl-state .kw-seo-problems { flex-basis: 100%; }
.rl-state a { font-size: 13px; font-weight: 600; color: var(--accent-text); }
.rl-main details { font-size: 13px; color: var(--soft); }
.rl-main details summary { cursor: pointer; }
.rl-main details pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; max-height: 260px; overflow: auto; margin: 8px 0 0; padding: 10px; background: var(--raised); border-radius: 6px; }
@media (max-width: 720px) {
  .rl-grid { grid-template-columns: 1fr; }
  .rl-dest { grid-template-columns: minmax(0, 1fr); }
  .rl-state { grid-column: 2; }
}
.sh-reels-card { background: color-mix(in srgb, var(--accent) 6%, var(--surface)); border-top: 4px solid var(--accent); }
.sh-shares { list-style: none; margin: 0; padding: 0; }
.sh-share { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.sh-share:last-child { border-bottom: 0; }
.sh-share b { flex: 1 1 260px; font-size: 15px; overflow-wrap: anywhere; }
.sh-share form { margin: 0; }
.sh-share .kw-seo-problems { flex-basis: 100%; margin: 0; font-size: 13px; }
.sh-pick .ch-option span.sh-missing { display: block; margin-top: 2px; }
`;

const siteHref = (id: number, plan?: { id: number } | null): string => `/new-website/sharing/site/${id}${plan ? `?plan=${plan.id}` : ''}`;
const channelHref = (siteId: number, channelId: number, tab = 'posts', plan?: { id: number } | null): string =>
  `/new-website/sharing/site/${siteId}/channel/${channelId}?tab=${tab}${plan ? `&plan=${plan.id}` : ''}`;

function crumbs(items: [string, string?][]): Html {
  return html`<nav class="sh-crumbs" aria-label="Where you are">${items.map(([label, href], i) => html`${i ? html`<span class="sep">›</span>` : raw('')}${href ? html`<a href="${href}">${label}</a>` : html`<b>${label}</b>`}`)}</nav>`;
}

const num = (n: number, label: string, cls = ''): Html => html`<div class="sh-num ${n && cls ? cls : ''}"><b>${String(n)}</b><span>${label}</span></div>`;

/** Where each website stands, in counts. */
function countsOf(s: SharingSite) {
  const postsOf = (id: number) => s.posts.filter((p) => p.seo_id === id);
  const toShare = s.articles.filter((a) => missingChannels(postsOf(a.row.id), s.channels, a.row.post_category).length).length;
  return {
    published: s.articles.length,
    shared: s.articles.filter((a) => postsOf(a.row.id).length > 0 && postsOf(a.row.id).every((p) => p.status === 'sent')).length,
    making: s.posts.filter((p) => p.status === 'pending' || p.status === 'picture' || p.status === 'waiting').length
      + s.reels.filter((r) => r.status === 'pending' || r.status === 'making').length
      + s.reelShares.filter((x) => x.status === 'pending' || x.status === 'waiting').length,
    failed: s.posts.filter((p) => p.status === 'failed').length + s.reels.filter((r) => r.status === 'failed').length
      + s.reelShares.filter((x) => x.status === 'failed').length,
    toShare,
  };
}

/** One channel of one website: its posts, its reels, and what is not shared on it yet. */
function channelData(s: SharingSite, c: ChannelRow, plan: { id: number } | null = null) {
  const articles = plan ? s.articles.filter((a) => a.planId === plan.id) : s.articles;
  const ids = new Set(articles.map((a) => a.row.id));
  const posts = s.posts.filter((p) => p.channel_id === c.id && ids.has(p.seo_id));
  const notYet = articles.filter((a) => missingChannels(posts.filter((p) => p.seo_id === a.row.id), [c], a.row.post_category).length);
  // Reels on this channel: only where each one stands here (they are made on the Reels page).
  const reelIds = new Set(s.reels.filter((r) => ids.has(r.seo_id)).map((r) => r.id));
  const shares = takesReels(c.platform) ? s.reelShares.filter((x) => x.channel_id === c.id && reelIds.has(x.reel_id)) : null;
  return {
    articles,
    posts,
    shares,
    notYet,
    sent: posts.filter((p) => p.status === 'sent').length,
    making: posts.filter((p) => p.status !== 'sent' && p.status !== 'failed').length,
    failed: posts.filter((p) => p.status === 'failed').length + (shares ?? []).filter((x) => x.status === 'failed').length,
  };
}

const isBusy = (s: SharingSite): boolean =>
  sharingBusy(s.posts) || s.reels.some((r) => r.status === 'pending' || r.status === 'making') || s.reelShares.some((x) => x.status === 'pending');
const watch = (busy: boolean): Html => (busy ? raw('<span data-watch="1" hidden></span>') : raw(''));

/* -- Level 1: the websites -------------------------------------------------- */

export function sharingSitesPage(sites: SharingSite[]): Html {
  return html`
    <style>${raw(CSS)}${raw(SHARING_CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Social posts</h1>
        <p class="ns-lede">What happened after your articles were published. Each website shares on the social channels picked in its settings, and every channel gets its own post. Open a website to see each post, its link, and anything that needs fixing.</p>
      </div>
      ${sites.length ? html`<a class="ns-btn primary" href="/new-website/sharing/new">Share articles</a>` : raw('')}
    </div>
    ${sites.length
      ? html`<div class="sh-grid">${sites.map((s) => {
          const c = countsOf(s);
          return html`<a class="sh-card" href="${siteHref(s.site.id)}">
            <div><span class="sh-card-title">${s.site.name}</span><span class="sh-card-sub">${s.site.domain}</span></div>
            <div class="sh-nums">
              ${num(c.published, 'published')}
              ${num(s.channels.length, s.channels.length === 1 ? 'channel' : 'channels')}
              ${c.failed ? num(c.failed, 'failed', 'bad') : num(c.making, 'being made', 'busy')}
            </div>
            <span class="sh-open">Open its channels →</span>
          </a>`;
        })}</div>`
      : html`<div class="ko-empty"><h2>Add a website first</h2><p>Articles are shared once they are published on a website.</p><a class="ns-btn primary" href="/new-website/add">Add website</a></div>`}
    ${watch(sites.some(isBusy))}
    ${raw(SHARING_SCRIPT)}`;
}

/* -- Level 2: one website's channels ---------------------------------------- */

export function sharingSitePage(s: SharingSite, plan: { id: number; pillar: string } | null = null): Html {
  const c = countsOf(s);
  return html`
    <style>${raw(CSS)}${raw(SHARING_CSS)}</style>
    ${crumbs([['Social posts', '/new-website/sharing'], [s.site.name]])}
    <div class="ns-head">
      <div>
        <h1 class="ns-title">${s.site.name}</h1>
        <p class="ns-lede">${String(c.published)} published article${c.published === 1 ? '' : 's'} · ${s.site.domain}. Choose a channel to see its posts, reels and problems.</p>
      </div>
      <a class="ns-btn primary" href="/new-website/sharing/new?website=${String(s.site.id)}">Share articles</a>
    </div>
    ${plan ? html`<div class="sh-filter"><span class="ns-tag">Keyword plan: ${plan.pillar}</span><a class="ns-btn small" href="${siteHref(s.site.id)}">Show every article</a></div>` : raw('')}
    ${s.channels.length
      ? html`<div class="sh-grid">${s.channels.map((ch) => {
          const d = channelData(s, ch, plan);
          const label = PLATFORMS.find((p) => p.key === ch.platform)?.label ?? labelOf(ch.platform);
          return html`<a class="sh-card sh-ch" style="--ch-color:${channelColor(ch)}" href="${channelHref(s.site.id, ch.id, 'posts', plan)}">
            <div>
              <div class="sh-ch-head"><span class="sh-dot"></span><span class="sh-platform">${label}</span></div>
              <span class="sh-card-title">${ch.name}</span><span class="sh-card-sub">through ${ch.via === 'buffer' ? 'Buffer' : 'the API'}</span>
            </div>
            <div class="sh-nums">
              ${num(d.sent, 'sent')}
              ${d.failed ? num(d.failed, 'failed', 'bad') : num(d.making, 'being made', 'busy')}
              ${num(d.notYet.length, 'not shared yet')}
            </div>
            ${d.shares ? html`<span class="sh-reels-line">Reels: ${String(d.shares.filter((x) => x.status === 'sent').length)} shared here${d.shares.some((x) => x.status === 'pending' || x.status === 'waiting') ? ', more on the way' : ''}</span>` : raw('')}
            <span class="sh-open">Open ${label} →</span>
          </a>`;
        })}</div>`
      : html`<div class="ns-alert info"><b>${s.site.name} shares on no channel yet.</b> Pick its channels in the website’s settings, or add a channel first.
          <div class="kw-share-actions"><a class="ns-btn small" href="/new-website/${String(s.site.id)}/edit?section=4">Pick channels</a><a class="ns-btn small" href="/new-website/channels">Add a channel</a></div></div>`}
    ${watch(isBusy(s))}
    ${raw(SHARING_SCRIPT)}`;
}

/* -- Level 3: one channel: its pipeline, its reels, its problems ------------- */

export type ChannelTab = 'posts' | 'reels' | 'problems';

/** The three steps a post goes through, and where this one is. */
function stepStrip(p: SocialPostRow): Html {
  const names = ['Words', 'Picture', 'Sent'];
  const at = p.status === 'pending' ? 0 : p.status === 'picture' ? 1 : p.status === 'waiting' ? 2 : p.status === 'sent' ? 3 : -1;
  const failedAt = p.status === 'failed' ? (!p.fields_json && !p.text ? 0 : !p.picture_id ? 1 : 2) : -1;
  return html`<div class="sh-steps" aria-label="Steps">${names.map((n, i) => {
    const cls = failedAt === i ? 'bad' : (failedAt > i || at > i) ? 'done' : at === i ? 'now' : '';
    return html`<span class="sh-step ${cls}">${String(i + 1)}. ${n}</span>`;
  })}</div>`;
}

export function sharingChannelPage(s: SharingSite, ch: ChannelRow, tab: ChannelTab, plan: { id: number; pillar: string } | null = null): Html {
  const d = channelData(s, ch, plan);
  const label = PLATFORMS.find((p) => p.key === ch.platform)?.label ?? labelOf(ch.platform);
  if (tab === 'reels' && !d.shares) tab = 'posts';
  const pictureOf = (p: SocialPostRow) => s.pictures.find((x) => x.id === p.picture_id);
  const titleOf = (a: SharingArticle) => a.row.title || a.row.keyword;
  const tabs: [ChannelTab, string, number][] = [
    ['posts', 'Posts', d.articles.length],
    ...(d.shares ? [['reels', 'Reels', d.shares.length] as [ChannelTab, string, number]] : []),
    ['problems', 'Problems', d.failed],
  ];

  const postRows = (articles: SharingArticle[], onlyFailed: boolean): Html[] =>
    articles.flatMap((a) => {
      const post = d.posts.find((p) => p.seo_id === a.row.id);
      if (onlyFailed && post?.status !== 'failed') return [];
      if (!post) {
        const canShare = missingChannels([], [ch]).length > 0;
        return [html`<li class="sh-article"><div class="sh-none-row"><div><b>${titleOf(a)}</b><div class="kw-share-meta">Not shared on this channel yet.</div></div>
          ${canShare ? html`<form method="post" action="/new-website/keywords/share/${String(a.row.id)}"><button class="ns-btn small primary">Share now</button></form>` : raw('')}</div></li>`];
      }
      return [html`<li class="sh-article">${stepStrip(post)}<ul class="kw-share-list">${sharePostRow(post, ch, a.planId, pictureOf(post), titleOf(a), a.row.post_url)}</ul></li>`];
    });

  const shareRows = (shares: ReelShareRow[]): Html =>
    html`<ul class="sh-shares">${shares.map((x) => {
      const r = s.reels.find((y) => y.id === x.reel_id);
      const a = r ? s.articles.find((y) => y.row.id === r.seo_id) : undefined;
      return html`<li class="sh-share"><b>${a ? titleOf(a) : 'A reel'}</b>${shareState(x, ch)}</li>`;
    })}</ul>`;

  const failedShares = (d.shares ?? []).filter((x) => x.status === 'failed');
  const problems = postRows(d.articles, true);
  const body =
    tab === 'reels'
      ? html`<div class="sh-legend-row">
            <p>Each article’s reel is made once on the Reels page and the same video is sent to every channel that takes reels. Here is where each one stands on this channel.</p>
            <a class="ns-btn small" href="${reelsHref(s.site.id)}">Open Reels</a></div>
          ${d.shares!.length ? shareRows(d.shares!) : html`<p class="sh-empty">No reel sent here yet. ${ch.post_reel ? 'Reels come here by themselves once they are made.' : html`${s.site.name} does not send reels here. <a href="${siteChannelsHref(s.site.id)}">Change it in the website’s settings</a>.`}</p>`}`
      : tab === 'problems'
        ? problems.length || failedShares.length
          ? html`${problems.length ? html`<ul class="sh-articles">${problems}</ul>` : raw('')}${failedShares.length ? shareRows(failedShares) : raw('')}`
          : html`<p class="sh-empty">No problems on this channel.</p>`
        : d.articles.length
          ? html`<div class="sh-legend">Each post goes through <span class="sh-step">1. Words</span><span class="sh-step">2. Picture</span><span class="sh-step">3. Sent</span> by itself, by this channel’s <a href="/new-website/channels/${String(ch.id)}">rules</a>.</div>
              <ul class="sh-articles">${postRows(d.articles, false)}</ul>`
          : html`<p class="sh-empty">No published article${plan ? ' in this keyword plan' : ''} yet.</p>`;

  return html`
    <style>${raw(CSS)}${raw(SHARING_CSS)}</style>
    ${crumbs([['Social posts', '/new-website/sharing'], [s.site.name, siteHref(s.site.id, plan)], [`${label} · ${ch.name}`]])}
    <div class="sh-band" style="--ch-color:${channelColor(ch)}">
      <div>
        <div class="sh-ch-head"><span class="sh-dot"></span><span class="sh-platform">${label} through ${ch.via === 'buffer' ? 'Buffer' : 'the API'}</span></div>
        <h1>${ch.name}</h1>
        <p>${String(d.sent)} sent · ${String(d.making)} being made · ${String(d.notYet.length)} not shared yet${d.failed ? ` · ${d.failed} failed` : ''}</p>
      </div>
      <a class="ns-btn" href="/new-website/channels/${String(ch.id)}">Channel settings</a>
    </div>
    ${plan ? html`<div class="sh-filter"><span class="ns-tag">Keyword plan: ${plan.pillar}</span><a class="ns-btn small" href="${channelHref(s.site.id, ch.id, tab)}">Show every article</a></div>` : raw('')}
    <nav class="sh-tabs" aria-label="Sections">${tabs.map(([key, name, n]) => html`<a class="sh-tab ${key === tab ? 'on' : ''}" href="${channelHref(s.site.id, ch.id, key, plan)}" ${key === tab ? raw('aria-current="page"') : raw('')}>${name} <span class="n">${String(n)}</span></a>`)}</nav>
    <div class="sh-panel">${body}</div>
    ${watch(isBusy(s))}
    ${raw(SHARING_SCRIPT)}`;
}

/** Reloads the page while posts or reels are being made. */
const SHARING_SCRIPT = `<script>
(function () {
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
  const open = s.articles.map((a) => ({ a, missing: missingChannels(postsOf(a.row.id), s.channels, a.row.post_category) })).filter((x) => x.missing.length);
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

/* -- Reels: one video per article and platform ------------------------------ */

const REEL_STATUS: Record<ReelRow['status'], [string, string]> = {
  pending: ['Waiting its turn', 'busy'],
  making: ['Being made in Flow', 'busy'],
  done: ['Made', 'ok'],
  failed: ['Failed', 'bad'],
};

/** The website's settings, open on where it posts. */
const siteChannelsHref = (websiteId: number): string => `/new-website/${String(websiteId)}/edit?section=4`;
const reelsHref = (websiteId = 0): string => `/new-website/sharing/reels${websiteId ? `?website=${websiteId}` : ''}`;
const platformLabelOf = (platform: string): string => PLATFORMS.find((p) => p.key === platform)?.label ?? labelOf(platform);

/** Where one reel stands on one channel, and what to do about it. */
function shareState(x: ReelShareRow, ch: ChannelRow): Html {
  switch (x.status) {
    case 'pending':
      return html`<span class="ns-badge busy">Being sent</span>`;
    case 'waiting':
      return html`<span class="ns-badge busy">Waiting for room in Buffer</span>${x.error ? html`<div class="kw-seo-problems">${x.error}</div>` : raw('')}`;
    case 'failed':
      return html`<span class="ns-badge bad">Failed</span>
        <form method="post" action="/new-website/reels/shares/${String(x.id)}/retry"><button class="ns-btn small primary">Try again</button></form>
        <div class="kw-seo-problems">${x.error}</div>`;
    default: {
      const link = postLinkOf(x, ch, 'reel');
      const page = channelPageLink(ch);
      const where = `${ch.name} (${platformLabelOf(ch.platform)})`;
      return html`<span class="ns-badge ok">${link || ch.via !== 'buffer' ? 'Posted' : 'Queued in Buffer'}</span>
        ${link
          ? html`<a href="${link}" target="_blank" rel="noopener">Open the reel on ${where} ↗</a>`
          : ch.via === 'buffer' ? html`<span class="sh-reels-line">The link appears once Buffer has posted it.</span>` : raw('')}
        ${x.sent_at ? html`<span class="sh-reels-line">${ch.via === 'buffer' ? 'Given to Buffer' : 'Posted'} ${x.sent_at} UTC</span>` : raw('')}
        ${page ? html`<a class="sh-reels-line" href="${page}" target="_blank" rel="noopener">The ${ch.name} page ↗</a>` : raw('')}
        ${x.board_name ? html`<span class="sh-reels-line">Board: ${x.board_name}</span>` : raw('')}
        ${x.error ? html`<div class="kw-seo-problems">${x.error}</div>` : raw('')}`;
    }
  }
}

const CHEVRON = '<svg class="acc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/** A short word for where a reel stands on a channel, for the closed card's head. */
const SHARE_WORD: Record<ReelShareRow['status'], [string, string]> = {
  pending: ['Being sent', 'busy'],
  waiting: ['Waiting for Buffer', 'busy'],
  sent: ['Sent', 'ok'],
  failed: ['Failed', 'bad'],
};

/**
 * One reel, made once, as a full-width card that opens and closes: the head
 * says what it is and where it stands on each channel; the body has the
 * actions first, then the video beside its hook and the channels it goes to.
 */
function reelItem(r: ReelRow, s: SharingSite): Html {
  const a = s.articles.find((x) => x.row.id === r.seo_id);
  const [status, cls] = REEL_STATUS[r.status];
  const destinations = s.channels.filter((c) => takesReels(c.platform));
  const shareOf = (c: ChannelRow) => s.reelShares.find((x) => x.reel_id === r.id && x.channel_id === c.id);
  const needsLook = r.status === 'failed' || destinations.some((c) => shareOf(c)?.status === 'failed');
  // A channel the website does not send reels to shows only what already went there.
  const chips = destinations.filter((c) => c.post_reel || shareOf(c)).map((c) => {
    const x = shareOf(c);
    const [word, tone] = !x ? ['Not sent', ''] : x.status === 'sent' && !postLinkOf(x, c, 'reel') && c.via === 'buffer' ? ['Queued in Buffer', 'ok'] : SHARE_WORD[x.status];
    return html`<span class="rl-chip ${tone}" style="--ch-color:${channelColor(c)}"><span class="sh-dot"></span><span>${platformLabelOf(c.platform)} · ${c.name}: ${word}</span></span>`;
  });
  return html`<li class="acc rl ${needsLook ? 'open' : ''}" id="reel-${String(r.id)}" data-reel="${String(r.id)}">
    <button type="button" class="acc-head" aria-expanded="${needsLook ? 'true' : 'false'}">
      <b>${a ? a.row.title || a.row.keyword : 'An article'}</b>
      <span class="ns-badge ${cls}">${status}</span>
      <span class="rl-chips">${chips}</span>
      ${raw(CHEVRON)}
    </button>
    <div class="acc-panel"><div class="acc-inner"><div class="acc-body rl-body">
      <div class="rl-actions">
        ${a?.row.post_url ? html`<a class="ns-btn small quiet" href="${a.row.post_url}" target="_blank" rel="noopener">Open the article ↗</a>` : raw('')}
        ${r.status === 'done' || r.status === 'failed'
          ? html`<form method="post" action="/new-website/reels/${String(r.id)}/remake"><button class="ns-btn small ${r.status === 'failed' ? 'primary' : ''}">${r.status === 'failed' ? 'Try again' : 'Make again'}</button></form>`
          : raw('')}
      </div>
      <div class="rl-grid">
        <div class="sh-reel-media">
          ${r.status === 'done'
            ? html`<video src="/new-website/reels/${String(r.id)}/file" controls preload="metadata" playsinline></video>`
            : html`<div class="sh-reel-empty ${r.status === 'failed' ? 'bad' : ''}">${r.status === 'failed' ? 'No video' : r.kind === 'long' || r.stage ? `Long reel: ${longReelProgress(r.id, r.stage)}` : 'Being made in Flow. A few minutes.'}</div>`}
        </div>
        <div class="rl-main">
          ${r.hook ? html`<div class="sh-hook"><small>Hook</small>“${r.hook}”</div>` : raw('')}
          ${r.error ? html`<div class="kw-seo-problems">${r.error}</div>` : raw('')}
          <h3 class="rl-h">Where it goes</h3>
          <p class="sh-reels-line">${s.site.name}’s settings decide this. <a href="${siteChannelsHref(s.site.id)}">Change where ${s.site.name} posts</a></p>
          ${destinations.length
            ? html`<ul class="rl-dests">${destinations.map((c) => {
                const x = shareOf(c);
                return html`<li class="rl-dest ${!c.post_reel && !x ? 'off' : ''}" style="--ch-color:${channelColor(c)}">
                  <span class="rl-name"><span class="sh-dot"></span><span><b>${platformLabelOf(c.platform)}</b> · ${c.name}</span></span>
                  <span class="rl-state">${x
                    ? shareState(x, c)
                    : !c.post_reel
                      ? html`<span class="ns-badge">Reels off for this website</span>`
                      : html`<span class="ns-badge busy">${r.status === 'done' ? 'Going out shortly' : 'After the video is made'}</span>`}</span>
                </li>`;
              })}</ul>`
            : html`<p class="sh-reels-line">${s.site.name} has no channel that takes reels (Facebook, Instagram, Pinterest, YouTube or TikTok).</p>`}
          ${r.prompt ? html`<details><summary>The prompt</summary><pre>${r.prompt}</pre></details>` : raw('')}
        </div>
      </div>
    </div></div></div>
  </li>`;
}

/** The reel cards: open and close, and stay as they were when the page reloads itself. */
const REELS_SCRIPT = `<script>
(function () {
  var key = 'reels-open';
  var saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch (e) {}
  document.querySelectorAll('.rl').forEach(function (card) {
    var head = card.querySelector('.acc-head');
    var id = card.getAttribute('data-reel');
    function set(open) { card.classList.toggle('open', open); head.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    if (id in saved) set(saved[id]);
    head.addEventListener('click', function () {
      var open = !card.classList.contains('open');
      set(open);
      saved[id] = open;
      try { sessionStorage.setItem(key, JSON.stringify(saved)); } catch (e) {}
    });
  });
})();
</script>`;

/**
 * The Reels page: every article's one reel, made once and managed here, then
 * sent to the channels that take reels. Published articles with no reel yet
 * can get one.
 */
export interface ReelChoice {
  kind: ReelKind;
  seconds: number;
}

/** A website's reel type and length, saved for its next reels. */
function reelChoiceForm(s: SharingSite, choice: ReelChoice, websiteId: number): Html {
  const opt = (value: string, label: string, on: boolean) => html`<option value="${value}" ${on ? 'selected' : ''}>${label}</option>`;
  return html`<form class="rl-kind" method="post" action="/new-website/sharing/reels/kind/${String(s.site.id)}">
    <input type="hidden" name="back" value="${reelsHref(websiteId)}" />
    <b>${s.site.name}</b>
    <select name="kind" aria-label="Reel type">${opt('short', '10 seconds', choice.kind === 'short')}${opt('long', 'Long', choice.kind === 'long')}</select>
    <select name="seconds" aria-label="Length">${LONG_REEL_SECONDS.map((n) => opt(String(n), `${n}s`, choice.seconds === n))}</select>
    <button class="ns-btn small">Save</button>
  </form>`;
}

export function reelsPage(sites: SharingSite[], websiteId = 0, choiceOf?: (websiteId: number) => ReelChoice): Html {
  const shown = websiteId ? sites.filter((s) => s.site.id === websiteId) : sites;
  const withReel = (s: SharingSite) => new Set(s.reels.map((r) => r.seo_id));
  const noReel = shown.flatMap((s) => s.articles.filter((a) => !withReel(s).has(a.row.id)).map((a) => ({ s, a })));
  return html`
    <style>${raw(CSS)}${raw(SHARING_CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Reels</h1>
        <p class="ns-lede">Each published article gets one reel: a short Google Flow video, made once, here. The same video then goes by itself to every social channel its website posts reels to (chosen in the website’s settings), and each channel shows its own status.</p>
      </div>
      <div class="mu-bar">
        <a class="ns-btn" href="/new-website/sharing/music">Music</a>
        <a class="ns-btn" href="/new-website/sharing/reel-rules?back=${encodeURIComponent(reelsHref(websiteId))}">Edit reel rules</a>
      </div>
    </div>
    ${sites.length > 1
      ? html`<nav class="sh-tabs" aria-label="Websites">
          <a class="sh-tab ${websiteId ? '' : 'on'}" href="${reelsHref()}">Every website <span class="n">${String(sites.reduce((n, s) => n + s.reels.length, 0))}</span></a>
          ${sites.map((s) => html`<a class="sh-tab ${s.site.id === websiteId ? 'on' : ''}" href="${reelsHref(s.site.id)}">${s.site.name} <span class="n">${String(s.reels.length)}</span></a>`)}
        </nav>`
      : raw('')}
    <div class="sh-panel">
      ${choiceOf ? shown.map((s) => reelChoiceForm(s, choiceOf(s.site.id), websiteId)) : raw('')}
      ${shown.some((s) => s.reels.length)
        ? shown.filter((s) => s.reels.length).map((s) => html`${shown.length > 1 ? html`<h2 class="rl-site">${s.site.name}</h2>` : raw('')}<ul class="acc-list rl-list">${s.reels.map((r) => reelItem(r, s))}</ul>`)
        : html`<p class="sh-empty">No reel yet. A reel is made for each article once it is published, when its website has a channel that takes reels.</p>`}
      ${noReel.length
        ? html`<h2 style="margin:22px 0 4px;font-size:16px">Published articles with no reel</h2>
          <ul class="sh-articles">${noReel.map(({ s, a }) => html`<li class="sh-article"><div class="sh-none-row"><div><b>${a.row.title || a.row.keyword}</b><div class="kw-share-meta">${s.site.name}</div></div>
            <form method="post" action="/new-website/reels/make/${String(a.row.id)}"><button class="ns-btn small primary">Make its reel</button></form></div></li>`)}</ul>`
        : raw('')}
    </div>
    ${watch(shown.some(isBusy))}
    ${raw(SHARING_SCRIPT)}${raw(REELS_SCRIPT)}`;
}

/* -- The reel rules, edited in place ---------------------------------------- */

export function reelRulesPage(text: string, isDefault: boolean, back: string, error = ''): Html {
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}${raw(SHARING_CSS)}
      .rr-text { width: 100%; min-height: 460px; font: 14px/1.55 var(--mono); padding: 14px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--surface); color: var(--ink); }</style>
    <div class="wz kw-wz">
      <div class="wz-head">
        <h1>Reel rules</h1>
        <p class="wz-id">How the AI writes the one video prompt for every reel. The same video goes to every channel that takes reels: Facebook, Instagram, Pinterest, YouTube and TikTok. ${isDefault ? 'These are the default rules.' : 'Changed on the dashboard.'}</p>
      </div>
      <div class="wz-body">
        ${error ? html`<p class="kw-seo-problems" role="alert" style="margin:0 0 16px">${error}</p>` : raw('')}
        <form id="rr-form" method="post" action="/new-website/sharing/reel-rules">
          <input type="hidden" name="back" value="${back}" />
          <p>Keep the time marks as lines starting with “- 0-2s:”, the hook line limit (“at most N words”) and the closing line (“closing line, word for word: "…"”): the prompt is checked against them. Change the rest for another niche or another style.</p>
          <p>Placeholder: <code>{domain}</code> = the website’s address.</p>
          <textarea class="rr-text" name="text" spellcheck="false" aria-label="Reel rules">${text}</textarea>
          <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" name="reset" value="1" /> Replace them with the default rules</label>
        </form>
      </div>
      <div class="wz-foot"><a class="ns-btn quiet" href="${back}">Cancel</a><button class="ns-btn primary" form="rr-form">Save</button></div>
    </div>`;
}

/* -- The music long reels play under their clips ---------------------------- */

export function musicPage(tracks: MusicRow[]): Html {
  return html`
    <style>${raw(CSS)}${raw(SHARING_CSS)}</style>
    <div class="ns-head">
      <div><h1 class="ns-title">Music</h1></div>
      <a class="ns-btn" href="/new-website/sharing/reels">Reels</a>
    </div>
    <div class="sh-panel">
      <form class="mu-bar" method="post" action="/new-website/sharing/music/upload" enctype="multipart/form-data">
        <input type="file" name="files" accept=".mp3,.m4a,.aac,.wav,.ogg,audio/*" multiple required />
        <button class="ns-btn small primary">Upload</button>
      </form>
      ${tracks.length
        ? html`<form method="post" action="/new-website/sharing/music/bulk">
            <div class="mu-bar">
              <label><input type="checkbox" data-mu-all /> All</label>
              <button class="ns-btn small" name="action" value="use">Use</button>
              <button class="ns-btn small" name="action" value="unuse">Don’t use</button>
              <button class="ns-btn small" name="action" value="delete">Delete</button>
            </div>
            <ul class="mu-list">${tracks.map((t) => html`<li>
              <input type="checkbox" name="id" value="${String(t.id)}" aria-label="${t.name}" />
              <b>${t.name}</b>
              <span class="ns-badge ${t.used ? 'ok' : ''}">${t.used ? 'Used' : 'Not used'}</span>
              <audio src="/new-website/sharing/music/${String(t.id)}/file" controls preload="none"></audio>
            </li>`)}</ul>
          </form>`
        : html`<p class="sh-empty">No music yet.</p>`}
    </div>
    <script>
      (function () {
        var all = document.querySelector('[data-mu-all]');
        if (all) all.addEventListener('change', function () {
          document.querySelectorAll('.mu-list input[type=checkbox]').forEach(function (b) { b.checked = all.checked; });
        });
      })();
    </script>`;
}
