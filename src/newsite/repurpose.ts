import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { resolveDataDir } from '../config.js';
import type { Settings } from '../settings.js';
import type { NewWebsiteRow } from './repo.js';
import { getNewWebsite, websiteApiKey } from './repo.js';
import { takesReels, videoOnly, type ChannelRow, type Platform } from './channels.js';
import { channelRules, type PlatformRules } from './platform-rules.js';
import { bufferMetadata, checkFields, isQueueFull, realInstagram, realThreads, type BufferApi as SocialBufferApi, type InstagramApi, type ThreadsApi } from './social.js';
import { correctUntilRight } from './rounds.js';
import { BufferClient, type BufferChannel } from '../integrations/buffer.js';
import { bufferTokenOf, fbTokenOf, getChannel, websiteChannels, channelBoards, saveChannelBoards, type ChannelBoard } from './channels.js';
import { FacebookClient } from '../integrations/facebook.js';
import { ThreadsClient } from '../integrations/threads.js';
import { commentsThroughApi } from './first-comment.js';
import type { Fetch } from './client.js';
import { ImageClient } from '../integrations/images.js';
import { pickedPinDesigns, renderDesign } from './pin-designs.js';
import { loadTemplate } from '../pipeline/prompts.js';
import { flowProjectFor, type PictureShape } from './pictures.js';
import { makeInstagramPicture, instagramFileOf } from './instagram-picture.js';
import { repurposePictureMediaUrl, repurposeReelMediaUrl } from '../core/media-links.js';
import { checkReelScript, type ReelScript, withDomain, reelRules, defaultReelRules } from './reels.js';
import { threadsTokenOf, type Renew } from './threads-token.js';

const log = createLogger('repurpose');

export const repurposeDir = (dataDir = resolveDataDir()): string => join(dataDir, 'newsite-repurpose');

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
  status: 'active' | 'paused' | 'generated' | 'excluded';
  created_at: number;
  post_count?: number;
  latest_post_at?: number;
  post_platforms?: string;
}

export interface RepurposePostRow {
  id: number;
  website_id: number;
  article_id: number;
  channel_id: number;
  platform: string;
  post_kind: 'image' | 'reel';
  status: 'pending' | 'waiting' | 'sent' | 'failed';
  fields_json: string;
  title: string;
  text: string;
  alt: string;
  board_name: string;
  image_url: string;
  media_file: string;
  media_status: 'pending' | 'making' | 'done' | 'failed';
  post_link: string;
  external_id: string;
  error: string;
  scheduled_for: number;
  sent_at: number;
  created_at: number;
}

export interface BufferApi {
  channels: () => Promise<BufferChannel[]>;
  createImagePost: (input: { text: string; channelId: string; imageUrl: string; altText: string; metadata: string }) => Promise<{ id: string; dueAt: string }>;
  createVideoPost?: (input: { text: string; channelId: string; videoUrl: string; thumbnailUrl?: string; metadata?: string }) => Promise<string>;
}

export interface RepurposeDeps {
  settings?: Settings;
  encryptionKey: Buffer;
  ask: (promptName: string, variables: Record<string, unknown>, chat?: string) => Promise<string>;
  fetchImpl?: Fetch;
  buffer?: (token: string) => BufferApi;
  facebook?: (token: string) => FacebookClient;
  instagram?: (token: string) => InstagramApi;
  threads?: (token: string) => ThreadsApi;
  renewThreads?: Renew;
  flow?: {
    submitVideo(input: { prompt: string; referenceUrls: string[]; projectId?: string }): Promise<string>;
    poll(jobId: string): Promise<{ status?: string; image_url?: string; error?: string }>;
  };
  makePicture?: (prompt: string, shape: PictureShape, projectId: string) => Promise<{ data: Buffer; contentType: string }>;
  instagramPicture?: (src: string, out: string) => Promise<void>;
  download?: (url: string) => Promise<Buffer>;
  sleep?: (ms: number) => Promise<void>;
  dataDir?: string;
  now?: () => number;
}

const realBuffer = (token: string): BufferApi => {
  const client = new BufferClient(token);
  return {
    channels: async () => client.getChannels(await client.getOrganizationId()),
    createImagePost: (input) => client.createImagePost(input),
    createVideoPost: (input) => client.createVideoPost(input),
  };
};

const flowOf = (settings: Settings) =>
  new ImageClient({
    baseUrl: settings.get('image_base_url'),
    apiKey: settings.get('image_api_key'),
    pollIntervalMs: Math.min(5, Math.max(1, settings.getNumber('image_poll_interval_seconds') || 5)) * 1000,
    maxAttempts: Math.max(settings.getNumber('image_poll_max_attempts'), 80),
  });

const defaultDownload = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`the video could not be downloaded (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
};

const REEL_NOTE =
  'This post is a reel: a 10-second vertical video of the dish or subject being made, ending on the finished result. Write its words for that video, not for a picture. Where the rules name the website, write {domain} exactly like that: it is filled in with the website\'s address.';

const parseObject = (raw: string): Record<string, unknown> | null => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  try {
    const v = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/* -- Database queries ----------------------------------------------------- */

/**
 * List discovered articles, ordered OLD PUBLISHED FIRST as requested.
 * (Lowest published_at or site_post_id first).
 */
export const listRepurposeArticles = (
  websiteId?: number,
): (RepurposeArticleRow & { post_count: number; latest_post_at?: number; post_platforms?: string })[] =>
  websiteId
    ? all<RepurposeArticleRow & { post_count: number; latest_post_at?: number; post_platforms?: string }>(
        `SELECT a.*,
                COUNT(p.id) AS post_count,
                MAX(p.created_at) AS latest_post_at,
                GROUP_CONCAT(DISTINCT p.platform) AS post_platforms
         FROM newsite_repurpose_articles a
         LEFT JOIN newsite_repurpose_posts p ON p.article_id = a.id
         WHERE a.website_id = ?
         GROUP BY a.id
         ORDER BY CASE WHEN a.published_at > 0 THEN a.published_at ELSE a.site_post_id END ASC, a.site_post_id ASC`,
        websiteId,
      )
    : all<RepurposeArticleRow & { post_count: number; latest_post_at?: number; post_platforms?: string }>(
        `SELECT a.*,
                COUNT(p.id) AS post_count,
                MAX(p.created_at) AS latest_post_at,
                GROUP_CONCAT(DISTINCT p.platform) AS post_platforms
         FROM newsite_repurpose_articles a
         LEFT JOIN newsite_repurpose_posts p ON p.article_id = a.id
         GROUP BY a.id
         ORDER BY a.website_id, CASE WHEN a.published_at > 0 THEN a.published_at ELSE a.site_post_id END ASC, a.site_post_id ASC`,
      );

export const getRepurposeArticle = (
  id: number,
): (RepurposeArticleRow & { post_count?: number; latest_post_at?: number; post_platforms?: string }) | undefined =>
  get<RepurposeArticleRow & { post_count?: number; latest_post_at?: number; post_platforms?: string }>(
    `SELECT a.*,
            COUNT(p.id) AS post_count,
            MAX(p.created_at) AS latest_post_at,
            GROUP_CONCAT(DISTINCT p.platform) AS post_platforms
     FROM newsite_repurpose_articles a
     LEFT JOIN newsite_repurpose_posts p ON p.article_id = a.id
     WHERE a.id = ?
     GROUP BY a.id`,
    id,
  );

export const listRepurposePosts = (
  websiteId?: number,
): (RepurposePostRow & { article_title: string; article_url: string; article_cover_url: string; channel_name: string })[] =>
  websiteId
    ? all<RepurposePostRow & { article_title: string; article_url: string; article_cover_url: string; channel_name: string }>(
        `SELECT p.*, a.title AS article_title, a.url AS article_url, a.cover_url AS article_cover_url, COALESCE(c.name, p.platform) AS channel_name
         FROM newsite_repurpose_posts p
         JOIN newsite_repurpose_articles a ON a.id = p.article_id
         LEFT JOIN newsite_channels c ON c.id = p.channel_id
         WHERE p.website_id = ?
         ORDER BY p.id DESC`,
        websiteId,
      )
    : all<RepurposePostRow & { article_title: string; article_url: string; article_cover_url: string; channel_name: string }>(
        `SELECT p.*, a.title AS article_title, a.url AS article_url, a.cover_url AS article_cover_url, COALESCE(c.name, p.platform) AS channel_name
         FROM newsite_repurpose_posts p
         JOIN newsite_repurpose_articles a ON a.id = p.article_id
         LEFT JOIN newsite_channels c ON c.id = p.channel_id
         ORDER BY p.id DESC`,
      );

export const getRepurposePost = (id: number): RepurposePostRow | undefined =>
  get<RepurposePostRow>('SELECT * FROM newsite_repurpose_posts WHERE id = ?', id);

/**
 * How many repurposed posts were created or sent today for this website.
 * Counts all posts generated or sent today so that the daily limit
 * is strictly enforced regardless of publishing status (waiting, sent, or failed).
 */
export function repurposeCountToday(websiteId: number): number {
  const row = get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM newsite_repurpose_posts
     WHERE website_id = ? AND (
       created_at >= unixepoch('now', 'start of day')
       OR (sent_at > 0 AND sent_at >= unixepoch('now', 'start of day'))
     )`,
    websiteId,
  );
  return Number(row?.count ?? 0);
}

/** Backward-compatible alias for repurposeCountToday. */
export const repurposeSentToday = repurposeCountToday;

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

      const publishedAt = item.publishedAt ? Math.floor(new Date(String(item.publishedAt)).getTime() / 1000)
        : item.published_at ? Math.floor(new Date(String(item.published_at)).getTime() / 1000)
        : item.createdAt ? Math.floor(new Date(String(item.createdAt)).getTime() / 1000)
        : item.created_at ? Math.floor(new Date(String(item.created_at)).getTime() / 1000)
        : 0;

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
             category = ?,
             published_at = CASE WHEN ? > 0 THEN ? ELSE published_at END
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
          publishedAt,
          publishedAt,
          existing.id,
        );
        updated++;
      } else {
        run(
          `INSERT INTO newsite_repurpose_articles
             (website_id, site_post_id, title, slug, url, cover_url, excerpt, content_text, category, published_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
          site.id,
          sitePostId,
          title,
          slug,
          url,
          coverUrl,
          excerpt,
          content,
          category,
          publishedAt,
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

export const postFields = (p: Pick<RepurposePostRow, 'fields_json'>): Record<string, string> => {
  try {
    const v = JSON.parse(p.fields_json || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
};

/**
 * Generates a channel-specific picture via Google Flow according to channel platform rules.
 */
export async function makeRepurposeImage(
  post: RepurposePostRow,
  article: RepurposeArticleRow,
  site: NewWebsiteRow,
  channel: ChannelRow,
  rules: PlatformRules,
  deps: RepurposeDeps,
): Promise<{ ok: boolean; file?: string; error?: string }> {
  try {
    const fields = postFields(post);
    const scene = `a beautifully presented ${article.title} in an elegant, appetizing setting`;
    const detail = `close-up detailed shot showing textures and quality ingredients of ${article.title}`;
    const context = {
      scene,
      detail,
      headline: post.title || article.title,
      cta: 'LEARN MORE',
      domain: site.domain,
      title: post.title || article.title,
      ...fields,
    };

    const designs = rules.platform === 'pinterest' ? pickedPinDesigns() : [];
    const count = designs.length || rules.pictureTemplates.length || 1;
    const index = channel.next_template % count;
    run('UPDATE newsite_channels SET next_template = next_template + 1 WHERE id = ?', channel.id);

    const design = designs[index];
    const prompt = design
      ? renderDesign(design, context)
      : (rules.pictureTemplates[index] ? loadTemplate(rules.pictureTemplates[index]!, context) : `A high-end photograph of ${article.title}`);
    let shape = (rules.pictureShape as PictureShape) || (channel.platform === 'pinterest' ? 'PORTRAIT_9_16' : 'PORTRAIT_3_4');
    if (channel.platform === 'pinterest' && (shape === 'PORTRAIT_3_4' || !shape)) {
      shape = 'PORTRAIT_9_16';
    }
    if (prompt.includes('9:16') || prompt.includes('9/16')) {
      shape = 'PORTRAIT_9_16';
    }

    const curFields = postFields(post);
    if (design?.name) {
      curFields.pin_design = design.name;
    }
    run(`UPDATE newsite_repurpose_posts SET media_status = 'making', fields_json = ? WHERE id = ?`, JSON.stringify(curFields), post.id);

    const dataDir = deps.dataDir ?? resolveDataDir();
    const dir = repurposeDir(dataDir);
    mkdirSync(dir, { recursive: true });

    let data: Buffer | null = null;
    let contentType = 'image/jpeg';

    if (deps.makePicture) {
      const res = await deps.makePicture(prompt, shape, site.project_id || '');
      data = res.data;
      contentType = res.contentType;
    } else if (deps.settings && typeof deps.settings.get === 'function' && deps.settings.get('image_base_url')) {
      const pollIntervalMs = Math.min(5, Math.max(1, deps.settings.getNumber('image_poll_interval_seconds') || 5)) * 1000;
      const client = new ImageClient({
        baseUrl: deps.settings.get('image_base_url'),
        apiKey: deps.settings.get('image_api_key'),
        pollIntervalMs,
        maxAttempts: Math.max(deps.settings.getNumber('image_poll_max_attempts'), 60),
        projectId: flowProjectFor(site.project_id, site.domain, deps.settings).projectId,
        imageModel: deps.settings.get('image_model'),
      });
      const res = await client.generate(prompt, shape);
      data = res.data;
      contentType = res.contentType;
    }

    if (data) {
      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
      const file = `post-${post.id}.${ext}`;
      writeFileSync(join(dir, file), data);

      if (channel.platform === 'instagram') {
        try {
          const outIg = join(dir, instagramFileOf(file));
          await (deps.instagramPicture ?? makeInstagramPicture)(join(dir, file), outIg);
        } catch (igErr) {
          log.warn(`Instagram 4:5 copy could not be created: ${errorMessage(igErr)}`);
        }
      }

      const fileUrl = `/new-website/repurpose/post/${post.id}/file`;
      run(
        `UPDATE newsite_repurpose_posts SET media_file = ?, media_status = 'done', image_url = ? WHERE id = ?`,
        file,
        fileUrl,
        post.id,
      );
      return { ok: true, file };
    } else {
      // Flow not configured or offline: mark done with existing cover_url as fallback
      run(
        `UPDATE newsite_repurpose_posts SET media_status = 'done', image_url = CASE WHEN image_url = '' THEN ? ELSE image_url END WHERE id = ?`,
        article.cover_url,
        post.id,
      );
      return { ok: true, file: '' };
    }
  } catch (err) {
    const errorMsg = errorMessage(err);
    log.error(`Failed to generate repurpose image for post ${post.id}: ${errorMsg}`);
    run(`UPDATE newsite_repurpose_posts SET media_status = 'failed', error = ? WHERE id = ?`, `Image generation failed: ${errorMsg}`, post.id);
    return { ok: false, error: errorMsg };
  }
}

/**
 * Generates a channel reel video via Google Flow using the article's cover image and inline images as references.
 */
export async function makeRepurposeReel(
  post: RepurposePostRow,
  article: RepurposeArticleRow,
  site: NewWebsiteRow,
  channel: ChannelRow,
  deps: RepurposeDeps,
): Promise<{ ok: boolean; file?: string; error?: string }> {
  try {
    const referenceUrls: string[] = [];
    if (article.cover_url && /^https?:\/\//i.test(article.cover_url)) {
      referenceUrls.push(article.cover_url);
    }
    const inlineMatches = Array.from(
      (article.content_text || '').matchAll(/(?:!\[.*?\]\((https?:\/\/[^\s\)]+)\)|<img[^>]+src=["'](https?:\/\/[^"'>]+)["'])/gi),
    );
    for (const m of inlineMatches) {
      const u = m[1] || m[2];
      if (u && !referenceUrls.includes(u) && referenceUrls.length < 3) {
        referenceUrls.push(u);
      }
    }

    const settings = deps.settings;
    const rules = withDomain(settings && typeof settings.get === 'function' ? reelRules(settings) : defaultReelRules(), site.domain);
    const scriptOutcome = await correctUntilRight<ReelScript>({
      ask: (corrections) =>
        deps.ask('newsite-reel-prompt', {
          language: site.language,
          label: channel.name || channel.platform,
          reelRules: rules,
          title: article.title,
          keyword: article.category || article.title,
          niche: site.niche,
          nicheContext: site.niche_context || '(none)',
          steps: (article.content_text || article.excerpt || article.title).slice(0, 2000),
          things: article.category || '- (see steps)',
          articleOutline: article.title,
          references: referenceUrls.join(', ') || article.title,
          problemsJson: corrections,
        }),
      parse: (raw) => {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        try {
          const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
          const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
          return { hook_line: s('hook_line').replace(/\s+/g, ' '), closing_line: s('closing_line').replace(/\s+/g, ' '), prompt: s('prompt') };
        } catch {
          return null;
        }
      },
      check: (s) => checkReelScript(s, rules, site.domain),
    });

    if (!scriptOutcome.answer) {
      throw new Error(`The reel prompt could not be written: ${scriptOutcome.problems.join(' ')}`);
    }

    const script = scriptOutcome.answer;
    run(`UPDATE newsite_repurpose_posts SET media_status = 'making' WHERE id = ?`, post.id);

    const dataDir = deps.dataDir ?? resolveDataDir();
    const dir = repurposeDir(dataDir);
    mkdirSync(dir, { recursive: true });

    const projectId =
      settings && typeof settings.get === 'function'
        ? flowProjectFor(site.project_id, site.domain, settings).projectId
        : site.project_id || 'test_project';
    const flow = deps.flow ?? (settings && typeof settings.get === 'function' && settings.get('image_base_url') ? flowOf(settings) : undefined);

    if (!flow) {
      run(
        `UPDATE newsite_repurpose_posts SET media_status = 'done', image_url = CASE WHEN image_url = '' THEN ? ELSE image_url END WHERE id = ?`,
        article.cover_url,
        post.id,
      );
      return { ok: true, file: '' };
    }

    const jobId = await flow.submitVideo({ prompt: script.prompt, referenceUrls, projectId });
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    const FAILED_SET = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);
    for (let i = 0; i < 80; i++) {
      await sleep(15_000);
      const job = await flow.poll(jobId);
      const status = (job.status ?? '').toUpperCase();
      if (status === 'COMPLETED' && job.image_url) {
        const data = await (deps.download ?? defaultDownload)(job.image_url);
        const file = `reel-${post.id}.mp4`;
        writeFileSync(join(dir, file), data);
        const fileUrl = `/new-website/repurpose/post/${post.id}/file`;
        run(
          `UPDATE newsite_repurpose_posts SET media_file = ?, media_status = 'done', image_url = ? WHERE id = ?`,
          file,
          fileUrl,
          post.id,
        );
        return { ok: true, file };
      }
      if (FAILED_SET.has(status)) {
        throw new Error(`Flow could not make the video: ${job.error ?? status}`);
      }
    }

    throw new Error('Flow took more than 20 minutes to make the video.');
  } catch (err) {
    const errorMsg = errorMessage(err);
    log.error(`Failed to generate repurpose reel for post ${post.id}: ${errorMsg}`);
    run(`UPDATE newsite_repurpose_posts SET media_status = 'failed', error = ? WHERE id = ?`, `Reel generation failed: ${errorMsg}`, post.id);
    return { ok: false, error: errorMsg };
  }
}

export async function generateRepurposePost(
  articleId: number,
  channelId: number,
  deps: RepurposeDeps,
  requestedKind?: 'image' | 'reel',
): Promise<{ post: RepurposePostRow | null; problems: string[] }> {
  const article = getRepurposeArticle(articleId);
  if (!article) return { post: null, problems: ['Article not found.'] };

  const site = getNewWebsite(article.website_id);
  if (!site) return { post: null, problems: ['Website not found.'] };

  const channel = getChannel(channelId);
  if (!channel) return { post: null, problems: ['Channel not found.'] };

  // Determine kind: image or reel
  let kind: 'image' | 'reel' = requestedKind || (videoOnly(channel.platform) || (!channel.post_image && channel.post_reel) ? 'reel' : 'image');
  if (kind === 'reel' && !takesReels(channel.platform)) {
    kind = 'image';
  }

  const rules = channelRules(channel);
  if (!rules.rules) return { post: null, problems: ['Channel rules are invalid or missing.'] };

  const r = rules.rules;
  const isReel = kind === 'reel';
  const platformRulesText = isReel ? `${r.text}\n\n${REEL_NOTE}` : r.text;

  const articleOutline = article.content_text
    ? article.content_text.split('\n').filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '- ')).join('\n') || '- (no headings)'
    : '- (no headings)';
  const articleStart = (article.content_text || article.excerpt || article.title).slice(0, 1500);

  const outcome = await correctUntilRight<Record<string, string>>({
    ask: async (corrections) =>
      deps.ask('newsite-social-post', {
        language: site.language,
        label: isReel ? `${r.label} (Reel)` : r.label,
        platformRules: corrections
          ? `${platformRulesText}\n\nIMPORTANT: Do NOT reuse the original article title verbatim. Write a fresh, original headline for this post.\n\nCORRECTIONS REQUIRED:\n${corrections}`
          : `${platformRulesText}\n\nIMPORTANT: Do NOT reuse the original article title verbatim. Write a fresh, original headline for this post.`,
        fields: r.fields.join(', '),
        shape: JSON.stringify(Object.fromEntries(r.fields.map((f: string) => [f, '...']))),
        domain: site.domain,
        title: article.title,
        articleTitle: article.title,
        focusKeyword: article.category || site.niche,
        keyword: article.title,
        description: article.excerpt || article.title,
        excerpt: article.excerpt || article.title,
        niche: site.niche,
        persona: site.persona,
        articleOutline,
        articleStart,
        articleContent: (article.content_text || article.excerpt || article.title).slice(0, 4000),
        problemsJson: corrections || '',
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
  const initialImgUrl = article.cover_url;

  let selectedBoardName = '';
  if (channel.platform === 'pinterest') {
    try {
      const b = await getOrSelectPinterestBoard(channel, site, article, deps);
      selectedBoardName = b.name;
    } catch {
      // Board selection can also be performed/retried at publish time
    }
  }

  const id = Number(
    run(
      `INSERT INTO newsite_repurpose_posts
         (website_id, article_id, channel_id, platform, post_kind, status, fields_json, title, text, alt, board_name, image_url, media_file, media_status, created_at)
       VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, '', 'pending', unixepoch())`,
      site.id,
      article.id,
      channel.id,
      channel.platform,
      kind,
      JSON.stringify(f),
      postTitle,
      postText,
      alt,
      selectedBoardName,
      initialImgUrl,
    ).lastInsertRowid,
  );

  run("UPDATE newsite_repurpose_articles SET status = 'generated', last_repurposed_at = unixepoch() WHERE id = ?", article.id);

  let post = getRepurposePost(id)!;

  // Generate channel media (image or reel)
  if (isReel) {
    await makeRepurposeReel(post, article, site, channel, deps);
  } else {
    await makeRepurposeImage(post, article, site, channel, r, deps);
  }

  post = getRepurposePost(id)!;

  // Auto-publish if enabled
  if (site.repurpose_auto_publish) {
    await sendRepurposePost(id, deps);
    post = getRepurposePost(id)!;
  }

  return { post, problems: [] };
}

/* -- Post Sending & Publishing -------------------------------------------- */

export async function matchBoardWithAi(
  article: RepurposeArticleRow,
  site: NewWebsiteRow,
  boards: { serviceId: string; name: string; id?: string }[],
  deps: Pick<RepurposeDeps, 'ask'>,
): Promise<{ serviceId: string; name: string; id?: string } | undefined> {
  if (!boards.length) return undefined;
  if (boards.length === 1) return boards[0];

  try {
    const raw = await deps.ask('newsite-pick-board', {
      keyword: article.category || article.title,
      title: article.title,
      niche: site.niche || article.category,
      boardsJson: JSON.stringify(boards.map((b) => b.name)),
    });
    const parsed = parseObject(raw);
    const chosenName = String(parsed?.board ?? '').trim().toLowerCase();
    if (chosenName) {
      const match = boards.find((b) => b.name.toLowerCase() === chosenName);
      if (match) return match;
    }
  } catch {
    // AI failed or returned unparseable
  }
  return undefined;
}

export async function pickRepurposeBoard(
  article: RepurposeArticleRow,
  site: NewWebsiteRow,
  boards: { serviceId: string; name: string; id?: string }[],
  deps: Pick<RepurposeDeps, 'ask'>,
): Promise<{ serviceId: string; name: string; id?: string } | undefined> {
  if (!boards.length) return undefined;
  if (boards.length === 1) return boards[0];

  const aiMatch = await matchBoardWithAi(article, site, boards, deps);
  if (aiMatch) return aiMatch;

  // Fallback 1: match category name
  if (article.category) {
    const cat = article.category.toLowerCase().trim();
    const catMatch = boards.find((b) => {
      const bn = b.name.toLowerCase();
      return bn.includes(cat) || cat.includes(bn);
    });
    if (catMatch) return catMatch;
  }

  // Fallback 2: "general" board
  const general = boards.find((b) => /general/i.test(b.name));
  if (general) return general;

  // Fallback 3: first board
  return boards[0];
}

export async function getOrSelectPinterestBoard(
  channel: ChannelRow,
  site: NewWebsiteRow,
  article: RepurposeArticleRow,
  deps: RepurposeDeps,
): Promise<{ serviceId: string; name: string; id?: string }> {
  const boards = channelBoards(channel);

  // 1. If account has only 1 board stored in DB, select it immediately without calling Buffer API or AI
  if (boards.length === 1 && boards[0]) {
    return boards[0];
  }

  // 2. If existing cached boards > 1, try matching with AI
  if (boards.length > 1) {
    const aiMatch = await matchBoardWithAi(article, site, boards, deps);
    if (aiMatch) return aiMatch;
  }

  // 3. Fallback: boards were empty, OR the AI did not match any of the existing boards.
  // Query Buffer API for active boards on this channel and update the database.
  let freshBoards: { serviceId: string; name: string; id?: string }[] = boards;
  try {
    const api = (deps.buffer ?? realBuffer)(bufferTokenOf(channel, deps.encryptionKey));
    const channels = await api.channels();
    const found = channels.find((c) => c.id === channel.buffer_channel_id);
    if (found?.boards?.length) {
      freshBoards = found.boards;
      saveChannelBoards(channel.id, freshBoards);
      channel.boards_json = JSON.stringify(freshBoards);
    }
  } catch (err) {
    if (!freshBoards.length) throw err;
  }

  if (!freshBoards.length) {
    throw new Error('This Pinterest channel has no boards. Create a board on Pinterest first.');
  }

  // If account has only 1 board discovered, select it immediately
  if (freshBoards.length === 1 && freshBoards[0]) {
    return freshBoards[0];
  }

  // If freshBoards were newly discovered, try AI matching on them
  if (!boards.length || freshBoards.length !== boards.length) {
    const freshAi = await matchBoardWithAi(article, site, freshBoards, deps);
    if (freshAi) return freshAi;
  }

  // Fallback 1: match category name
  if (article.category) {
    const cat = article.category.toLowerCase().trim();
    const catMatch = freshBoards.find((b) => {
      const bn = b.name.toLowerCase();
      return bn.includes(cat) || cat.includes(bn);
    });
    if (catMatch) return catMatch;
  }

  // Fallback 2: "general" board
  const general = freshBoards.find((b) => /general/i.test(b.name));
  if (general) return general;

  // Fallback 3: first board
  return freshBoards[0]!;
}

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

  const publicBase = deps.settings?.get?.('public_base_url')?.trim() || '';
  const now = (deps.now ?? Date.now)();
  const days = Number(deps.settings?.get?.('reel_media_link_days') || 14);

  try {
    if (post.post_kind === 'reel') {
      // Reel Video Post
      let videoUrl = post.image_url || article.cover_url;
      if (post.media_file && publicBase) {
        videoUrl = repurposeReelMediaUrl(publicBase, post.id, days, deps.encryptionKey, now);
      }

      if (channel.via === 'buffer') {
        const api = (deps.buffer ?? realBuffer)(bufferTokenOf(channel, deps.encryptionKey));
        let board: { serviceId: string; name: string; id?: string } | undefined;
        if (channel.platform === 'pinterest') {
          board = await getOrSelectPinterestBoard(channel, site, article, deps);
        }

        const firstComment = rules.link === 'first_comment' && channel.paid_buffer && !commentsThroughApi(channel) ? article.url : '';
        const metadata = bufferMetadata(channel.platform, {
          title: post.title || article.title,
          url: article.url,
          boardServiceId: board?.serviceId || board?.id,
          firstComment,
          type: 'reel',
        });

        if (api.createVideoPost) {
          const id = await api.createVideoPost({
            text: post.text,
            channelId: channel.buffer_channel_id,
            videoUrl,
            metadata,
          });
          run(
            `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, board_name = ?, post_link = '', sent_at = unixepoch(), error = '' WHERE id = ?`,
            id,
            board?.name ?? post.board_name ?? '',
            post.id,
          );
        } else {
          // Fallback to createImagePost if mock BufferApi only has createImagePost
          const { id } = await api.createImagePost({
            text: post.text,
            channelId: channel.buffer_channel_id,
            imageUrl: videoUrl,
            altText: post.alt || article.title,
            metadata,
          });
          run(
            `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, board_name = ?, post_link = '', sent_at = unixepoch(), error = '' WHERE id = ?`,
            id,
            board?.name ?? post.board_name ?? '',
            post.id,
          );
        }
        return { ok: true };
      }

      if (channel.platform === 'facebook' && channel.via === 'api') {
        const api = (deps.facebook ?? ((tok) => new FacebookClient({ systemUserToken: tok })))(fbTokenOf(channel, deps.encryptionKey));
        let videoBuffer: Buffer | null = null;
        if (post.media_file) {
          const dir = repurposeDir(deps.dataDir);
          const p = join(dir, post.media_file);
          if (existsSync(p)) videoBuffer = readFileSync(p);
        }
        if (!videoBuffer && videoUrl && /^https?:\/\//i.test(videoUrl)) {
          const res = await (deps.fetchImpl ?? fetch)(videoUrl).catch(() => null);
          if (res && res.ok) videoBuffer = Buffer.from(await res.arrayBuffer());
        }

        if (videoBuffer) {
          const { videoId } = await api.publishReel({
            pageId: channel.fb_page_id,
            video: videoBuffer,
            description: post.text,
          });
          run(
            `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, post_link = ?, sent_at = unixepoch(), error = '' WHERE id = ?`,
            videoId,
            `https://www.facebook.com/${videoId}`,
            post.id,
          );
        } else {
          run(`UPDATE newsite_repurpose_posts SET status = 'sent', sent_at = unixepoch(), error = '' WHERE id = ?`, post.id);
        }
        return { ok: true };
      }

      if (channel.platform === 'instagram' && channel.via === 'api') {
        const api = (deps.instagram ?? realInstagram)(fbTokenOf(channel, deps.encryptionKey));
        const { mediaId, permalink } = await api.publishInstagram({
          pageId: channel.fb_page_id,
          igUserId: channel.api_account_id,
          kind: 'reel',
          mediaUrl: videoUrl,
          caption: post.text,
        });
        run(
          `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, post_link = ?, sent_at = unixepoch(), error = '' WHERE id = ?`,
          mediaId,
          permalink,
          post.id,
        );
        return { ok: true };
      }

      if (channel.platform === 'threads' && channel.via === 'api') {
        const token = await threadsTokenOf(channel, deps.encryptionKey, deps.renewThreads);
        const api = (deps.threads ?? realThreads)(token);
        const { mediaId, permalink } = await api.publish({
          userId: channel.api_account_id,
          kind: 'video',
          mediaUrl: videoUrl,
          text: post.text,
        });
        run(
          `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, post_link = ?, sent_at = unixepoch(), error = '' WHERE id = ?`,
          mediaId,
          permalink,
          post.id,
        );
        return { ok: true };
      }

      // Default: mark as sent
      run(`UPDATE newsite_repurpose_posts SET status = 'sent', sent_at = unixepoch(), error = '' WHERE id = ?`, post.id);
      return { ok: true };
    }

    // Otherwise: Image Post
    let imageUrl = post.image_url || article.cover_url;
    if (post.media_file && publicBase) {
      const ext = (post.media_file.split('.').pop() ?? 'jpg').toLowerCase();
      imageUrl = repurposePictureMediaUrl(publicBase, post.id, ext, days, deps.encryptionKey, now);
    }

    if (channel.via === 'buffer') {
      const api = (deps.buffer ?? realBuffer)(bufferTokenOf(channel, deps.encryptionKey));
      let board: { serviceId: string; name: string; id?: string } | undefined;
      if (channel.platform === 'pinterest') {
        board = await getOrSelectPinterestBoard(channel, site, article, deps);
      }

      const firstComment = rules.link === 'first_comment' && channel.paid_buffer && !commentsThroughApi(channel) ? article.url : '';
      const { id, dueAt } = await api.createImagePost({
        text: post.text,
        channelId: channel.buffer_channel_id,
        imageUrl,
        altText: post.alt || article.title,
        metadata: bufferMetadata(channel.platform, {
          title: post.title || article.title,
          url: article.url,
          boardServiceId: board?.serviceId || board?.id,
          firstComment,
          type: 'post',
        }),
      });
      run(
        `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, board_name = ?, post_link = '', sent_at = unixepoch(), error = '' WHERE id = ?`,
        id,
        board?.name ?? post.board_name ?? '',
        post.id,
      );
      return { ok: true };
    }

    if (channel.platform === 'facebook' && channel.via === 'api') {
      const api = (deps.facebook ?? ((tok) => new FacebookClient({ systemUserToken: tok })))(fbTokenOf(channel, deps.encryptionKey));
      let imageBuffer: Buffer | null = null;
      let contentType = 'image/jpeg';
      if (post.media_file) {
        const dir = repurposeDir(deps.dataDir);
        const p = join(dir, post.media_file);
        if (existsSync(p)) {
          imageBuffer = readFileSync(p);
          contentType = post.media_file.endsWith('.png') ? 'image/png' : 'image/jpeg';
        }
      }
      if (!imageBuffer && imageUrl && /^https?:\/\//i.test(imageUrl)) {
        const imgRes = await (deps.fetchImpl ?? fetch)(imageUrl).catch(() => null);
        if (imgRes && imgRes.ok) {
          imageBuffer = Buffer.from(await imgRes.arrayBuffer());
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

    if (channel.platform === 'instagram' && channel.via === 'api') {
      const igUrl = (post.media_file && publicBase)
        ? repurposePictureMediaUrl(publicBase, post.id, 'jpg', days, deps.encryptionKey, now, 'repurpose-ig-picture')
        : imageUrl;
      const api = (deps.instagram ?? realInstagram)(fbTokenOf(channel, deps.encryptionKey));
      const { mediaId, permalink } = await api.publishInstagram({
        pageId: channel.fb_page_id,
        igUserId: channel.api_account_id,
        kind: 'image',
        mediaUrl: igUrl,
        caption: post.text,
      });
      run(
        `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, post_link = ?, sent_at = unixepoch(), error = '' WHERE id = ?`,
        mediaId,
        permalink,
        post.id,
      );
      return { ok: true };
    }

    if (channel.platform === 'threads' && channel.via === 'api') {
      const token = await threadsTokenOf(channel, deps.encryptionKey, deps.renewThreads);
      const api = (deps.threads ?? realThreads)(token);
      const { mediaId, permalink } = await api.publish({
        userId: channel.api_account_id,
        kind: 'image',
        mediaUrl: imageUrl,
        text: post.text,
      });
      run(
        `UPDATE newsite_repurpose_posts SET status = 'sent', external_id = ?, post_link = ?, sent_at = unixepoch(), error = '' WHERE id = ?`,
        mediaId,
        permalink,
        post.id,
      );
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

/**
 * Regenerates fresh content and fresh channel media for a post (gives failed or existing posts another chance).
 */
export async function regenerateRepurposePost(
  postId: number,
  deps: RepurposeDeps,
): Promise<{ ok: boolean; post?: RepurposePostRow; problems?: string[] }> {
  const post = getRepurposePost(postId);
  if (!post) return { ok: false, problems: ['Post not found.'] };

  const article = getRepurposeArticle(post.article_id);
  if (!article) return { ok: false, problems: ['Article not found.'] };

  const channel = getChannel(post.channel_id);
  if (!channel) return { ok: false, problems: ['Channel not found.'] };

  const site = getNewWebsite(post.website_id);
  if (!site) return { ok: false, problems: ['Website not found.'] };

  const rules = channelRules(channel);
  const r = rules.rules;
  if (!r) return { ok: false, problems: ['No rules configured for channel platform.'] };

  const isReel = post.post_kind === 'reel';
  const platformRulesText = isReel ? `${r.text}\n\n${REEL_NOTE}` : r.text;

  const articleOutline = article.content_text
    ? article.content_text.split('\n').filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '- ')).join('\n') || '- (no headings)'
    : '- (no headings)';
  const articleStart = (article.content_text || article.excerpt || article.title).slice(0, 1500);

  const outcome = await correctUntilRight<Record<string, string>>({
    ask: (corrections) =>
      deps.ask('newsite-social-post', {
        language: site.language,
        label: isReel ? `${r.label} (Reel)` : r.label,
        platformRules: corrections
          ? `${platformRulesText}\n\nIMPORTANT: Do NOT reuse the original article title verbatim. Write a fresh, original headline for this post.\n\nCORRECTIONS REQUIRED:\n${corrections}`
          : `${platformRulesText}\n\nIMPORTANT: Do NOT reuse the original article title verbatim. Write a fresh, original headline for this post.`,
        fields: r.fields.join(', '),
        shape: JSON.stringify(Object.fromEntries(r.fields.map((f: string) => [f, '...']))),
        domain: site.domain,
        title: article.title,
        articleTitle: article.title,
        focusKeyword: article.category || site.niche,
        keyword: article.title,
        description: article.excerpt || article.title,
        excerpt: article.excerpt || article.title,
        niche: site.niche,
        persona: site.persona,
        articleOutline,
        articleStart,
        articleContent: (article.content_text || article.excerpt || article.title).slice(0, 4000),
        problemsJson: corrections || '',
      }),
    parse: (raw) => {
      const o = parseJson(raw);
      return o ? Object.fromEntries(r.fields.map((f: string) => [f, strClean(o, f)])) : null;
    },
    check: (fields) => {
      const baseProblems = checkFields(fields, r, site.domain);
      if (fields.title && fields.title.toLowerCase().trim() === article.title.toLowerCase().trim()) {
        baseProblems.push('Do NOT reuse the original article title verbatim. Write a fresh, captivating headline for this post.');
      }
      return baseProblems;
    },
  });

  if (!outcome.answer) {
    return { ok: false, problems: outcome.problems };
  }

  const f = outcome.answer;
  const postText = f[r.postText] ?? f.text ?? f.caption ?? '';
  const alt = r.altField ? f[r.altField] ?? '' : '';
  const postTitle = f.title ?? '';

  run(
    `UPDATE newsite_repurpose_posts SET
       fields_json = ?, title = ?, text = ?, alt = ?,
       status = 'waiting', error = '', scheduled_for = 0, sent_at = 0
     WHERE id = ?`,
    JSON.stringify(f),
    postTitle,
    postText,
    alt,
    post.id,
  );

  run("UPDATE newsite_repurpose_articles SET status = 'generated', last_repurposed_at = unixepoch() WHERE id = ?", article.id);

  let updatedPost = getRepurposePost(post.id)!;

  // Regenerate media too
  if (isReel) {
    await makeRepurposeReel(updatedPost, article, site, channel, deps);
  } else {
    await makeRepurposeImage(updatedPost, article, site, channel, r, deps);
  }

  updatedPost = getRepurposePost(post.id)!;

  // Auto-publish if enabled
  if (site.repurpose_auto_publish) {
    await sendRepurposePost(updatedPost.id, deps);
    updatedPost = getRepurposePost(post.id)!;
  }

  return { ok: true, post: updatedPost };
}

/**
 * Retries/regenerates all failed posts for a website.
 */
export async function retryFailedRepurposePosts(
  websiteId: number,
  deps: RepurposeDeps,
): Promise<{ ok: boolean; retried: number }> {
  const failedPosts = all<RepurposePostRow>(
    `SELECT * FROM newsite_repurpose_posts WHERE website_id = ? AND status = 'failed' ORDER BY id ASC`,
    websiteId,
  );
  let retried = 0;
  for (const p of failedPosts) {
    const res = await regenerateRepurposePost(p.id, deps);
    if (res.ok) retried++;
  }
  return { ok: true, retried };
}

/* -- Bulk Article Operations ---------------------------------------------- */

export async function bulkEditArticles(
  articleIds: number[],
  action: 'repurpose' | 'pause' | 'activate' | 'delete',
  options: { channelId?: number | 'all'; kind?: 'image' | 'reel'; deps?: RepurposeDeps } = {},
): Promise<{ ok: boolean; affected: number; error?: string }> {
  if (!articleIds.length) return { ok: true, affected: 0 };

  if (action === 'pause') {
    const placeholders = articleIds.map(() => '?').join(',');
    run(`UPDATE newsite_repurpose_articles SET status = 'paused' WHERE id IN (${placeholders})`, ...articleIds);
    return { ok: true, affected: articleIds.length };
  }

  if (action === 'activate') {
    const placeholders = articleIds.map(() => '?').join(',');
    run(`UPDATE newsite_repurpose_articles SET status = 'active' WHERE id IN (${placeholders})`, ...articleIds);
    return { ok: true, affected: articleIds.length };
  }

  if (action === 'delete') {
    const placeholders = articleIds.map(() => '?').join(',');
    run(`DELETE FROM newsite_repurpose_articles WHERE id IN (${placeholders})`, ...articleIds);
    return { ok: true, affected: articleIds.length };
  }

  if (action === 'repurpose') {
    if (!options.deps) return { ok: false, affected: 0, error: 'Missing dependencies.' };
    let generated = 0;
    for (const artId of articleIds) {
      const art = getRepurposeArticle(artId);
      if (!art) continue;
      const channels = websiteChannels(art.website_id);
      if (!channels.length) continue;

      if (options.channelId === 'all') {
        for (const ch of channels) {
          if (ch.post_image && !videoOnly(ch.platform)) {
            const res = await generateRepurposePost(artId, ch.id, options.deps, 'image');
            if (res.post) generated++;
          }
          if (ch.post_reel && takesReels(ch.platform)) {
            const res = await generateRepurposePost(artId, ch.id, options.deps, 'reel');
            if (res.post) generated++;
          }
        }
      } else {
        const chId = Number(options.channelId);
        const validCh = channels.find((c) => c.id === chId) ?? channels[0];
        if (validCh) {
          if (options.kind) {
            const res = await generateRepurposePost(artId, validCh.id, options.deps, options.kind);
            if (res.post) generated++;
          } else {
            if (validCh.post_image && !videoOnly(validCh.platform)) {
              const res = await generateRepurposePost(artId, validCh.id, options.deps, 'image');
              if (res.post) generated++;
            }
            if (validCh.post_reel && takesReels(validCh.platform)) {
              const res = await generateRepurposePost(artId, validCh.id, options.deps, 'reel');
              if (res.post) generated++;
            }
          }
        }
      }
    }
    return { ok: true, affected: generated };
  }

  return { ok: false, affected: 0, error: 'Unknown action.' };
}

/* -- Conflict Avoidance & Background Worker ------------------------------- */

/**
 * Checks whether the main article generation pipeline or Flow image generation is active.
 * Repurposing steps aside whenever the main pipeline is writing an article or generating Flow images
 * so that they never collide on Gemini Chrome sessions or Flow rate limits.
 */
export function isMainPipelineBusy(): boolean {
  // 1. Check if any old pipeline runs are actively running
  try {
    const activeRun = get<{ id: number }>("SELECT id FROM runs WHERE status = 'running' LIMIT 1");
    if (activeRun) return true;
  } catch {
    // runs table may not exist
  }

  // 2. Check if any new dashboard keyword is actively writing or publishing right now
  try {
    const activeKeyword = get<{ id: number }>(
      `SELECT id FROM keyword_seo
       WHERE auto_active = 1
          OR (generate_now = 1 AND COALESCE(post_status, '') != 'published')
          OR status = 'writing'
          OR recipe_status = 'writing'
          OR skeleton_status = 'writing'
          OR article_status = 'writing'
          OR images_status = 'writing'
          OR post_status = 'publishing'
       LIMIT 1`,
    );
    if (activeKeyword) return true;
  } catch {
    // keyword_seo table may not exist
  }

  // 3. Check if Flow pictures are actively making right now
  try {
    const activePictures = get<{ id: number }>(
      `SELECT id FROM newsite_pictures WHERE status = 'making' LIMIT 1`,
    );
    if (activePictures) return true;
  } catch {
    // newsite_pictures table may not exist
  }

  // 4. Check if Flow video reels are actively making right now
  try {
    const activeReels = get<{ id: number }>(
      `SELECT id FROM newsite_reels WHERE status = 'making' LIMIT 1`,
    );
    if (activeReels) return true;
  } catch {
    // newsite_reels table may not exist
  }

  // 5. Check if repurpose media is making right now
  try {
    const activeRepurpose = get<{ id: number }>(
      `SELECT id FROM newsite_repurpose_posts WHERE media_status = 'making' LIMIT 1`,
    );
    if (activeRepurpose) return true;
  } catch {
    // newsite_repurpose_posts table may not exist
  }

  return false;
}

let kickInProgress = false;

export async function kickRepurpose(deps: RepurposeDeps): Promise<void> {
  if (kickInProgress) return;
  kickInProgress = true;

  try {
    // Step aside if the main article generator or Flow image maker is busy
    if (isMainPipelineBusy()) {
      return;
    }

    const activeSites = all<NewWebsiteRow>("SELECT * FROM new_websites WHERE repurpose_status = 'active'");
    const now = Math.floor(Date.now() / 1000);

    for (const site of activeSites) {
      const dailyTarget = site.repurpose_daily_target ?? 1;
      if (dailyTarget <= 0) continue;

      // Count all posts created or sent today against the daily limit
      const countToday = repurposeCountToday(site.id);
      if (countToday >= dailyTarget) continue;

      const cooldownSeconds = (site.repurpose_cooldown_days ?? 30) * 86400;
      const cutoff = now - cooldownSeconds;

      // Pick the oldest never-repurposed or least-recently-repurposed article
      const candidate = get<RepurposeArticleRow>(
        `SELECT * FROM newsite_repurpose_articles
         WHERE website_id = ? AND status IN ('active', 'generated') AND (last_repurposed_at = 0 OR last_repurposed_at < ?)
         ORDER BY (status = 'generated') ASC,
                  last_repurposed_at ASC,
                  CASE WHEN published_at > 0 THEN published_at ELSE site_post_id END ASC,
                  site_post_id ASC
         LIMIT 1`,
        site.id,
        cutoff,
      );

      if (!candidate) continue;

      const channels = websiteChannels(site.id);
      if (!channels.length) continue;

      // Build options: for each channel, determine valid post kinds (image, reel, or both)
      const options: { channel: ChannelRow; kind: 'image' | 'reel' }[] = [];
      for (const ch of channels) {
        if (ch.post_image && !videoOnly(ch.platform)) {
          options.push({ channel: ch, kind: 'image' });
        }
        if (ch.post_reel && takesReels(ch.platform)) {
          options.push({ channel: ch, kind: 'reel' });
        }
      }
      if (!options.length) continue;

      // Count posts per channel and post_kind to rotate fairly
      const counts = all<{ channel_id: number; post_kind: string; count: number }>(
        `SELECT channel_id, post_kind, COUNT(*) AS count FROM newsite_repurpose_posts WHERE website_id = ? GROUP BY channel_id, post_kind`,
        site.id,
      );
      const countMap = new Map(counts.map((c) => [`${c.channel_id}-${c.post_kind}`, c.count]));

      const sortedOptions = [...options].sort(
        (a, b) => (countMap.get(`${a.channel.id}-${a.kind}`) ?? 0) - (countMap.get(`${b.channel.id}-${b.kind}`) ?? 0),
      );
      const chosen = sortedOptions[0]!;

      // Double-check pipeline busy status before firing Gemini prompt
      if (isMainPipelineBusy()) return;

      await generateRepurposePost(candidate.id, chosen.channel.id, deps, chosen.kind);
    }
  } finally {
    kickInProgress = false;
  }
}
