import { all } from '../db/index.js';
import { failedArticlePictures } from './pictures.js';
import { html, raw, type Html } from '../web/views/layout.js';
import { PLATFORMS } from './channels.js';
import { listNewWebsites } from './repo.js';
import { NO_BOARD } from './social.js';
import { skippedKeywords } from './duplicates.js';
import { allSearchKeysFailed, listSearchKeys } from './search-keys.js';

/**
 * The dashboard: what the content generation did over a period, at a glance.
 *
 * Everything is read from what the pipeline already records (when an article
 * was published, when a picture, a post or a reel was made or sent), counted
 * per day in the platform's time zone. Nothing here changes anything.
 */

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

interface Day {
  key: string;
  label: string;
  articles: number;
  pictures: number;
  posts: number;
  reels: number;
}

interface Kpi {
  label: string;
  value: number;
  before: number;
  tone: string;
  href: string;
}

export interface DashboardData {
  days: Period;
  kpis: Kpi[];
  daily: Day[];
  funnel: { label: string; count: number; tone: string }[];
  platforms: { label: string; color: string; sent: number; failed: number }[];
  websites: { name: string; domain: string; published: number; working: number; posts: number; inPeriod: number }[];
  problems: { label: string; count: number; href: string }[];
  /** One line per thing to fix by hand or to know: a keyword with no Pinterest board, a keyword skipped as a duplicate. */
  notes: { text: string; href: string }[];
  recent: { when: number; kind: 'article' | 'post' | 'reel'; title: string; where: string; color?: string; href?: string }[];
}

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) as a time. */
const ms = (v: string | null | undefined): number => (v ? Date.parse(v.replace(' ', 'T') + 'Z') || 0 : 0);

export function dashboardData(days: Period, timezone: string, now = Date.now()): DashboardData {
  const zone = (() => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
  })();
  const dayOf = (t: number): string => zone.format(new Date(t));
  const span = days * 86_400_000;
  const since = now - span;
  const inPeriod = (t: number) => t > since && t <= now;
  const inBefore = (t: number) => t > since - span && t <= since;

  const articles = all<{ posted_at: string; article_words: number; website_id: number; title: string; keyword: string; post_url: string; site: string }>(
    `SELECT s.posted_at, COALESCE(s.article_words, 0) AS article_words, p.website_id, s.title, s.keyword, s.post_url, COALESCE(w.name, '') AS site
       FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id LEFT JOIN new_websites w ON w.id = p.website_id
      WHERE s.post_status = 'published' AND s.posted_at IS NOT NULL`,
  ).map((r) => ({ ...r, t: ms(r.posted_at) }));
  const pictures = all<{ made_at: string }>(`SELECT made_at FROM newsite_pictures WHERE status = 'done' AND made_at IS NOT NULL`).map((r) => ms(r.made_at));
  const posts = all<{ sent_at: string | null; status: string; platform: string; name: string; post_link: string; website_id: number | null; title: string }>(
    `SELECT p.sent_at, p.status, c.platform, c.name, p.post_link, pl.website_id, COALESCE(NULLIF(s.title, ''), s.keyword) AS title
       FROM newsite_social_posts p JOIN newsite_channels c ON c.id = p.channel_id
       LEFT JOIN keyword_seo s ON s.id = p.seo_id LEFT JOIN keyword_plans pl ON pl.id = s.plan_id
     UNION ALL
     SELECT r.sent_at, r.status, c.platform, c.name, r.post_link, pl.website_id, COALESCE(NULLIF(s.title, ''), s.keyword) AS title
       FROM newsite_reel_shares r JOIN newsite_channels c ON c.id = r.channel_id
       JOIN newsite_reels re ON re.id = r.reel_id LEFT JOIN keyword_seo s ON s.id = re.seo_id LEFT JOIN keyword_plans pl ON pl.id = s.plan_id`,
  ).map((r) => ({ ...r, t: ms(r.sent_at) }));
  const reels = all<{ done_at: string | null; status: string; title: string }>(
    `SELECT r.done_at, r.status, COALESCE(NULLIF(s.title, ''), s.keyword) AS title FROM newsite_reels r LEFT JOIN keyword_seo s ON s.id = r.seo_id`,
  ).map((r) => ({ ...r, t: ms(r.done_at) }));
  const sent = posts.filter((p) => p.status === 'sent' && p.t);
  const madeReels = reels.filter((r) => r.status === 'done' && r.t);

  const count = <T>(list: T[], when: (x: T) => number, test: (t: number) => boolean) => list.filter((x) => test(when(x))).length;
  const words = (test: (t: number) => boolean) => articles.filter((a) => test(a.t)).reduce((n, a) => n + a.article_words, 0);

  const kpis: Kpi[] = [
    { label: 'Articles published', value: count(articles, (a) => a.t, inPeriod), before: count(articles, (a) => a.t, inBefore), tone: 'c-articles', href: '/new-website/keywords' },
    { label: 'Words written', value: words(inPeriod), before: words(inBefore), tone: 'c-words', href: '/new-website/keywords' },
    { label: 'Pictures made', value: count(pictures, (t) => t, inPeriod), before: count(pictures, (t) => t, inBefore), tone: 'c-pictures', href: '/new-website/keywords' },
    { label: 'Social posts sent', value: count(sent, (p) => p.t, inPeriod), before: count(sent, (p) => p.t, inBefore), tone: 'c-posts', href: '/new-website/sharing' },
    { label: 'Reels made', value: count(madeReels, (r) => r.t, inPeriod), before: count(madeReels, (r) => r.t, inBefore), tone: 'c-reels', href: '/new-website/sharing/reels' },
  ];

  const daily: Day[] = [];
  const index = new Map<string, Day>();
  for (let i = days - 1; i >= 0; i--) {
    const t = now - i * 86_400_000;
    const key = dayOf(t);
    if (index.has(key)) continue;
    const d = new Date(t);
    const day: Day = { key, label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: timezone || 'UTC' }), articles: 0, pictures: 0, posts: 0, reels: 0 };
    index.set(key, day);
    daily.push(day);
  }
  for (const a of articles) if (inPeriod(a.t)) index.get(dayOf(a.t)) && index.get(dayOf(a.t))!.articles++;
  for (const t of pictures) if (inPeriod(t)) index.get(dayOf(t)) && index.get(dayOf(t))!.pictures++;
  for (const p of sent) if (inPeriod(p.t)) index.get(dayOf(p.t)) && index.get(dayOf(p.t))!.posts++;
  for (const r of madeReels) if (inPeriod(r.t)) index.get(dayOf(r.t)) && index.get(dayOf(r.t))!.reels++;

  const stage = all<{ total: number; seo: number; written: number; pictures: number; published: number }>(
    `SELECT COUNT(*) AS total,
            SUM(status = 'done') AS seo,
            SUM(article_status = 'done') AS written,
            SUM(images_status = 'done') AS pictures,
            SUM(post_status = 'published') AS published
       FROM keyword_seo`,
  )[0] ?? { total: 0, seo: 0, written: 0, pictures: 0, published: 0 };
  const sharedArticles = all<{ n: number }>(
    `SELECT COUNT(DISTINCT seo_id) AS n FROM newsite_social_posts WHERE status = 'sent'`,
  )[0]?.n ?? 0;
  const funnel = [
    { label: 'Keywords', count: stage.total ?? 0, tone: 'c-keywords' },
    { label: 'SEO written', count: stage.seo ?? 0, tone: 'c-words' },
    { label: 'Articles written', count: stage.written ?? 0, tone: 'c-articles' },
    { label: 'Pictures ready', count: stage.pictures ?? 0, tone: 'c-pictures' },
    { label: 'Published', count: stage.published ?? 0, tone: 'c-published' },
    { label: 'Shared', count: sharedArticles, tone: 'c-posts' },
  ];

  const platforms = PLATFORMS.map((p) => ({
    label: p.label,
    color: p.color,
    sent: posts.filter((x) => x.platform === p.key && x.status === 'sent' && inPeriod(x.t)).length,
    failed: posts.filter((x) => x.platform === p.key && x.status === 'failed').length,
  })).filter((p) => p.sent || p.failed);

  const working = all<{ website_id: number; n: number }>(
    `SELECT p.website_id, COUNT(*) AS n FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id
      WHERE COALESCE(s.post_status, '') NOT IN ('published', 'failed')
        AND s.status != 'failed' AND COALESCE(s.article_status, '') != 'failed' AND COALESCE(s.images_status, '') != 'failed'
      GROUP BY p.website_id`,
  );
  const websites = listNewWebsites().map((w) => ({
    name: w.name,
    domain: w.domain,
    published: articles.filter((a) => a.website_id === w.id).length,
    inPeriod: articles.filter((a) => a.website_id === w.id && inPeriod(a.t)).length,
    working: working.find((x) => x.website_id === w.id)?.n ?? 0,
    posts: sent.filter((p) => p.website_id === w.id && inPeriod(p.t)).length,
  }));

  const n = (sql: string): number => all<{ n: number }>(sql)[0]?.n ?? 0;
  const problems = [
    {
      label: 'article stopped|articles stopped',
      count: n(`SELECT COUNT(*) AS n FROM keyword_seo WHERE status = 'failed' OR recipe_status = 'failed' OR skeleton_status = 'failed' OR article_status = 'failed' OR images_status = 'failed' OR post_status = 'failed'`),
      href: '/new-website/keywords',
    },
    { label: 'picture failed|pictures failed', count: failedArticlePictures().length, href: '/new-website/keywords' },
    { label: 'social post not sent|social posts not sent', count: posts.filter((p) => p.status === 'failed').length, href: '/new-website/sharing' },
    { label: 'reel not made|reels not made', count: reels.filter((r) => r.status === 'failed').length, href: '/new-website/sharing/reels' },
    // Every search key failed: Content research cannot read Google.
    { label: 'search key failed (all of them)|search keys failed (all of them)', count: allSearchKeysFailed() ? listSearchKeys().length : 0, href: '/new-website/platform#search-keys' },
  ].filter((p) => p.count);

  const noBoard = all<{ keyword: string; site: string }>(
    `SELECT DISTINCT s.keyword, COALESCE(w.name, '') AS site FROM (
       SELECT seo_id, error FROM newsite_social_posts WHERE status = 'failed'
       UNION ALL SELECT re.seo_id, r.error FROM newsite_reel_shares r JOIN newsite_reels re ON re.id = r.reel_id WHERE r.status = 'failed'
     ) f JOIN keyword_seo s ON s.id = f.seo_id LEFT JOIN keyword_plans pl ON pl.id = s.plan_id LEFT JOIN new_websites w ON w.id = pl.website_id
     WHERE f.error = ? ORDER BY s.id`,
    NO_BOARD,
  );
  const notes = [
    ...noBoard.map((r) => ({ text: `No Pinterest board for “${r.keyword}”${r.site ? ` (${r.site})` : ''}: add a board with “general” in its name`, href: '/new-website/sharing' })),
    ...skippedKeywords().map((r) => ({ text: `“${r.keyword}”${r.site ? ` (${r.site})` : ''} skipped: ${r.skip_reason}`, href: '/new-website/keywords' })),
  ];

  const colorOf = (platform: string) => PLATFORMS.find((p) => p.key === platform)?.color;
  const recent = [
    ...articles.map((a) => ({ when: a.t, kind: 'article' as const, title: a.title || a.keyword, where: a.site, href: a.post_url || undefined })),
    ...sent.map((p) => ({ when: p.t, kind: 'post' as const, title: p.title ?? '', where: p.name, color: colorOf(p.platform), href: p.post_link || undefined })),
    ...madeReels.map((r) => ({ when: r.t, kind: 'reel' as const, title: r.title ?? '', where: 'Reel made', href: '/new-website/sharing/reels' })),
  ]
    .filter((r) => r.when <= now)
    .sort((a, b) => b.when - a.when)
    .slice(0, 8);

  return { days, kpis, daily, funnel, platforms, websites, problems, notes, recent };
}

/* -- The page ------------------------------------------------------------- */

const CSS = `
.db { --c-articles: #6366f1; --c-words: #8b5cf6; --c-pictures: #f59e0b; --c-posts: #14b8a6; --c-reels: #ec4899; --c-keywords: #64748b; --c-published: #22c55e; }
html.dark .db { --c-articles: #7f86dc; --c-words: #9b89d8; --c-pictures: #d6a545; --c-posts: #43b5a3; --c-reels: #d3709f; --c-keywords: #8a96a8; --c-published: #5fb784; }
.db-periods { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 999px; padding: 3px; background: var(--surface); }
.db-periods a { padding: 6px 14px; border-radius: 999px; font: 600 13px/1 var(--body); color: var(--soft); text-decoration: none; }
.db-periods a.on { background: var(--ink); color: var(--surface); }
.db-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 18px; }
.db-kpi { position: relative; display: block; padding: 16px 18px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); text-decoration: none; color: var(--ink); overflow: hidden; }
.db-kpi::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 4px; background: var(--tone); }
.db-kpi:hover { border-color: var(--tone); }
.db-kpi span { display: block; font-size: 13px; font-weight: 600; color: var(--soft); }
.db-kpi b { display: block; margin: 6px 0 4px; font: 700 30px/1.1 var(--display); letter-spacing: -.02em; }
.db-kpi small { font-size: 12px; font-weight: 600; color: var(--faint); }
.db-kpi small.up { color: var(--good); }
.db-kpi small.down { color: var(--bad); }
.db-kpi small em { display: block; font-style: normal; font-weight: 500; color: var(--faint); margin-top: 2px; }
.db-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 18px; margin-bottom: 18px; }
.db-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); padding: 18px 20px; min-width: 0; }
.db-card h2 { font-size: 16px; margin: 0 0 14px; }
.db-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 10px; padding: 0; list-style: none; font-size: 13px; color: var(--soft); }
.db-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; background: var(--k); }
.db-chart { width: 100%; height: auto; display: block; }
.db-chart text { fill: var(--faint); font: 11px var(--body); }
.db-chart .grid { stroke: var(--line); stroke-width: 1; }
.db-funnel { display: grid; gap: 10px; }
.db-funnel div { display: grid; grid-template-columns: 120px minmax(0, 1fr) 44px; align-items: center; gap: 10px; font-size: 13px; }
.db-funnel span { color: var(--soft); font-weight: 600; }
.db-funnel em { height: 12px; border-radius: 999px; background: var(--raised); overflow: hidden; }
.db-funnel em i { display: block; height: 100%; border-radius: 999px; background: var(--tone); min-width: 3px; }
.db-funnel b { text-align: right; font-variant-numeric: tabular-nums; }
.db-donut { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 24px; align-items: center; }
.db-donut svg { width: 150px; height: 150px; }
.db-donut .total { fill: var(--ink); font: 700 26px var(--display); }
.db-donut .cap { fill: var(--faint); font: 600 11px var(--body); }
.db-plat { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 14px; }
.db-plat li { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; }
.db-plat li span:first-of-type small { display: block; margin: 0; font-size: 12px; }
.db-plat b { font-variant-numeric: tabular-nums; }
.db-plat i { width: 10px; height: 10px; border-radius: 50%; background: var(--k); }
.db-plat small { color: var(--bad); font-weight: 600; }
.db-sites { width: 100%; border-collapse: collapse; font-size: 14px; }
.db-sites th { text-align: left; font-size: 12px; font-weight: 600; color: var(--faint); padding: 0 8px 8px; border-bottom: 1px solid var(--line); }
.db-sites td { padding: 10px 8px; border-bottom: 1px solid var(--line); }
.db-sites tr:last-child td { border-bottom: 0; }
.db-sites td small { display: block; color: var(--faint); font: 12px var(--mono); }
.db-sites .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.db-recent { list-style: none; margin: 0; padding: 0; }
.db-recent li { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px solid var(--line); font-size: 14px; }
.db-recent li:first-child { border-top: 0; }
.db-recent .ic { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: #fff; background: var(--k); font-size: 13px; font-weight: 700; }
.db-recent a, .db-recent b { color: var(--ink); text-decoration: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.db-recent a:hover { text-decoration: underline; }
.db-recent span { display: block; color: var(--soft); font-size: 13px; }
.db-recent time { color: var(--faint); font-size: 12px; white-space: nowrap; }
.db-problems { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 18px; padding: 12px 16px; border: 1px solid var(--bad); border-left-width: 4px; border-radius: var(--r-ctl); background: var(--bad-tint); }
.db-problems b { margin-right: 4px; }
.db-problems a { color: var(--bad); font-weight: 600; text-decoration: none; }
.db-notes { margin: 0 0 18px; padding: 10px 16px 10px 34px; border: 1px solid var(--line-strong); border-left: 4px solid var(--bad); border-radius: var(--r-ctl); background: var(--surface); display: grid; gap: 4px; }
.db-notes a { color: var(--ink); font-weight: 600; text-decoration: none; }
.db-problems a:hover { text-decoration: underline; }
.db-empty { color: var(--faint); font-size: 14px; padding: 20px 0; text-align: center; }
@media (max-width: 1100px) { .db-grid { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .db-donut { grid-template-columns: 1fr; justify-items: center; } .db-funnel div { grid-template-columns: 96px minmax(0, 1fr) 36px; } }
`;

const fmt = (n: number): string => n.toLocaleString('en-US');

/** The change against the period before, as a small arrow and percentage; the period is already chosen at the top. */
function change(k: Kpi, days: number): Html {
  const title = `vs the ${String(days)} days before`;
  if (!k.before) return raw('');
  const pct = Math.round(((k.value - k.before) / k.before) * 100);
  if (pct === 0) return raw('');
  return html`<small class="${pct > 0 ? 'up' : 'down'}" title="${title}">${pct > 0 ? '▲' : '▼'} ${String(Math.abs(pct))}%</small>`;
}

/** Articles a day as bars; pictures, social posts and reels as lines over them. */
function activityChart(daily: Day[]): Html {
  const W = 760, H = 240, L = 34, R = 10, T = 10, B = 26;
  const max = Math.max(1, ...daily.flatMap((d) => [d.articles, d.pictures, d.posts, d.reels]));
  const top = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const x = (i: number) => L + ((i + 0.5) * (W - L - R)) / daily.length;
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const bw = Math.max(2, Math.min(22, ((W - L - R) / daily.length) * 0.6));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(top * f)).filter((v, i, a) => a.indexOf(v) === i);
  const every = Math.ceil(daily.length / 8);
  const line = (key: 'pictures' | 'posts' | 'reels') => daily.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  const svg = `<svg class="db-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Activity per day">
    ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${daily.map((d, i) => (d.articles ? `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y(d.articles).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(d.articles)).toFixed(1)}" rx="3" fill="var(--c-articles)"><title>${d.label}: ${d.articles} articles</title></rect>` : '')).join('')}
    <path d="${line('pictures')}" fill="none" stroke="var(--c-pictures)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${line('posts')}" fill="none" stroke="var(--c-posts)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${line('reels')}" fill="none" stroke="var(--c-reels)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>
    ${daily.map((d, i) => (d.posts ? `<circle cx="${x(i).toFixed(1)}" cy="${y(d.posts).toFixed(1)}" r="3" fill="var(--c-posts)"><title>${d.label}: ${d.posts} social posts</title></circle>` : '')).join('')}
    ${daily.map((d, i) => (i % every === (daily.length - 1) % every ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${i === daily.length - 1 ? 'end' : 'middle'}">${i === daily.length - 1 ? 'Today' : d.label}</text>` : '')).join('')}
  </svg>`;
  return raw(svg);
}

function donut(platforms: DashboardData['platforms']): Html {
  const total = platforms.reduce((n, p) => n + p.sent, 0);
  const r = 58, c = 2 * Math.PI * r;
  let at = 0;
  const arcs = platforms
    .filter((p) => p.sent)
    .map((p) => {
      const len = (p.sent / total) * c;
      const s = `<circle cx="75" cy="75" r="${r}" fill="none" stroke="${p.color}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-at).toFixed(2)}" transform="rotate(-90 75 75)"><title>${p.label}: ${p.sent}</title></circle>`;
      at += len;
      return s;
    })
    .join('');
  return raw(`<svg viewBox="0 0 150 150" role="img" aria-label="Social posts by platform">
    <circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--raised)" stroke-width="18"/>${arcs}
    <text class="total" x="75" y="78" text-anchor="middle">${total}</text><text class="cap" x="75" y="96" text-anchor="middle">SENT</text></svg>`);
}

const ago = (t: number, now: number): string => {
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};

export function dashboardPage(d: DashboardData, now = Date.now(), autopilot: Html = raw('')): Html {
  const top = Math.max(1, ...d.funnel.map((f) => f.count));
  const totalActivity = d.daily.reduce((n, x) => n + x.articles + x.pictures + x.posts + x.reels, 0);
  const KIND = { article: { letter: 'A', k: 'var(--c-articles)', verb: 'Article published' }, post: { letter: 'P', k: 'var(--c-posts)', verb: 'Posted on' }, reel: { letter: 'R', k: 'var(--c-reels)', verb: '' } };
  return html`
    <style>${raw(CSS)}</style>
    <div class="db" data-plain>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Dashboard</h1>
      </div>
      <nav class="db-periods" aria-label="Period">${PERIODS.map((p) => html`<a href="/new-website/dashboard?days=${String(p)}" class="${p === d.days ? 'on' : ''}">${String(p)} days</a>`)}</nav>
    </div>

    ${autopilot}

    ${d.problems.length
      ? html`<div class="db-problems" role="status"><b>Needs your attention:</b>${d.problems.map((p, i) => html`${i ? ' · ' : ''}<a href="${p.href}">${String(p.count)} ${p.label.split('|')[p.count === 1 ? 0 : 1]!}</a>`)}</div>`
      : raw('')}
    ${d.notes.length ? html`<ul class="db-notes" role="status">${d.notes.map((n) => html`<li><a href="${n.href}">${n.text}</a></li>`)}</ul>` : raw('')}

    <div class="db-kpis">
      ${d.kpis.map((k) => html`<a class="db-kpi" href="${k.href}" style="--tone:var(--${k.tone})"><span>${k.label}</span><b>${fmt(k.value)}</b>${change(k, d.days)}</a>`)}
    </div>

    <div class="db-grid">
      <section class="db-card">
        <h2>Activity per day</h2>
        <ul class="db-legend"><li><i style="--k:var(--c-articles)"></i>Articles</li><li><i style="--k:var(--c-pictures)"></i>Pictures</li><li><i style="--k:var(--c-posts)"></i>Social posts</li><li><i style="--k:var(--c-reels)"></i>Reels</li></ul>
        ${totalActivity ? activityChart(d.daily) : html`<p class="db-empty">Nothing was made, published or shared in this period.</p>`}
      </section>
      <section class="db-card">
        <h2>Where the articles are</h2>
        <div class="db-funnel">${d.funnel.map(
          (f) => html`<div><span>${f.label}</span><em><i style="--tone:var(--${f.tone});width:${String(Math.round((f.count / top) * 100))}%"></i></em><b>${fmt(f.count)}</b></div>`,
        )}</div>
      </section>
    </div>

    <div class="db-grid">
      <section class="db-card">
        <h2>Websites</h2>
        ${d.websites.length
          ? html`<table class="db-sites"><thead><tr><th>Website</th><th class="num">Published</th><th class="num">Last ${String(d.days)} days</th><th class="num">On the way</th><th class="num">Posts sent</th></tr></thead>
              <tbody>${d.websites.map((w) => html`<tr><td>${w.name}<small>${w.domain}</small></td><td class="num">${fmt(w.published)}</td><td class="num">${fmt(w.inPeriod)}</td><td class="num">${fmt(w.working)}</td><td class="num">${fmt(w.posts)}</td></tr>`)}</tbody></table>`
          : html`<p class="db-empty">No website yet. <a href="/new-website/add">Add one</a>.</p>`}
      </section>
      <section class="db-card">
        <h2>Social posts by platform</h2>
        ${d.platforms.length
          ? html`<div class="db-donut">${donut(d.platforms)}<ul class="db-plat">${d.platforms.map(
              (p) => html`<li><i style="--k:${p.color}"></i><span>${p.label}${p.failed ? html`<small>${String(p.failed)} not sent</small>` : raw('')}</span><b>${fmt(p.sent)}</b></li>`,
            )}</ul></div>`
          : html`<p class="db-empty">No social post yet.</p>`}
      </section>
    </div>

    <section class="db-card">
      <h2>Latest</h2>
      ${d.recent.length
        ? html`<ul class="db-recent">${d.recent.map((r) => {
            const k = KIND[r.kind];
            const title = r.href ? html`<a href="${r.href}" ${raw(r.href.startsWith('http') ? 'target="_blank" rel="noopener"' : '')}>${r.title}</a>` : html`<b>${r.title}</b>`;
            const where = r.kind === 'post' ? html`${k.verb} <span style="display:inline;color:${r.color ?? 'inherit'};font-weight:600">${r.where}</span>` : r.kind === 'article' ? html`${k.verb} on ${r.where}` : html`${r.where}`;
            return html`<li><span class="ic" style="--k:${k.k}">${k.letter}</span><div>${title}<span>${where}</span></div><time>${ago(r.when, now)}</time></li>`;
          })}</ul>`
        : html`<p class="db-empty">Nothing yet. Add keywords and the platform starts writing.</p>`}
    </section>
    </div>
    <script>setInterval(() => { if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) location.reload(); }, 60000);</script>`;
}
