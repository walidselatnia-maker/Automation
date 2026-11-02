import type { FastifyInstance } from 'fastify';
import { all, get, getDb, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { html, raw } from '../web/views/layout.js';
import { savePost, type Fetch } from './client.js';
import { newLayout, type NewFlash } from './layout.js';
import { getNewWebsite, listNewWebsites, websiteApiKey, type NewWebsiteRow } from './repo.js';

/**
 * Top lists: a website's own posts, read through its API, grouped by the
 * words their titles share ("zucchini bread" in 12 titles). Each group is a
 * suggestion; an approved one is written as a round-up post linking every
 * post in it and published in the website's "Top lists" category.
 */

const log = createLogger('newsite-top-lists');

export const TOP_LISTS_CATEGORY = 'Top lists';

interface Post {
  id: number;
  title: string;
  url: string;
  excerpt: string;
  coverId: number | null;
  coverUrl: string;
}

interface SuggestionRow {
  id: number;
  website_id: number;
  topic: string;
  posts_json: string;
  /** The posts' titles when scanned, in the same order, for the page. */
  titles_json: string;
  status: 'suggested' | 'rejected' | 'writing' | 'published' | 'failed';
  error: string;
  post_id: number | null;
  post_url: string;
  created_at: string;
}

function ensureTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS top_list_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER NOT NULL,
      topic TEXT NOT NULL,
      posts_json TEXT NOT NULL DEFAULT '[]',
      titles_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'suggested',
      error TEXT NOT NULL DEFAULT '',
      post_id INTEGER,
      post_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (website_id, topic)
    );
  `);
}

/* -- Finding the topics ---------------------------------------------------- */

/** Words that never start or end a topic, in the languages the websites write in, and list filler. */
const STOP = new Set(
  (
    'a an the and or of for with to in on at by from your my our how what why best easy quick simple homemade ultimate perfect ' +
    'delicious recipe recipes ideas idea guide tips make making made style way ways minute minutes the it its is are you this that ' +
    'le la les un une des de du et ou au aux avec pour en sur sans recette recettes facile rapide maison ' +
    'el los las y con para sin receta recetas fácil ' +
    'der die das und mit für ohne rezept rezepte einfach schnell'
  ).split(/\s+/),
);

const tokens = (title: string): string[] => title.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
/** "breads" and "bread" count as one word. */
const stem = (w: string): string => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export interface Topic {
  topic: string;
  postIds: number[];
}

/**
 * Phrases of one to three words that at least `min` post titles share. A
 * shorter phrase is dropped when a longer one holds nearly all its posts
 * ("zucchini" goes when "zucchini bread" has most of them).
 */
export function findTopics(posts: { id: number; title: string }[], min: number): Topic[] {
  const groups = new Map<string, { ids: Set<number>; forms: Map<string, number> }>();
  for (const post of posts) {
    const words = tokens(post.title);
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const part = words.slice(i, i + n);
        if (STOP.has(part[0]!) || STOP.has(part[n - 1]!)) continue;
        if (n === 1 && (part[0]!.length < 4 || /^\d+$/.test(part[0]!))) continue;
        const key = part.map(stem).join(' ');
        const group = groups.get(key) ?? { ids: new Set<number>(), forms: new Map<string, number>() };
        group.ids.add(post.id);
        const form = part.join(' ');
        group.forms.set(form, (group.forms.get(form) ?? 0) + 1);
        groups.set(key, group);
      }
    }
  }
  const kept = [...groups.entries()].filter(([, g]) => g.ids.size >= min);
  const topics = kept.filter(([key, g]) =>
    !kept.some(([other, o]) => other !== key && ` ${other} `.includes(` ${key} `) && o.ids.size >= g.ids.size * 0.8),
  );
  return topics
    .map(([, g]) => ({
      topic: [...g.forms.entries()].sort((a, b) => b[1] - a[1])[0]![0],
      postIds: [...g.ids],
    }))
    .sort((a, b) => b.postIds.length - a.postIds.length)
    .slice(0, 60);
}

/* -- Reading the website --------------------------------------------------- */

/** Every published post with what a top list shows of it (GET /api/v1/posts, 100 at a time). */
export async function readPosts(site: NewWebsiteRow, apiKey: string, fetchImpl: Fetch = fetch): Promise<Post[]> {
  const posts: Post[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await fetchImpl(`https://${site.domain}/api/v1/posts?perPage=100&page=${page}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!response) throw new Error(`Could not reach ${site.domain} to read its posts.`);
    if (!response.ok) throw new Error(`${site.domain} could not list its posts (HTTP ${response.status}).`);
    const body = (await response.json().catch(() => null)) as { items?: Record<string, unknown>[]; pages?: unknown } | null;
    if (!body || !Array.isArray(body.items)) throw new Error(`${site.domain} answered the post list in an unknown shape.`);
    for (const item of body.items) {
      if (typeof item.status === 'string' && item.status !== 'published') continue;
      // A top list is not listed in another top list.
      const category = item.category as { name?: unknown } | string | undefined;
      const categoryName = typeof category === 'string' ? category : String(category?.name ?? '');
      if (categoryName.toLowerCase() === TOP_LISTS_CATEGORY.toLowerCase()) continue;
      const cover = item.cover as { id?: unknown; url?: unknown } | string | null | undefined;
      const coverId = typeof cover === 'object' && cover ? Number(cover.id) : NaN;
      posts.push({
        id: Number(item.id),
        title: String(item.title ?? ''),
        url: String(item.url ?? '') || `https://${site.domain}/${String(item.slug ?? '')}`,
        excerpt: String(item.excerpt ?? ''),
        coverId: Number.isFinite(coverId) ? coverId : null,
        coverUrl: typeof cover === 'string' ? cover : String((cover as { url?: unknown } | null)?.url ?? item.coverUrl ?? ''),
      });
    }
    const pages = Number(body.pages);
    if (!Number.isFinite(pages) || page >= pages || !body.items.length) break;
  }
  return posts.filter((p) => Number.isFinite(p.id) && p.title);
}

/* -- Writing a top list ---------------------------------------------------- */

export interface TopListDeps {
  encryptionKey: Buffer;
  readFlash: (query: unknown) => NewFlash;
  ask: (promptName: string, variables: Record<string, unknown>, chat?: string) => Promise<string>;
  fetchImpl?: Fetch;
}

const parseJson = (raw: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/** Write one approved suggestion and publish it. Never throws: the outcome is kept on the suggestion. */
export async function writeTopList(id: number, deps: TopListDeps): Promise<void> {
  const row = get<SuggestionRow>('SELECT * FROM top_list_suggestions WHERE id = ?', id);
  const site = row ? getNewWebsite(row.website_id) : undefined;
  if (!row || !site) return;
  run(`UPDATE top_list_suggestions SET status = 'writing', error = '' WHERE id = ?`, id);
  try {
    const apiKey = websiteApiKey(site, deps.encryptionKey);
    // Read the posts again: titles, links and covers may have changed since the scan.
    const wanted = new Set((JSON.parse(row.posts_json) as number[]).map(Number));
    const posts = (await readPosts(site, apiKey, deps.fetchImpl)).filter((p) => wanted.has(p.id));
    if (posts.length < 2) throw new Error('Fewer than 2 of its posts are still published.');

    const answer = parseJson(
      await deps.ask('top-list-post', {
        language: site.language,
        niche: site.niche,
        topic: row.topic,
        postsJson: JSON.stringify(posts.map((p) => ({ id: p.id, title: p.title, excerpt: p.excerpt }))),
      }),
    );
    const title = String(answer?.title ?? '').trim();
    const items = Array.isArray(answer?.items) ? (answer!.items as { id?: unknown; blurb?: unknown }[]) : [];
    if (!title || !items.length) throw new Error('The AI did not answer with a title and the posts.');

    const byId = new Map(posts.map((p) => [p.id, p]));
    const order = [
      ...items.map((i) => byId.get(Number(i.id))).filter((p): p is Post => Boolean(p)),
      ...posts.filter((p) => !items.some((i) => Number(i.id) === p.id)),
    ];
    const blurbs = new Map(items.map((i) => [Number(i.id), String(i.blurb ?? '').trim()]));
    const sections = order.map((p, n) =>
      [
        `## ${n + 1}. [${p.title}](${p.url})`,
        p.coverUrl ? `[![${p.title}](${p.coverUrl})](${p.url})` : '',
        blurbs.get(p.id) || p.excerpt,
        `[See ${p.title}](${p.url})`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    const content = [String(answer?.intro ?? '').trim(), ...sections, String(answer?.outro ?? '').trim()].filter(Boolean).join('\n\n');
    // The list gives each post's photo address, not its media id: the first photo is added once as the list's own cover.
    const first = order.find((p) => p.coverId || p.coverUrl);
    let coverId = first?.coverId ?? null;
    if (first && !coverId) {
      const response = await (deps.fetchImpl ?? fetch)(`https://${site.domain}/api/v1/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: first.coverUrl, alt: first.title }),
        signal: AbortSignal.timeout(60_000),
      }).catch(() => null);
      const id = Number(((await response?.json().catch(() => null)) as { media?: { id?: unknown } } | null)?.media?.id);
      if (response?.ok && Number.isFinite(id)) coverId = id;
    }

    const saved = await savePost(
      site.domain,
      apiKey,
      {
        externalId: `top-list-${row.id}`,
        type: 'article',
        title,
        slug: slugify(title),
        excerpt: String(answer?.excerpt ?? '').trim(),
        content,
        contentFormat: 'markdown',
        status: 'published',
        category: TOP_LISTS_CATEGORY,
        ...(first && coverId ? { cover: coverId, coverAlt: first.title } : {}),
        seo: { metaTitle: title, metaDescription: String(answer?.excerpt ?? '').trim(), focusKeyword: row.topic },
      },
      deps.fetchImpl,
    );
    run(`UPDATE top_list_suggestions SET status = 'published', post_id = ?, post_url = ?, error = '' WHERE id = ?`, saved.id, saved.url, id);
  } catch (err) {
    const message = errorMessage(err).slice(0, 400);
    log.warn(`Top list "${row.topic}" failed: ${message}`);
    run(`UPDATE top_list_suggestions SET status = 'failed', error = ? WHERE id = ?`, message, id);
  }
}

/* -- The page -------------------------------------------------------------- */

const CSS = `
.tl-form { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-bottom: 24px; }
.tl-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; color: var(--soft); }
.tl-form select, .tl-form input { height: 40px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--surface); color: var(--ink); font: inherit; }
.tl-form input { width: 90px; }
.tl-table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); }
.tl-table th, .tl-table td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
.tl-table th { color: var(--faint); font-size: 13px; font-weight: 600; }
.tl-table form { margin: 0; display: inline; }
.tl-table details summary { cursor: pointer; color: var(--idle-ink); font-weight: 600; }
.tl-table ul { margin: 6px 0 0; padding-left: 18px; font-size: 14px; }
.tl-acts { display: flex; gap: 6px; }
.tl-err { color: var(--bad); font-size: 13px; margin-top: 4px; }
`;

const back = (siteId: number, kind: 'ok' | 'error', message: string): string =>
  `/new-website/top-lists?site=${siteId}&${kind}=${encodeURIComponent(message)}`;

export function registerTopListRoutes(app: FastifyInstance, deps: TopListDeps): void {
  ensureTables();
  // A restart mid-write: it is written again.
  run(`UPDATE top_list_suggestions SET status = 'failed', error = 'Stopped by a restart.' WHERE status = 'writing'`);

  app.get('/new-website/top-lists', async (request, reply) => {
    const sites = listNewWebsites();
    const q = request.query as { site?: string };
    const site = sites.find((s) => s.id === Number(q.site)) ?? sites[0];
    const rows = site
      ? all<SuggestionRow>(
          `SELECT * FROM top_list_suggestions WHERE website_id = ?
            ORDER BY CASE status WHEN 'suggested' THEN 0 WHEN 'writing' THEN 1 WHEN 'failed' THEN 2 WHEN 'published' THEN 3 ELSE 4 END, id`,
          site.id,
        )
      : [];
    const badge = (s: SuggestionRow['status']) =>
      s === 'published'
        ? html`<span class="ns-badge ok">Published</span>`
        : s === 'failed'
          ? html`<span class="ns-badge bad">Failed</span>`
          : s === 'writing'
            ? html`<span class="ns-badge busy">Writing</span>`
            : s === 'rejected'
              ? html`<span class="ns-badge">Rejected</span>`
              : html`<span class="ns-badge">Suggested</span>`;
    const action = (r: SuggestionRow, path: string, label: string, cls = '') =>
      html`<form method="post" action="/new-website/top-lists/${String(r.id)}/${path}"><button class="ns-btn small ${cls}">${label}</button></form>`;

    const body = html`
      <style>${raw(CSS)}</style>
      <div class="ns-head"><div><h1 class="ns-title">Top lists</h1></div></div>
      ${site
        ? html`<form class="tl-form" method="post" action="/new-website/top-lists/scan">
            <label>Website<select name="site" onchange="location.href='/new-website/top-lists?site='+this.value">
              ${sites.map((s) => html`<option value="${String(s.id)}" ${raw(s.id === site.id ? 'selected' : '')}>${s.name}</option>`)}
            </select></label>
            <label>Posts at least<input type="number" name="min" min="2" max="100" value="5"></label>
            <button class="ns-btn primary">Scan posts</button>
          </form>
          <table class="tl-table">
            <thead><tr><th>Keyword</th><th>Posts</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${rows.length
                ? rows.map((r) => {
                    const list = JSON.parse(r.posts_json) as number[];
                    const names = (JSON.parse(r.titles_json ?? '[]') as string[]).slice(0, 50);
                    return html`<tr>
                      <td>${r.topic}${r.error ? html`<div class="tl-err">${r.error}</div>` : raw('')}</td>
                      <td>${names.length
                        ? html`<details><summary>${String(list.length)}</summary><ul>${names.map((n) => html`<li>${n}</li>`)}</ul></details>`
                        : String(list.length)}</td>
                      <td>${badge(r.status)}</td>
                      <td><div class="tl-acts">
                        ${r.status === 'suggested'
                          ? html`${action(r, 'approve', 'Approve', 'primary')}${action(r, 'reject', 'Reject')}`
                          : r.status === 'failed'
                            ? html`${action(r, 'approve', 'Try again')}${action(r, 'reject', 'Reject')}`
                            : r.status === 'rejected'
                              ? action(r, 'restore', 'Restore')
                              : r.status === 'published' && r.post_url
                                ? html`<a class="ns-btn small" href="${r.post_url}" target="_blank" rel="noopener">Open</a>`
                                : raw('')}
                      </div></td>
                    </tr>`;
                  })
                : html`<tr><td colspan="4">No suggestions yet.</td></tr>`}
            </tbody>
          </table>`
        : html`<p>Add a website first.</p>`}`;
    return reply
      .type('text/html; charset=utf-8')
      .send(newLayout({ title: 'Top lists', active: '/new-website/top-lists', body, flash: deps.readFlash(request.query) }));
  });

  app.post('/new-website/top-lists/scan', async (request, reply) => {
    const form = (request.body ?? {}) as { site?: string; min?: string };
    const site = getNewWebsite(Number(form.site) || 0);
    if (!site) return reply.redirect('/new-website/top-lists', 303);
    const min = Math.min(100, Math.max(2, Number(form.min) || 5));
    try {
      const posts = await readPosts(site, websiteApiKey(site, deps.encryptionKey), deps.fetchImpl);
      const byId = new Map(posts.map((p) => [p.id, p.title]));
      const topics = findTopics(posts, min);
      let added = 0;
      for (const t of topics) {
        const existing = get<SuggestionRow>('SELECT * FROM top_list_suggestions WHERE website_id = ? AND topic = ?', site.id, t.topic);
        const titles = JSON.stringify(t.postIds.map((id) => byId.get(id) ?? ''));
        if (!existing) {
          run(`INSERT INTO top_list_suggestions (website_id, topic, posts_json, titles_json) VALUES (?, ?, ?, ?)`, site.id, t.topic, JSON.stringify(t.postIds), titles);
          added += 1;
        } else if (existing.status === 'suggested' || existing.status === 'rejected') {
          run('UPDATE top_list_suggestions SET posts_json = ?, titles_json = ? WHERE id = ?', JSON.stringify(t.postIds), titles, existing.id);
        }
      }
      return reply.redirect(back(site.id, 'ok', `${posts.length} posts read, ${added} new suggestions.`), 303);
    } catch (err) {
      return reply.redirect(back(site.id, 'error', errorMessage(err)), 303);
    }
  });

  const suggestion = (request: { params: unknown }) =>
    get<SuggestionRow>('SELECT * FROM top_list_suggestions WHERE id = ?', Number((request.params as { id: string }).id) || 0);

  app.post('/new-website/top-lists/:id/approve', async (request, reply) => {
    const row = suggestion(request);
    if (!row) return reply.redirect('/new-website/top-lists', 303);
    if (row.status !== 'writing' && row.status !== 'published') void writeTopList(row.id, deps);
    return reply.redirect(back(row.website_id, 'ok', `Writing the top list for “${row.topic}”.`), 303);
  });

  app.post('/new-website/top-lists/:id/reject', async (request, reply) => {
    const row = suggestion(request);
    if (!row) return reply.redirect('/new-website/top-lists', 303);
    run(`UPDATE top_list_suggestions SET status = 'rejected', error = '' WHERE id = ? AND status IN ('suggested', 'failed')`, row.id);
    return reply.redirect(`/new-website/top-lists?site=${row.website_id}`, 303);
  });

  app.post('/new-website/top-lists/:id/restore', async (request, reply) => {
    const row = suggestion(request);
    if (!row) return reply.redirect('/new-website/top-lists', 303);
    run(`UPDATE top_list_suggestions SET status = 'suggested' WHERE id = ? AND status = 'rejected'`, row.id);
    return reply.redirect(`/new-website/top-lists?site=${row.website_id}`, 303);
  });
}
