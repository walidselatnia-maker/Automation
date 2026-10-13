import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { BufferClient, type BufferChannel } from '../integrations/buffer.js';
import { FacebookClient } from '../integrations/facebook.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { loadTemplate } from '../pipeline/prompts.js';
import type { Settings } from '../settings.js';
import { bufferTokenOf, fbTokenOf, getChannel, websiteChannels, type ChannelRow } from './channels.js';
import { uploadMedia, type Fetch } from './client.js';
import { parseImageSet } from './images.js';
import { isMainSlot, listPictures, pictureDir, type PictureRow } from './pictures.js';
import { getNewWebsite, websiteApiKey, type NewWebsiteRow } from './repo.js';
import { correctUntilRight } from './rounds.js';
import { getSeoRow, type SeoRow } from './seo.js';

/**
 * Sharing a published article on its website's channels.
 *
 * One post per channel, each its own: a Pinterest pin (its own 3:4 picture
 * from one of four rotating templates, its own words, a board the AI picks
 * for the keyword) sent through the channel's Buffer account, and a Facebook
 * image post sent the way its channel posts: through the Facebook API, or
 * through Buffer.
 *
 * The link rule never bends: the article link is never in a post's text. A
 * pin carries it as the pin's own link; on Facebook it is the first comment
 * (through Buffer only on a paid plan; on a free one the post has no link).
 *
 * A Buffer channel that is full makes its post wait (buffer_hold_hours, as
 * the old dashboard waits) and try again; it is never skipped.
 */

const log = createLogger('newsite-social');

/**
 * Buffer saying the channel's queue is full (or it is being throttled): the
 * post waits and tries again. Narrower than the old dashboard's rotation
 * list, which also rotated on a refused token: with one account per channel
 * there is nothing to rotate to, so a refused token is a plain failure.
 */
const QUEUE_FULL = ['queue', 'limit', 'full', 'maximum', 'exceeded', 'too many', 'quota', 'throttl', 'http 429'];
export const isQueueFull = (err: unknown): boolean => {
  const text = errorMessage(err).toLowerCase();
  return QUEUE_FULL.some((m) => text.includes(m));
};

export type SocialKind = 'pin' | 'fb_image';

export interface SocialPostRow {
  id: number;
  seo_id: number;
  channel_id: number;
  kind: SocialKind;
  status: 'pending' | 'picture' | 'waiting' | 'sent' | 'failed';
  template: number;
  title: string;
  text: string;
  alt: string;
  overlay: string;
  board_name: string;
  picture_id: number | null;
  external_id: string;
  comment_id: string;
  error: string;
  retry_at: number | null;
  created_at: string;
  sent_at: string | null;
}

export const PIN_TEMPLATES = 4;

/** What a channel can do; replaceable so tests call no real Buffer or Facebook. */
export interface BufferApi {
  channels: () => Promise<BufferChannel[]>;
  createPin: (input: {
    text: string;
    channelId: string;
    imageUrl: string;
    altText: string;
    title: string;
    linkUrl: string;
    boardServiceId: string;
  }) => Promise<string>;
  /** A Facebook image post; the link comment only when the plan allows first comments. */
  createFacebookPost: (input: { text: string; channelId: string; imageUrl: string; altText: string; firstComment: string }) => Promise<string>;
}

export interface FacebookApi {
  publishPhoto: (input: { pageId: string; image: Buffer; contentType: string; message: string }) => Promise<{ postId: string }>;
  commentOnPost: (input: { pageId: string; postId: string; message: string }) => Promise<{ commentId: string }>;
}

export interface SocialDeps {
  settings: Settings;
  encryptionKey: Buffer;
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
  dataDir?: string;
  /** For uploading the pin picture to the website (its public link is what Buffer fetches). */
  fetchImpl?: Fetch;
  buffer?: (token: string) => BufferApi;
  facebook?: (token: string) => FacebookApi;
  /** Wakes the picture maker once a pin picture is queued. */
  startPictures?: () => void;
  now?: () => number;
  /** Wakes the poster when a waiting post is due; tests pass their own. */
  wakeIn?: (ms: number, wake: () => void) => void;
}

const realBuffer = (token: string): BufferApi => {
  const client = new BufferClient(token);
  return {
    channels: async () => client.getChannels(await client.getOrganizationId()),
    createPin: (input) => client.createPost(input),
    createFacebookPost: (input) => client.createFacebookPost(input),
  };
};

const realFacebook = (token: string): FacebookApi => {
  const client = new FacebookClient({ systemUserToken: token });
  return { publishPhoto: (i) => client.publishPhoto(i), commentOnPost: (i) => client.commentOnPost(i) };
};

export const listSocialPosts = (): (SocialPostRow & { keyword: string; title_seo: string; post_url: string })[] =>
  all(
    `SELECT sp.*, s.keyword, s.title AS title_seo, s.post_url FROM newsite_social_posts sp
       JOIN keyword_seo s ON s.id = sp.seo_id ORDER BY sp.id DESC`,
  );

/** Every social post of one keyword plan's articles. */
export const listPlanSocialPosts = (planId: number): SocialPostRow[] =>
  all<SocialPostRow>(
    `SELECT sp.* FROM newsite_social_posts sp JOIN keyword_seo s ON s.id = sp.seo_id WHERE s.plan_id = ? ORDER BY s.position, sp.channel_id, sp.id`,
    planId,
  );

export const getSocialPost = (id: number): SocialPostRow | undefined =>
  get<SocialPostRow>('SELECT * FROM newsite_social_posts WHERE id = ?', id);

/** The website a keyword belongs to. */
function websiteOf(seoId: number): NewWebsiteRow | undefined {
  const plan = get<{ website_id: number }>(
    'SELECT k.website_id FROM keyword_seo s JOIN keyword_plans k ON k.id = s.plan_id WHERE s.id = ?',
    seoId,
  );
  return plan ? getNewWebsite(plan.website_id) : undefined;
}

/**
 * Once an article is posted: one social post per channel its website shares
 * on. Publishing it again adds nothing new (one post per channel and kind).
 */
export function createSocialPosts(seoId: number): number {
  const site = websiteOf(seoId);
  if (!site) return 0;
  let added = 0;
  for (const c of websiteChannels(site.id)) {
    const kinds: SocialKind[] = c.platform === 'pinterest' ? ['pin'] : c.post_image ? ['fb_image'] : [];
    for (const kind of kinds) {
      added += Number(
        run('INSERT OR IGNORE INTO newsite_social_posts (seo_id, channel_id, kind) VALUES (?, ?, ?)', seoId, c.id, kind).changes,
      );
    }
  }
  return added;
}

/** Put a failed post back to work, keeping what it already has. */
export function retrySocialPost(id: number): void {
  run(`UPDATE newsite_social_posts SET status = 'pending', error = '', retry_at = NULL WHERE id = ? AND status = 'failed'`, id);
}

/* -- Checks: the link rule and each platform's limits ---------------------- */

const LINKISH = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|co|io|blog|recipes|info)\b|link in (the )?bio/i;

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

const noLink = (field: string, value: string, domain: string): string[] =>
  LINKISH.test(value) || (domain && value.toLowerCase().includes(domain.toLowerCase()))
    ? [`The ${field} has a link or web address in it. Remove it: the link is never in the text (${field === 'post' ? 'it goes in the first comment' : 'the pin carries the link itself'}).`]
    : [];

export interface PinText {
  headline: string;
  cta: string;
  title: string;
  description: string;
  alt: string;
}

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === 'string' ? (o[k] as string).replace(/\s+/g, ' ').trim() : '');

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

export const parsePinText = (raw: string): PinText | null => {
  const o = parseObject(raw);
  return o ? { headline: str(o, 'headline'), cta: str(o, 'cta'), title: str(o, 'title'), description: str(o, 'description'), alt: str(o, 'alt') } : null;
};

export function checkPinText(p: PinText, domain: string): string[] {
  const problems: string[] = [];
  if (words(p.headline) < 2 || words(p.headline) > 6) problems.push(`The headline has ${words(p.headline)} words; write 2 to 6 (it is printed on the picture).`);
  if (words(p.cta) < 2 || words(p.cta) > 4) problems.push(`The cta has ${words(p.cta)} words; write 2 to 4, like "Save for Later".`);
  if (p.title.length < 40 || p.title.length > 100) problems.push(`The title is ${p.title.length} characters; write 40 to 100.`);
  if (p.description.length < 150 || p.description.length > 450) problems.push(`The description is ${p.description.length} characters; write 150 to 450.`);
  if (words(p.alt) < 8 || words(p.alt) > 20) problems.push(`The alt text has ${words(p.alt)} words; write 8 to 20.`);
  if (/!/.test(p.title)) problems.push('The title has an exclamation mark; remove it.');
  if (/#\w/.test(p.description)) problems.push('The description has hashtags; remove them and use plain words.');
  for (const [field, value] of Object.entries(p)) problems.push(...noLink(field, value, domain));
  return problems;
}

export function checkFbText(text: string, domain: string): string[] {
  const problems: string[] = [];
  if (text.length < 80 || text.length > 500) problems.push(`The post is ${text.length} characters; write 80 to 500.`);
  if (/#\w/.test(text)) problems.push('The post has hashtags; remove them.');
  problems.push(...noLink('post', text, domain));
  return problems;
}

/* -- The poster ----------------------------------------------------------- */

interface Work {
  item: SocialPostRow;
  row: SeoRow;
  site: NewWebsiteRow;
  channel: ChannelRow;
}

const fail = (id: number, error: string): void => {
  run(`UPDATE newsite_social_posts SET status = 'failed', error = ? WHERE id = ?`, error.slice(0, 600), id);
};

const articleStart = (md: string): string => md.slice(0, 1500);

const nicheOf = (site: NewWebsiteRow): string => site.niche;

async function writePinText(w: Work, deps: SocialDeps): Promise<boolean> {
  const out = await correctUntilRight<PinText>({
    ask: (corrections) =>
      deps.ask('newsite-pin-text', {
        title: w.row.title,
        focusKeyword: w.row.focus_keyword,
        keyword: w.row.keyword,
        description: w.row.description,
        niche: nicheOf(w.site),
        articleStart: articleStart(w.row.article_md),
        problemsJson: corrections,
      }),
    parse: parsePinText,
    check: (p) => checkPinText(p, w.site.domain),
  });
  if (out.technical || !out.answer) {
    fail(w.item.id, out.problems.join(' '));
    return false;
  }
  const p = out.answer;
  run(
    `UPDATE newsite_social_posts SET title = ?, text = ?, alt = ?, overlay = ? WHERE id = ?`,
    p.title, p.description, p.alt, JSON.stringify({ headline: p.headline, cta: p.cta }), w.item.id,
  );
  Object.assign(w.item, { title: p.title, text: p.description, alt: p.alt, overlay: JSON.stringify({ headline: p.headline, cta: p.cta }) });
  return true;
}

/** Queue the pin's own picture, from the next template in the channel's rotation. */
function queuePinPicture(w: Work, deps: SocialDeps): void {
  const set = parseImageSet(w.row.images_json);
  const prompt = (slot: string) => set?.images.find((im) => im.slot === slot)?.prompt ?? '';
  const scene = prompt('feature') || prompt('serving') || w.row.title;
  const detail = prompt('closeup') || prompt('overhead') || scene;
  const template = w.channel.next_template % PIN_TEMPLATES;
  run('UPDATE newsite_channels SET next_template = next_template + 1 WHERE id = ?', w.channel.id);
  const overlay = JSON.parse(w.item.overlay || '{}') as { headline?: string; cta?: string };
  const text = loadTemplate(`newsite-pin-${template + 1}.template.txt`, {
    scene,
    detail,
    headline: overlay.headline ?? '',
    cta: overlay.cta ?? '',
    domain: w.site.domain,
  });
  run(`DELETE FROM newsite_pictures WHERE seo_id = ? AND slot = ?`, w.row.id, `pin-${w.item.id}`);
  const pictureId = Number(
    run(
      `INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status) VALUES (?, ?, 1000, ?, ?, 'queued')`,
      w.row.id, `pin-${w.item.id}`, text, w.item.alt,
    ).lastInsertRowid,
  );
  run(`UPDATE newsite_social_posts SET status = 'picture', picture_id = ?, template = ? WHERE id = ?`, pictureId, template + 1, w.item.id);
  deps.startPictures?.();
}

/** The board for this keyword, from the boards on the channel's Pinterest account. */
async function pickBoard(w: Work, boards: { serviceId: string; name: string }[], deps: SocialDeps) {
  const raw = await deps
    .ask('newsite-pick-board', {
      keyword: w.row.keyword,
      title: w.row.title,
      niche: nicheOf(w.site),
      boardsJson: JSON.stringify(boards.map((b) => b.name)),
    })
    .catch(() => '');
  const name = String(parseObject(raw)?.board ?? '').trim().toLowerCase();
  return boards.find((b) => b.name.toLowerCase() === name) ?? boards[0]!;
}

const typeOf = (file: string): string => (file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') ? 'image/jpeg' : 'image/webp');

async function sendPin(w: Work, deps: SocialDeps, now: number): Promise<void> {
  const picture = w.item.picture_id ? get<PictureRow>('SELECT * FROM newsite_pictures WHERE id = ?', w.item.picture_id) : undefined;
  if (!picture || picture.status !== 'done') {
    // Its picture is gone (prompts were rewritten): make a new one.
    queuePinPicture(w, deps);
    return;
  }
  const api = (deps.buffer ?? realBuffer)(bufferTokenOf(w.channel, deps.encryptionKey));
  try {
    const found = (await api.channels()).find((c) => c.id === w.channel.buffer_channel_id);
    if (!found) throw new Error('Buffer no longer lists this Pinterest channel. Check it on the Channels page.');
    if (!found.boards.length) throw new Error('This Pinterest channel has no boards.');
    const board = await pickBoard(w, found.boards, deps);
    const data = readFileSync(join(pictureDir(picture.seo_id, deps.dataDir ?? resolveDataDir()), picture.file));
    const media = await uploadMedia(
      w.site.domain,
      websiteApiKey(w.site, deps.encryptionKey),
      { data, name: picture.file, type: typeOf(picture.file), alt: w.item.alt },
      deps.fetchImpl,
    );
    const postId = await api.createPin({
      text: w.item.text,
      channelId: w.channel.buffer_channel_id,
      imageUrl: media.url,
      altText: w.item.alt,
      title: w.item.title,
      // The pin's own link: never in its text.
      linkUrl: w.row.post_url,
      boardServiceId: board.serviceId,
    });
    run(
      `UPDATE newsite_social_posts SET status = 'sent', external_id = ?, board_name = ?, error = '', retry_at = NULL, sent_at = datetime('now') WHERE id = ?`,
      postId, board.name, w.item.id,
    );
  } catch (err) {
    if (isQueueFull(err)) return waitForRoom(w, err, deps, now);
    fail(w.item.id, errorMessage(err));
  }
}

/** A full Buffer queue: the post waits and tries again; it is never skipped. */
function waitForRoom(w: Work, err: unknown, deps: SocialDeps, now: number): void {
  const hours = Math.max(1, deps.settings.getNumber('buffer_hold_hours'));
  run(
    `UPDATE newsite_social_posts SET status = 'waiting', retry_at = ?, error = ? WHERE id = ?`,
    now + hours * 3_600_000,
    `Buffer did not take it yet (${errorMessage(err).slice(0, 200)}). Tries again in ${hours} hours.`,
    w.item.id,
  );
}

/** A Facebook image post through the channel's Buffer account. */
async function sendFacebookThroughBuffer(w: Work, picture: PictureRow, deps: SocialDeps, now: number): Promise<void> {
  const api = (deps.buffer ?? realBuffer)(bufferTokenOf(w.channel, deps.encryptionKey));
  try {
    const data = readFileSync(join(pictureDir(picture.seo_id, deps.dataDir ?? resolveDataDir()), picture.file));
    const media = await uploadMedia(
      w.site.domain,
      websiteApiKey(w.site, deps.encryptionKey),
      { data, name: picture.file, type: typeOf(picture.file), alt: picture.alt },
      deps.fetchImpl,
    );
    const postId = await api.createFacebookPost({
      text: w.item.text,
      channelId: w.channel.buffer_channel_id,
      imageUrl: media.url,
      altText: picture.alt,
      // The link, only ever as the first comment; Buffer's free plan has none.
      firstComment: w.channel.paid_buffer ? w.row.post_url : '',
    });
    run(
      `UPDATE newsite_social_posts SET status = 'sent', external_id = ?, error = ?, retry_at = NULL, sent_at = datetime('now') WHERE id = ?`,
      postId,
      w.channel.paid_buffer ? '' : 'Posted without the link: Buffer’s free plan cannot add a first comment.',
      w.item.id,
    );
  } catch (err) {
    if (isQueueFull(err)) return waitForRoom(w, err, deps, now);
    fail(w.item.id, errorMessage(err));
  }
}

async function sendFacebookImage(w: Work, deps: SocialDeps, now: number): Promise<void> {
  if (!w.item.text) {
    const out = await correctUntilRight<string>({
      ask: (corrections) =>
        deps.ask('newsite-fb-post', {
          title: w.row.title,
          focusKeyword: w.row.focus_keyword,
          keyword: w.row.keyword,
          description: w.row.description,
          niche: nicheOf(w.site),
          persona: w.site.persona,
          articleStart: articleStart(w.row.article_md),
          problemsJson: corrections,
        }),
      parse: (raw) => {
        const o = parseObject(raw);
        return o ? str(o, 'text') || null : null;
      },
      check: (t) => checkFbText(t, w.site.domain),
    });
    if (out.technical || !out.answer) return fail(w.item.id, out.problems.join(' '));
    run('UPDATE newsite_social_posts SET text = ? WHERE id = ?', out.answer, w.item.id);
    w.item.text = out.answer;
  }
  const pictures = listPictures(w.row.id).filter((p) => isMainSlot(p.slot) && p.status === 'done');
  const picture = pictures.find((p) => p.slot === 'feature') ?? pictures[0];
  if (!picture) return fail(w.item.id, 'The article has no picture to post.');
  if (w.channel.via === 'buffer') return sendFacebookThroughBuffer(w, picture, deps, now);
  const api = (deps.facebook ?? realFacebook)(fbTokenOf(w.channel, deps.encryptionKey));
  let postId: string;
  try {
    const data = readFileSync(join(pictureDir(picture.seo_id, deps.dataDir ?? resolveDataDir()), picture.file));
    ({ postId } = await api.publishPhoto({ pageId: w.channel.fb_page_id, image: data, contentType: typeOf(picture.file), message: w.item.text }));
  } catch (err) {
    return fail(w.item.id, errorMessage(err));
  }
  run(`UPDATE newsite_social_posts SET status = 'sent', external_id = ?, error = '', sent_at = datetime('now') WHERE id = ?`, postId, w.item.id);
  // The link, always in the first comment, never in the post.
  try {
    const { commentId } = await api.commentOnPost({ pageId: w.channel.fb_page_id, postId, message: w.row.post_url });
    run('UPDATE newsite_social_posts SET comment_id = ? WHERE id = ?', commentId, w.item.id);
  } catch (err) {
    run('UPDATE newsite_social_posts SET error = ? WHERE id = ?', `Posted, but the link comment failed: ${errorMessage(err).slice(0, 300)}`, w.item.id);
  }
}

async function work(item: SocialPostRow, deps: SocialDeps, now: number): Promise<void> {
  const row = getSeoRow(item.seo_id);
  const channel = getChannel(item.channel_id);
  const site = row ? websiteOf(row.id) : undefined;
  if (!row || !channel || !site) return fail(item.id, 'Its article, website or channel is gone.');
  if (row.post_status !== 'published' || !row.post_url) return fail(item.id, 'The article is not posted on the website.');
  const w: Work = { item, row, site, channel };
  if (item.kind === 'pin') {
    if (!item.text && !(await writePinText(w, deps))) return;
    if (!item.picture_id) return queuePinPicture(w, deps);
    return sendPin(w, deps, now);
  }
  return sendFacebookImage(w, deps, now);
}

let running: Promise<void> | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

const defaultWake = (ms: number, wake: () => void): void => {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wake();
  }, Math.min(ms, 2 ** 31 - 1));
  wakeTimer.unref?.();
};

/** Work through every post that is ready, one at a time; wake again for the first that waits. */
export function kickSocial(deps: SocialDeps): Promise<void> {
  if (running) return running;
  const now = deps.now ?? Date.now;
  running = Promise.resolve()
    .then(async () => {
      // A pin whose picture is gone, finished or failed while nobody was
      // listening (a restart, or its article's prompts rewritten) goes back
      // to work: sendPin makes a new picture or sends the finished one.
      run(
        `UPDATE newsite_social_posts SET status = 'pending'
          WHERE status = 'picture'
            AND (picture_id IS NULL OR picture_id NOT IN (SELECT id FROM newsite_pictures WHERE status IN ('queued', 'making')))`,
      );
      const seen = new Set<number>();
      for (;;) {
        const item = get<SocialPostRow>(
          `SELECT * FROM newsite_social_posts WHERE status = 'pending' OR (status = 'waiting' AND retry_at <= ?) ORDER BY id LIMIT 1`,
          now(),
        );
        if (!item || seen.has(item.id)) break;
        seen.add(item.id);
        try {
          await work(item, deps, now());
        } catch (err) {
          log.error(`Social post ${item.id} failed: ${errorMessage(err)}`);
          fail(item.id, errorMessage(err));
        }
      }
      const next = get<{ at: number | null }>(`SELECT MIN(retry_at) AS at FROM newsite_social_posts WHERE status = 'waiting'`);
      if (next?.at) (deps.wakeIn ?? defaultWake)(Math.max(1000, next.at - now()), () => void kickSocial(deps));
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** A pin's picture is made (or failed): its post carries on. */
export function onPinPicture(pictureId: number, ok: boolean, deps: SocialDeps): Promise<void> {
  const item = get<SocialPostRow>(`SELECT * FROM newsite_social_posts WHERE picture_id = ? AND status = 'picture'`, pictureId);
  if (!item) return Promise.resolve();
  if (!ok) {
    const picture = get<PictureRow>('SELECT * FROM newsite_pictures WHERE id = ?', pictureId);
    fail(item.id, `Its picture could not be made: ${picture?.error ?? 'unknown error'}`);
    return Promise.resolve();
  }
  run(`UPDATE newsite_social_posts SET status = 'pending' WHERE id = ?`, item.id);
  return kickSocial(deps);
}
