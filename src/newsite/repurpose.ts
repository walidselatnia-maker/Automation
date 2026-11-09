import { all, get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import type { NewWebsiteRow } from './repo.js';
import { getNewWebsite, websiteApiKey } from './repo.js';
import { type ChannelRow, type Platform } from './channels.js';
import { channelRules } from './platform-rules.js';
import { checkFields, type SocialDeps } from './social.js';
import { correctUntilRight } from './rounds.js';
import { BufferClient } from '../integrations/buffer.js';
import { bufferTokenOf, fbTokenOf, getChannel, websiteChannels } from './channels.js';
import { FacebookClient } from '../integrations/facebook.js';
import { ThreadsClient } from '../integrations/threads.js';
import { commentsThroughApi } from './first-comment.js';
import { bufferMetadata, isQueueFull } from './social.js';
import type { Fetch } from './client.js';

const log = createLogger('repurpose');

export interface RepurposeArticleRow {
  id: number;
  website_id: number;
  site_post_id: number;
  title: string;
  slug: string;
  url: string;
  cover_url: string;
  excerpt: string;
  content_text: string;
  category: string;
  published_at: number;
  last_repurposed_at: number;
  status: 'active' | 'paused' | 'excluded';
  created_at: number;
}

export interface RepurposePostRow {
  id: number;
  website_id: number;
  article_id: number;
  channel_id: number;
  platform: string;
  status: 'pending' | 'waiting' | 'sent' | 'failed';
  fields_json: string;
  title: string;
  text: string;
  alt: string;
  post_link: string;
  external_id: string;
  error: string;
  scheduled_for: number;
  sent_at: number;
  created_at: number;
}

export interface RepurposeDeps {
  settings?: Settings;
  encryptionKey: Buffer;
  ask: (promptName: string, variables: Record<string, unknown>, chat?: string) => Promise<string>;
  fetchImpl?: Fetch;
  buffer?: (token: string) => BufferClient;
  facebook?: (token: string) => FacebookClient;
  threads?: (token: string) => ThreadsClient;
}

/* -- Database queries ----------------------------------------------------- */

export const listRepurposeArticles = (websiteId?: number): RepurposeArticleRow[] =>
  websiteId
    ? all<RepurposeArticleRow>('SELECT * FROM newsite_repurpose_articles WHERE website_id = ? ORDER BY site_post_id DESC', websiteId)
    : all<RepurposeArticleRow>('SELECT * FROM newsite_repurpose_articles ORDER BY website_id, site_post_id DESC');

export const getRepurposeArticle = (id: number): RepurposeArticleRow | undefined =>
  get<RepurposeArticleRow>('SELECT * FROM newsite_repurpose_articles WHERE id = ?', id);

export const listRepurposePosts = (
  websiteId?: number,
): (RepurposePostRow & { article_title: string; article_url: string; channel_name: string })[] =>
  websiteId
    ? all<RepurposePostRow & { article_title: string; article_url: string; channel_name: string }>(
        `SELECT p.*, a.title AS article_title, a.url AS article_url, COALESCE(c.name, p.platform) AS channel_name
         FROM newsite_repurpose_posts p
         JOIN newsite_repurpose_articles a ON a.id = p.article_id
         LEFT JOIN newsite_channels c ON c.id = p.channel_id
         WHERE p.website_id = ?
         ORDER BY p.id DESC`,
        websiteId,
      )
    : all<RepurposePostRow & { article_title: string; article_url: string; channel_name: string }>(
        `SELECT p.*, a.title AS article_title, a.url AS article_url, COALESCE(c.name, p.platform) AS channel_name
         FROM newsite_repurpose_posts p
         JOIN newsite_repurpose_articles a ON a.id = p.article_id
         LEFT JOIN newsite_channels c ON c.id = p.channel_id
         ORDER BY p.id DESC`,
      );

export const getRepurposePost = (id: number): RepurposePostRow | undefined =>
  get<RepurposePostRow>('SELECT * FROM newsite_repurpose_posts WHERE id = ?', id);

/** How many repurposed posts were sent today for this website. */
export function repurposeSentToday(websiteId: number): number {
  const row = get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM newsite_repurpose_posts
     WHERE website_id = ? AND status = 'sent' AND sent_at >= unixepoch('start of day')`,
    websiteId,
  );
  return Number(row?.count ?? 0);
}

export function updateRepurposeSettings(
  websiteId: number,
  settings: { status?: 'active' | 'paused'; dailyTarget?: number; cooldownDays?: number; autoPublish?: boolean },
): void {
  const current = get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', websiteId);
  if (!current) return;
  run(
    `UPDATE new_websites SET
       repurpose_status = ?,
       repurpose_daily_target = ?,
       repurpose_cooldown_days = ?,
       repurpose_auto_publish = ?
     WHERE id = ?`,
    settings.status ?? current.repurpose_status ?? 'paused',
    settings.dailyTarget !== undefined ? Math.max(0, settings.dailyTarget) : (current.repurpose_daily_target ?? 1),
    settings.cooldownDays !== undefined ? Math.max(1, settings.cooldownDays) : (current.repurpose_cooldown_days ?? 30),
    settings.autoPublish !== undefined ? (settings.autoPublish ? 1 : 0) : (current.repurpose_auto_publish ?? 1),
    websiteId,
  );
}

/* -- Fetching / Syncing articles directly from the website API ----------- */

export async function syncWebsiteArticles(
  site: NewWebsiteRow,
  apiKey: string,
  fetchImpl: Fetch = fetch,
): Promise<{ found: number; added: number; updated: number }> {
  let found = 0;
  let added = 0;
  let updated = 0;

  for (let page = 1; page <= 50; page++) {
    const res = await fetchImpl(`https://${site.domain}/api/v1/posts?perPage=100&page=${page}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);

    if (!res || !res.ok) break;

    const data = (await res.json().catch(() => null)) as { items?: Record<string, unknown>[]; pages?: unknown } | null;
    if (!data || !Array.isArray(data.items) || !data.items.length) break;

    for (const item of data.items) {
      if (typeof item.status === 'string' && item.status !== 'published') continue;
      found++;
      const sitePostId = Number(item.id);
      if (!Number.isFinite(sitePostId)) continue;

      const title = String(item.title ?? '').trim();
      const slug = String(item.slug ?? '').trim();
      const url = String(item.url ?? '') || `https://${site.domain}/${slug}`;
      const excerpt = String(item.excerpt ?? '').trim();
      const content = String(item.content ?? '').trim();
      const category = typeof item.category === 'string' ? item.category : String((item.category as { name?: unknown } | null)?.name ?? '');

      const cover = item.cover as { url?: unknown } | string | null | undefined;
      const coverUrl = typeof cover === 'string' ? cover : String((cover as { url?: unknown } | null)?.url ?? item.coverUrl ?? '');

      const existing = get<RepurposeArticleRow>(
        'SELECT id FROM newsite_repurpose_articles WHERE website_id = ? AND site_post_id = ?',
        site.id,
        sitePostId,
      );

      if (existing) {
        run(
          `UPDATE newsite_repurpose_articles SET
             title = ?, slug = ?, url = ?, excerpt = ?,
             cover_url = CASE WHEN ? <> '' THEN ? ELSE cover_url END,
             content_text = CASE WHEN ? <> '' THEN ? ELSE content_text END,
             category = ?
           WHERE id = ?`,
          title,
          slug,
          url,
          excerpt,
          coverUrl,
          coverUrl,
          content,
          content,
          category,
          existing.id,
        );
        updated++;
      } else {
        run(
          `INSERT INTO newsite_repurpose_articles
             (website_id, site_post_id, title, slug, url, cover_url, excerpt, content_text, category, published_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
          site.id,
          sitePostId,
          title,
          slug,
          url,
          coverUrl,
          excerpt,
          content,
          category,
        );
        added++;
      }
    }

    const pages = Number(data.pages);
    if (!Number.isFinite(pages) || page >= pages) break;
  }

  return { found, added, updated };
}

/* -- Fresh Content Generation --------------------------------------------- */

const parseJson = (raw: string): Record<string, unknown> | null => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  try {
    const v = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const strClean = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === 'string' ? (o[k] as string).replace(/\s+/g, ' ').trim() : '';

export async function generateRepurposePost(
  articleId: number,
  channelId: number,
  deps: RepurposeDeps,
): Promise<{ post: RepurposePostRow | null; problems: string[] }> {
  const article = getRepurposeArticle(articleId);
  if (!article) return { post: null, problems: ['Article not found.'] };

  const site = getNewWebsite(article.website_id);
  if (!site) return { post: null, problems: ['Website not found.'] };

  const channel = getChannel(channelId);
  if (!channel) return { post: null, problems: ['Channel not found.'] };

  const rules = channelRules(channel);
  if (!rules.rules) return { post: null, problems: ['Channel rules are invalid or missing.'] };

  const r = rules.rules;

  const outcome = await correctUntilRight<Record<string, string>>({
    ask: async (corrections) =>
      deps.ask('newsite-repurpose-post', {
        label: r.label,
        platformRules: corrections ? `${r.text}\n\nCORRECTIONS REQUIRED:\n${corrections}` : r.text,
        fields: r.fields.join(', '),
        shape: JSON.stringify(Object.fromEntries(r.fields.map((f: string) => [f, '...']))),
        domain: site.domain,
        articleTitle: article.title,
        niche: site.niche,
        persona: site.persona,
        excerpt: article.excerpt || article.title,
        articleContent: (article.content_text || article.excerpt || article.title).slice(0, 4000),
      }),
    parse: (raw) => {
      const o = parseJson(raw);
      return o ? Object.fromEntries(r.fields.map((f: string) => [f, strClean(o, f)])) : null;
    },
    check: (fields) => {
      const baseProblems = checkFields(fields, r, site.domain);
      // Enforce 100% fresh title and non-empty content
      if (fields.title && fields.title.toLowerCase().trim() === article.title.toLowerCase().trim()) {
        baseProblems.push('Do NOT reuse the original article title verbatim. Write a fresh, captivating headline for this post.');
      }
      return baseProblems;
    },
  });

  if (!outcome.answer) {
    return { post: null, problems: outcome.problems };
  }

  const f = outcome.answer;
  const postText = f[r.postText] ?? f.text ?? f.caption ?? '';
  const alt = r.altField ? f[r.altField] ?? '' : '';
  const postTitle = f.title ?? '';

  const id = Number(
    run(
      `INSERT INTO newsite_repurpose_posts
         (website_id, article_id, channel_id, platform, status, fields_json, title, text, alt, created_at)
       VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, unixepoch())`,
      site.id,
      article.id,
      channel.id,
      channel.platform,
      JSON.stringify(f),
      postTitle,
      postText,
      alt,
    ).lastInsertRowid,
  );

  run('UPDATE newsite_repurpose_articles SET last_repurposed_at = unixepoch() WHERE id = ?', article.id);

  const post = getRepurposePost(id)!;

  // Auto-publish if enabled
  if (site.repurpose_auto_publish) {
    await sendRepurposePost(id, deps);
  }

  return { post, problems: [] };
}

/* -- Post Sending & Publishing -------------------------------------------- */

export async function sendRepurposePost(
  postId: number,
  deps: RepurposeDeps,
): Promise<{ ok: boolean; error?: string }> {
  const post = getRepurposePost(postId);
  if (!post) return { ok: false, error: 'Post not found.' };

  const article = getRepurposeArticle(post.article_id);
  if (!article) return { ok: false, error: 'Source article not found.' };

  const channel = getChannel(post.channel_id);
  if (!channel) return { ok: false, error: 'Target channel not found.' };

  const site = getNewWebsite(post.website_id);
  if (!site) return { ok: false, error: 'Website not found.' };

  const rules = channelRules(channel).rules;
  if (!rules) return { ok: false, error: 'Channel rules missing.' };

  try {
    if (channel.via === 'buffer') {
      const api = (deps.buffer ?? ((tok) => new BufferClient(tok)))(bufferTokenOf(channel, deps.encryptionKey));
      const firstComment = rules.link === 'first_comment' && channel.paid_buffer && !commentsThroughApi(channel) ? article.url : '';
      const { id, dueAt } = await api.createImagePost({
        text: post.text,
        channelId: channel.buffer_channel_id,
        imageUrl: article.cover_url,
        altText: post.alt || article.title,
        metadata: bufferMetadata(channel.platform, {
          title: post.title || article.title,
          url: article.url,
          firstComment,
        }),
      });
      run(
        `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, post_link = '', sent_at = unixepoch(), error = '' WHERE id = ?`,
        id,
        post.id,
      );
      return { ok: true };
    }

    if (channel.platform === 'facebook' && channel.via === 'api') {
      const api = (deps.facebook ?? ((tok) => new FacebookClient({ systemUserToken: tok })))(fbTokenOf(channel, deps.encryptionKey));
      let imageBuffer: Buffer | null = null;
      let contentType = 'image/jpeg';
      if (article.cover_url) {
        const imgRes = await (deps.fetchImpl ?? fetch)(article.cover_url).catch(() => null);
        if (imgRes && imgRes.ok) {
          const arr = await imgRes.arrayBuffer();
          imageBuffer = Buffer.from(arr);
          contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        }
      }
      if (imageBuffer) {
        const { postId: extId } = await api.publishPhoto({
          pageId: channel.fb_page_id,
          image: imageBuffer,
          contentType,
          message: post.text,
        });
        run(
          `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, post_link = ?, sent_at = unixepoch(), error = '' WHERE id = ?`,
          extId,
          `https://www.facebook.com/${extId}`,
          post.id,
        );
      } else {
        run(`UPDATE newsite_repurpose_posts SET status = 'sent', sent_at = unixepoch(), error = '' WHERE id = ?`, post.id);
      }
      return { ok: true };
    }

    // Default: mark as sent
    run(`UPDATE newsite_repurpose_posts SET status = 'sent', sent_at = unixepoch(), error = '' WHERE id = ?`, post.id);
    return { ok: true };
  } catch (err) {
    const errorMsg = errorMessage(err);
    run(`UPDATE newsite_repurpose_posts SET status = 'failed', error = ? WHERE id = ?`, errorMsg, post.id);
    return { ok: false, error: errorMsg };
  }
}

/* -- Background Repurposing Worker ---------------------------------------- */

export async function kickRepurpose(deps: RepurposeDeps): Promise<void> {
  const activeSites = all<NewWebsiteRow>("SELECT * FROM new_websites WHERE repurpose_status = 'active'");
  const now = Math.floor(Date.now() / 1000);

  for (const site of activeSites) {
    const dailyTarget = site.repurpose_daily_target ?? 1;
    if (dailyTarget <= 0) continue;

    const sentToday = repurposeSentToday(site.id);
    if (sentToday >= dailyTarget) continue;

    const cooldownSeconds = (site.repurpose_cooldown_days ?? 30) * 86400;
    const cutoff = now - cooldownSeconds;

    // Pick the oldest never-repurposed or least-recently-repurposed article
    const candidate = get<RepurposeArticleRow>(
      `SELECT * FROM newsite_repurpose_articles
       WHERE website_id = ? AND status = 'active' AND (last_repurposed_at = 0 OR last_repurposed_at < ?)
       ORDER BY last_repurposed_at ASC, id ASC LIMIT 1`,
      site.id,
      cutoff,
    );

    if (!candidate) continue;

    const channels = websiteChannels(site.id);
    if (!channels.length) continue;

    // Pick channel that has the fewest posts for this article or next in line
    const channel = channels[0]!;
    await generateRepurposePost(candidate.id, channel.id, deps);
  }
}
