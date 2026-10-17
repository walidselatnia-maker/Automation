import { get } from '../db/index.js';
import { html, raw, type Html } from '../web/views/layout.js';
import { listChannels } from './channels.js';
import { listNewWebsites } from './repo.js';

/**
 * Start here: what the platform does, the stages from a fresh install to
 * shared posts, where each one stands, and the one thing to do next.
 */

export interface HomeState {
  platformReady: boolean;
  websites: { id: number; name: string }[];
  channels: number;
  /** Website–channel links: a channel only shares once a website picks it. */
  linkedChannels: number;
  plans: number;
  articles: { published: number; working: number; stopped: number };
  social: { sent: number; failed: number };
  reels: { made: number; failed: number; sharesSent: number; sharesFailed: number };
}

const count = (sql: string): number => Number(get<{ n: number | null }>(sql)?.n ?? 0);

export function homeState(platformReady: boolean): HomeState {
  const stopped = `status = 'failed' OR skeleton_status = 'failed' OR recipe_status = 'failed' OR article_status = 'failed'
    OR images_status = 'failed' OR post_status = 'failed'`;
  const total = count('SELECT COUNT(*) AS n FROM keyword_seo');
  const published = count(`SELECT COUNT(*) AS n FROM keyword_seo WHERE post_status = 'published'`);
  const failed = count(`SELECT COUNT(*) AS n FROM keyword_seo WHERE post_status <> 'published' AND (${stopped})`);
  return {
    platformReady,
    websites: listNewWebsites().map((w) => ({ id: w.id, name: w.name })),
    channels: listChannels().length,
    linkedChannels: count('SELECT COUNT(*) AS n FROM newsite_website_channels'),
    plans: count('SELECT COUNT(*) AS n FROM keyword_plans'),
    articles: { published, working: Math.max(0, total - published - failed), stopped: failed },
    social: {
      sent: count(`SELECT COUNT(*) AS n FROM newsite_social_posts WHERE status = 'sent'`),
      failed: count(`SELECT COUNT(*) AS n FROM newsite_social_posts WHERE status = 'failed'`),
    },
    reels: {
      made: count(`SELECT COUNT(*) AS n FROM newsite_reels WHERE status = 'done'`),
      failed: count(`SELECT COUNT(*) AS n FROM newsite_reels WHERE status = 'failed'`),
      sharesSent: count(`SELECT COUNT(*) AS n FROM newsite_reel_shares WHERE status = 'sent'`),
      sharesFailed: count(`SELECT COUNT(*) AS n FROM newsite_reel_shares WHERE status = 'failed'`),
    },
  };
}

type StageState = 'done' | 'next' | 'todo' | 'locked' | 'optional' | 'attention';

interface Stage {
  title: string;
  purpose: string;
  /** Where it stands, in a few words. */
  fact: string;
  state: StageState;
  action?: { label: string; href: string };
  /** A second, quieter way in. */
  more?: { label: string; href: string };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function homeStages(s: HomeState): Stage[] {
  const hasSite = s.websites.length > 0;
  const firstSite = s.websites[0];
  const stages: Stage[] = [
    {
      title: 'Connect the platform',
      purpose: 'Give the platform its AI key so it can write. Pictures, time zone and notifications are set in the same place.',
      fact: s.platformReady ? 'Connected' : 'No working AI key yet',
      state: s.platformReady ? 'done' : 'todo',
      action: { label: s.platformReady ? 'Open settings' : 'Set up the platform', href: s.platformReady ? '/new-website/platform' : '/new-website/platform/setup' },
    },
    {
      title: 'Add your website',
      purpose: 'The website the articles are published on: its address, its key, its topic and the voice it writes in.',
      fact: hasSite ? plural(s.websites.length, 'website') : 'No website yet',
      state: hasSite ? 'done' : s.platformReady ? 'todo' : 'locked',
      action: hasSite ? { label: 'Open websites', href: '/new-website' } : { label: 'Add website', href: '/new-website/add' },
    },
    {
      title: 'Connect social channels',
      purpose: 'Optional. Pinterest, Facebook, Instagram and the others, through Buffer or their own API. Then pick, in each website’s settings, where it shares.',
      fact: !s.channels
        ? 'No channel yet'
        : s.linkedChannels
          ? `${plural(s.channels, 'channel')}, in use by your websites`
          : `${plural(s.channels, 'channel')}, but no website shares on them yet`,
      state: s.channels && s.linkedChannels ? 'done' : hasSite ? 'optional' : 'locked',
      action: s.channels && !s.linkedChannels && firstSite
        ? { label: 'Pick where a website shares', href: `/new-website/${firstSite.id}/edit?section=4` }
        : { label: s.channels ? 'Open channels' : 'Add a channel', href: s.channels ? '/new-website/channels' : '/new-website/channels/add' },
    },
    {
      title: 'Add keywords',
      purpose: 'Each main keyword becomes a group of articles for one website. Type one in, or bring many from a spreadsheet.',
      fact: s.plans ? plural(s.plans, 'main keyword') : 'No keyword yet',
      state: s.plans ? 'done' : hasSite ? 'todo' : 'locked',
      action: { label: s.plans ? 'Add more keywords' : 'Add keywords', href: '/new-website/keywords/add' },
    },
    {
      title: 'Articles are written and published',
      purpose: 'For each keyword the platform writes the article, makes its pictures and publishes it on your website, step by step. You can follow and fix each step.',
      fact: s.plans
        ? [plural(s.articles.published, 'published article'), s.articles.working ? `${s.articles.working} on the way` : '', s.articles.stopped ? `${s.articles.stopped} stopped` : '']
            .filter(Boolean)
            .join(' · ')
        : 'Starts once keywords are added',
      state: !s.plans ? 'locked' : s.articles.stopped ? 'attention' : s.articles.published ? 'done' : 'todo',
      action: s.plans ? { label: 'Follow your articles', href: '/new-website/keywords' } : undefined,
    },
    {
      title: 'Reels and social posts go out',
      purpose: 'Once an article is published, every channel its website shares on gets its own post, and its one reel is made and sent to the channels that take reels. Nothing to click.',
      fact: s.articles.published
        ? [plural(s.social.sent, 'post') + ' shared', plural(s.reels.made, 'reel') + ' made', s.social.failed + s.reels.failed + s.reels.sharesFailed ? `${s.social.failed + s.reels.failed + s.reels.sharesFailed} need a look` : '']
            .filter(Boolean)
            .join(' · ')
        : 'Starts once an article is published',
      state: !s.articles.published ? 'locked' : s.social.failed + s.reels.failed + s.reels.sharesFailed ? 'attention' : s.social.sent + s.reels.sharesSent ? 'done' : 'todo',
      action: s.articles.published ? { label: 'See social posts', href: '/new-website/sharing' } : undefined,
      more: s.articles.published ? { label: 'Open reels', href: '/new-website/sharing/reels' } : undefined,
    },
  ];
  // The next thing to do: the first stage still to do; an optional one only when nothing else is left.
  const next = stages.find((x) => x.state === 'todo') ?? stages.find((x) => x.state === 'optional');
  if (next) next.state = 'next';
  return stages;
}

const BADGE: Record<StageState, [string, string]> = {
  done: ['ok', 'Done'],
  next: ['busy', 'Do this next'],
  todo: ['', 'To do'],
  locked: ['', 'Waits for the step above'],
  optional: ['', 'Optional'],
  attention: ['bad', 'Needs a look'],
};

const CSS = `
.hm-flow { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 32px; padding: 0; list-style: none; counter-reset: flow; }
.hm-flow li { position: relative; padding: 16px 18px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); }
.hm-flow li b { display: block; font: 700 16px/1.3 var(--display); margin-bottom: 4px; }
.hm-flow li span { color: var(--soft); font-size: 14px; line-height: 1.5; }
.hm-flow li + li::before { content: '→'; position: absolute; left: -11px; top: 50%; transform: translate(-50%, -50%); color: var(--faint); font-weight: 700; }
.hm-attn { margin: 0 0 28px; }
.hm-attn ul { margin: 6px 0 0; padding-left: 20px; }
.hm-attn li { margin: 2px 0; }
.hm-h2 { font-size: 20px; margin: 0 0 14px; }
.hm-stages { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.hm-stage { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 20px; align-items: center; padding: 20px 24px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); }
.hm-stage.next { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), var(--shadow); }
.hm-stage.attention { border-color: var(--bad); }
.hm-stage.locked { background: var(--raised); box-shadow: none; }
.hm-stage.locked .hm-text h3, .hm-stage.locked .hm-text p { color: var(--faint); }
.hm-num { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font: 700 16px var(--display);
  background: var(--idle); color: var(--idle-ink); border: 1px solid var(--idle-line); }
.hm-stage.done .hm-num { background: var(--good-tint); color: var(--good); border-color: transparent; }
.hm-stage.next .hm-num { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.hm-stage.attention .hm-num { background: var(--bad-tint); color: var(--bad); border-color: transparent; }
.hm-text h3 { font-size: 18px; margin: 0 0 4px; }
.hm-text p { margin: 0; color: var(--soft); max-width: 78ch; }
.hm-text .hm-fact { margin-top: 8px; color: var(--ink); font-weight: 600; font-size: 14px; }
.hm-side { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; min-width: 200px; }
.hm-side .hm-btns { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
@media (max-width: 960px) { .hm-flow { grid-template-columns: 1fr 1fr; } .hm-flow li:nth-child(3)::before { display: none; } }
@media (max-width: 720px) {
  .hm-flow { grid-template-columns: 1fr; } .hm-flow li + li::before { display: none; }
  .hm-stage { grid-template-columns: 40px minmax(0, 1fr); gap: 14px; padding: 18px; }
  .hm-side { grid-column: 1 / -1; align-items: flex-start; min-width: 0; }
  .hm-side .hm-btns { justify-content: flex-start; }
}
`;

export function homePage(s: HomeState): Html {
  const stages = homeStages(s);
  const attention: [string, string][] = [];
  if (s.articles.stopped) attention.push([`${plural(s.articles.stopped, 'article')} stopped at a step. Open it to see why and try again.`, '/new-website/keywords']);
  if (s.social.failed) attention.push([`${plural(s.social.failed, 'social post')} could not be sent.`, '/new-website/sharing']);
  if (s.reels.failed + s.reels.sharesFailed) attention.push([`${plural(s.reels.failed + s.reels.sharesFailed, 'reel')} could not be made or sent.`, '/new-website/sharing/reels']);
  const next = stages.find((x) => x.state === 'next');
  return html`
    <style>${raw(CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Start here</h1>
        <p class="ns-lede">This platform writes articles from your keywords, publishes them on your website, and shares them on social media with a picture post and a short reel. Set it up once, add keywords, and the rest runs by itself.</p>
      </div>
      ${next?.action ? html`<a class="ns-btn primary" href="${next.action.href}">${next.action.label}</a>` : raw('')}
    </div>
    <ol class="hm-flow" aria-label="How it works">
      <li><b>Keyword</b><span>You choose what to write about.</span></li>
      <li><b>Article</b><span>The AI writes it and makes its pictures.</span></li>
      <li><b>Your website</b><span>It is published there.</span></li>
      <li><b>Social media</b><span>Each channel gets a post, and the reel.</span></li>
    </ol>
    ${attention.length
      ? html`<div class="ns-alert bad hm-attn" role="status"><b>Needs your attention</b><ul>${attention.map(([text, href]) => html`<li><a href="${href}">${text}</a></li>`)}</ul></div>`
      : raw('')}
    <h2 class="hm-h2">Your steps</h2>
    <ol class="hm-stages">${stages.map((st, i) => {
      const [kind, word] = BADGE[st.state];
      return html`<li class="hm-stage ${st.state}">
        <span class="hm-num" aria-hidden="true">${st.state === 'done' ? '✓' : String(i + 1)}</span>
        <div class="hm-text"><h3>${st.title}</h3><p>${st.purpose}</p><p class="hm-fact">${st.fact}</p></div>
        <div class="hm-side">
          <span class="ns-badge ${kind}">${word}</span>
          ${st.state === 'locked' || !st.action
            ? raw('')
            : html`<span class="hm-btns">${st.more ? html`<a class="ns-btn small" href="${st.more.href}">${st.more.label}</a>` : raw('')}<a class="ns-btn small ${st.state === 'next' || st.state === 'attention' ? 'primary' : ''}" href="${st.action.href}">${st.action.label}</a></span>`}
        </div>
      </li>`;
    })}</ol>`;
}
