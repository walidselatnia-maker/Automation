import { readFileSync } from 'node:fs';
import { articleChat } from '../llm/gemini.js';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { BufferClient, type BufferChannel } from '../integrations/buffer.js';
import { FacebookClient } from '../integrations/facebook.js';
import { ThreadsClient } from '../integrations/threads.js';
import { threadsTokenOf, type Renew } from './threads-token.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { commentsThroughApi } from './first-comment.js';
import { pictureMediaUrl } from '../core/media-links.js';
import { channelRules, type PlatformRules } from './platform-rules.js';
import { loadTemplate } from '../pipeline/prompts.js';
import { pickedPinDesigns, renderDesign } from './pin-designs.js';
import type { Settings } from '../settings.js';
import { bufferTokenOf, channelTakes, fbTokenOf, getChannel, videoOnly, websiteChannels, type ChannelRow } from './channels.js';
import type { Fetch } from './client.js';
import { claimSocialSlot, lastSocialSent, socialDueAt } from './gaps.js';
import { parseImageSet } from './images.js';
import { pictureDir, type PictureRow } from './pictures.js';
import { instagramFileOf, makeInstagramPicture } from './instagram-picture.js';
import { getNewWebsite, type NewWebsiteRow } from './repo.js';
import { correctUntilRight } from './rounds.js';
import { getSeoRow, type SeoRow } from './seo.js';

/**
 * Sharing a published article on its website's channels.
 *
 * One post per channel, each its own: a Pinterest pin (its own 3:4 picture
 * from one of four rotating templates, its own words, a board the AI picks
 * for the keyword, or the account's "general" board) sent through the
 * channel's Buffer account, and a Facebook image post sent the way its channel posts: through the Facebook API, or
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

/** A post's platform: the rules file of that name (prompts/platforms/<kind>.md) runs it. */
export type SocialKind = string;

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
  /** Every field the platform's rules asked for, as the AI wrote it (JSON). */
  fields_json: string;
  board_name: string;
  picture_id: number | null;
  external_id: string;
  comment_id: string;
  error: string;
  retry_at: number | null;
  /** When Buffer said it will post it (Buffer's own answer); empty for a direct post. */
  due_at: string;
  /** The post on its platform, once it is out (post-links.ts fills it in for Buffer posts). */
  post_link: string;
  created_at: string;
  sent_at: string | null;
}

/** What a Buffer account can do; replaceable so tests call no real Buffer. */
export interface BufferApi {
  channels: () => Promise<BufferChannel[]>;
  /** Queue an image post; only resolves when Buffer confirms it with a post id. */
  createImagePost: (input: { text: string; channelId: string; imageUrl: string; altText: string; metadata: string }) => Promise<{ id: string; dueAt: string }>;
}

export interface FacebookApi {
  publishPhoto: (input: { pageId: string; image: Buffer; contentType: string; message: string }) => Promise<{ postId: string }>;
  commentOnPost: (input: { pageId: string; postId: string; message: string }) => Promise<{ commentId: string }>;
}

/** Instagram through its Facebook page's API; replaceable so tests call no real Instagram. */
export interface InstagramApi {
  publishInstagram: (input: { pageId: string; igUserId: string; kind: 'image' | 'reel'; mediaUrl: string; caption: string }) => Promise<{ mediaId: string; permalink: string }>;
}

/** Threads through its own API; replaceable so tests call no real Threads. */
export interface ThreadsApi {
  publish: (input: { userId: string; kind: 'image' | 'video'; mediaUrl: string; text: string }) => Promise<{ mediaId: string; permalink: string }>;
}

export const realInstagram = (token: string): InstagramApi => {
  const client = new FacebookClient({ systemUserToken: token });
  return { publishInstagram: (i) => client.publishInstagram(i) };
};

export const realThreads = (token: string): ThreadsApi => {
  const client = new ThreadsClient({ token });
  return { publish: (i) => client.publish(i) };
};

export interface SocialDeps {
  settings: Settings;
  encryptionKey: Buffer;
  ask: (promptName: string, variables: Record<string, unknown>, chat?: string) => Promise<string>;
  dataDir?: string;
  /** Checks that a picture link answers from the internet before Buffer is asked to fetch it. */
  fetchImpl?: Fetch;
  buffer?: (token: string) => BufferApi;
  facebook?: (token: string) => FacebookApi;
  instagram?: (token: string) => InstagramApi;
  threads?: (token: string) => ThreadsApi;
  /** Renews a Threads token that runs out soon; tests pass their own. */
  renewThreads?: Renew;
  /** Makes Instagram's 4:5 copy of a picture; tests pass their own. */
  instagramPicture?: (src: string, out: string) => Promise<void>;
  /** Wakes the picture maker once a social picture is queued. */
  startPictures?: () => void;
  now?: () => number;
  /** Wakes the poster when a waiting post is due; tests pass their own. */
  wakeIn?: (ms: number, wake: () => void) => void;
}

const realBuffer = (token: string): BufferApi => {
  const client = new BufferClient(token);
  return {
    channels: async () => client.getChannels(await client.getOrganizationId()),
    createImagePost: (input) => client.createImagePost(input),
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

/** The fields a post was written with. */
export const postFields = (p: Pick<SocialPostRow, 'fields_json'>): Record<string, string> => {
  try {
    const v = JSON.parse(p.fields_json || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
};

/** The website a keyword belongs to. */
export function websiteOf(seoId: number): NewWebsiteRow | undefined {
  const plan = get<{ website_id: number }>(
    'SELECT k.website_id FROM keyword_seo s JOIN keyword_plans k ON k.id = s.plan_id WHERE s.id = ?',
    seoId,
  );
  return plan ? getNewWebsite(plan.website_id) : undefined;
}

/**
 * Once an article is posted: one social post per channel its website shares
 * on, run by that channel's platform rules. Publishing it again adds nothing
 * new (one post per channel and platform). A channel set to reels only gets
 * no image post.
 */
export function createSocialPosts(seoId: number): number {
  const site = websiteOf(seoId);
  if (!site) return 0;
  const category = getSeoRow(seoId)?.post_category ?? '';
  let added = 0;
  for (const c of websiteChannels(site.id)) {
    if (!c.post_image || videoOnly(c.platform) || !channelTakes(c, category)) continue;
    added += Number(run('INSERT OR IGNORE INTO newsite_social_posts (seo_id, channel_id, kind) VALUES (?, ?, ?)', seoId, c.id, c.platform).changes);
  }
  return added;
}

/** Make a post's words and picture again from the article (not once it went out). */
export function remakeSocialPost(id: number): boolean {
  const item = getSocialPost(id);
  if (!item || item.status === 'sent' || item.status === 'picture') return false;
  if (item.picture_id) run(`DELETE FROM newsite_pictures WHERE id = ? AND status <> 'making'`, item.picture_id);
  run(
    `UPDATE newsite_social_posts SET status = 'pending', title = '', text = '', alt = '', overlay = '', fields_json = '{}', picture_id = NULL, error = '', retry_at = NULL WHERE id = ?`,
    id,
  );
  return true;
}

/** Put a failed post back to work, keeping what it already has. */
export function retrySocialPost(id: number): void {
  run(`UPDATE newsite_social_posts SET status = 'pending', error = '', retry_at = NULL WHERE id = ? AND status = 'failed'`, id);
}

/* -- Checks: the platform's Limits, and the link rule always ----------------- */

const LINKISH = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|co|io|blog|recipes|info)\b|link in (the )?bio/i;
const EMOJI = /\p{Extended_Pictographic}/gu;

const count = {
  chars: (s: string) => s.length,
  words: (s: string) => s.split(/\s+/).filter(Boolean).length,
  emoji: (s: string) => (s.match(EMOJI) ?? []).length,
  hashtags: (s: string) => (s.match(/#[\p{L}\p{N}_]/gu) ?? []).length,
  exclamations: (s: string) => (s.match(/!/g) ?? []).length,
};
const UNIT: Record<keyof typeof count, string> = { chars: 'characters', words: 'words', emoji: 'emoji', hashtags: 'hashtags', exclamations: 'exclamation marks' };

/**
 * Everything wrong with an answer, measured against the rules file: each
 * field present, each limit met, and no link anywhere (the link is never in
 * a post's words, whatever the platform).
 */
export function checkFields(fields: Record<string, string>, rules: PlatformRules, domain: string): string[] {
  const problems: string[] = [];
  for (const f of rules.fields) {
    const value = fields[f] ?? '';
    if (!value) {
      problems.push(`The ${f} is missing; write it.`);
      continue;
    }
    for (const measure of Object.keys(count) as (keyof typeof count)[]) {
      const limit = rules.limits[`${f}_${measure}`];
      if (!limit) continue;
      const n = count[measure](value);
      if (n < limit[0] || n > limit[1]) {
        problems.push(
          limit[1] === 0
            ? `The ${f} has ${n} ${UNIT[measure]}; it must have none.`
            : `The ${f} has ${n} ${UNIT[measure]}; write ${limit[0]} to ${limit[1]}.`,
        );
      }
    }
    if (LINKISH.test(value) || (domain && value.toLowerCase().includes(domain.toLowerCase()))) {
      problems.push(`The ${f} has a link or web address in it. Remove it: the link is never in a post's words.`);
    }
  }
  return problems;
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

/* -- The poster ----------------------------------------------------------- */

interface Work {
  item: SocialPostRow;
  row: SeoRow;
  site: NewWebsiteRow;
  channel: ChannelRow;
  rules: PlatformRules;
}

const fail = (id: number, error: string): void => {
  run(`UPDATE newsite_social_posts SET status = 'failed', error = ? WHERE id = ?`, error.slice(0, 900), id);
};

const articleStart = (md: string): string => md.slice(0, 1500);

/** The article's headings, one per line: what the post must stay about. */
const articleOutline = (md: string): string =>
  md.split('\n').filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '- ')).join('\n') || '- (no headings)';

/**
 * A post's words, written from the article by the platform's rules and
 * checked against its limits. `note` is added to the rules (a reel says it is
 * a video). Shared by image posts and reels.
 */
export async function writePostWords(
  rules: PlatformRules,
  row: SeoRow,
  site: NewWebsiteRow,
  ask: SocialDeps['ask'],
  note = '',
): Promise<{ answer: Record<string, string> | null; problems: string[] }> {
  const out = await correctUntilRight<Record<string, string>>({
    ask: (corrections) =>
      ask('newsite-social-post', {
        language: site.language,
        label: rules.label,
        platformRules: note ? `${rules.text}\n\n${note}` : rules.text,
        fields: rules.fields.join(', '),
        shape: JSON.stringify(Object.fromEntries(rules.fields.map((f) => [f, '...']))),
        title: row.title,
        focusKeyword: row.focus_keyword,
        keyword: row.keyword,
        description: row.description,
        niche: site.niche,
        persona: site.persona,
        articleOutline: articleOutline(row.article_md),
        articleStart: articleStart(row.article_md),
        problemsJson: corrections,
      }, articleChat(row.id)),
    parse: (raw) => {
      const o = parseObject(raw);
      return o ? Object.fromEntries(rules.fields.map((f) => [f, str(o, f)])) : null;
    },
    check: (fields) => checkFields(fields, rules, site.domain),
  });
  return { answer: out.technical ? null : out.answer ?? null, problems: out.problems };
}

/** Step 1: the post's words. */
async function writeFields(w: Work, deps: SocialDeps): Promise<boolean> {
  const { rules } = w;
  const out = await writePostWords(rules, w.row, w.site, deps.ask);
  if (!out.answer) {
    fail(w.item.id, out.problems.join(' '));
    return false;
  }
  const f = out.answer;
  const text = f[rules.postText] ?? '';
  const alt = rules.altField ? f[rules.altField] ?? '' : '';
  const title = f.title ?? '';
  run(`UPDATE newsite_social_posts SET fields_json = ?, text = ?, alt = ?, title = ? WHERE id = ?`, JSON.stringify(f), text, alt, title, w.item.id);
  Object.assign(w.item, { fields_json: JSON.stringify(f), text, alt, title });
  return true;
}

/** The article's own picture descriptions: what a social picture shows. */
function articleScenes(row: SeoRow): { scene: string; detail: string } {
  const set = parseImageSet(row.images_json);
  const prompt = (slot: string) => set?.images.find((im) => im.slot === slot)?.prompt ?? '';
  const scene = prompt('feature') || prompt('serving') || row.title;
  return { scene, detail: prompt('closeup') || prompt('overhead') || scene };
}

/** Step 2: the post's own picture, from the next of the rules' templates for this channel, in the picture queue. */
function queuePicture(w: Work, deps: SocialDeps): void {
  const { rules } = w;
  const context = { ...articleScenes(w.row), ...postFields(w.item), domain: w.site.domain };
  // Pinterest: only the designs picked on the Pinterest pin designs page, in turn. Other platforms: their rules' templates.
  const designs = rules.platform === 'pinterest' ? pickedPinDesigns() : [];
  const count = designs.length || rules.pictureTemplates.length;
  const index = w.channel.next_template % count;
  run('UPDATE newsite_channels SET next_template = next_template + 1 WHERE id = ?', w.channel.id);
  const design = designs[index];
  const prompt = design ? renderDesign(design, context) : loadTemplate(rules.pictureTemplates[index]!, context);
  const slot = `social-${w.item.id}`;
  run(`DELETE FROM newsite_pictures WHERE seo_id = ? AND slot IN (?, ?, ?)`, w.row.id, slot, `pin-${w.item.id}`, `fb-${w.item.id}`);
  const pictureId = Number(
    run(
      `INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, shape) VALUES (?, ?, 1000, ?, ?, 'queued', ?)`,
      w.row.id, slot, prompt, w.item.alt, rules.pictureShape,
    ).lastInsertRowid,
  );
  run(`UPDATE newsite_social_posts SET status = 'picture', picture_id = ?, template = ? WHERE id = ?`, pictureId, design ? design.id : index + 1, w.item.id);
  deps.startPictures?.();
}

/**
 * The board for this keyword, from the boards on the channel's Pinterest
 * account: the AI's pick, or, when none fits, the account's "general" board.
 * None when there is no such board: the pin is not posted.
 */
export async function pickBoard(w: { row: SeoRow; site: NewWebsiteRow }, boards: { serviceId: string; name: string }[], deps: Pick<SocialDeps, 'ask'>) {
  const raw = await deps
    .ask('newsite-pick-board', {
      keyword: w.row.keyword,
      title: w.row.title,
      niche: w.site.niche,
      boardsJson: JSON.stringify(boards.map((b) => b.name)),
    }, articleChat(w.row.id))
    .catch(() => '');
  const name = String(parseObject(raw)?.board ?? '').trim().toLowerCase();
  return boards.find((b) => b.name.toLowerCase() === name) ?? generalBoard(boards);
}

/** The account's catch-all board: the first whose name contains "general". Boards cannot be created from here. */
export const generalBoard = <T extends { name: string }>(boards: T[]): T | undefined => boards.find((b) => /general/i.test(b.name));

/** The error a pin is stopped with when no board fits its keyword and the account has no "general" board; the Dashboard looks for it. */
export const NO_BOARD = 'No Pinterest board fits this keyword, and the account has no board with “general” in its name.';

/**
 * Where Buffer fetches a picture from: this platform itself, by a signed link
 * that expires (the same door the old dashboard's reels use, /media/...).
 */
function pictureLink(picture: PictureRow, deps: SocialDeps, now: number): string {
  const base = deps.settings.get('public_base_url').trim();
  if (!base) {
    throw new Error('This platform has no public address yet, so Buffer cannot fetch the picture. Open the dashboard once at its https address (it is filled in by itself), or set it in Platform settings → Images, then try again.');
  }
  const ext = (picture.file.split('.').pop() ?? 'png').toLowerCase();
  return pictureMediaUrl(base, picture.id, ext, Number(deps.settings.get('reel_media_link_days')), deps.encryptionKey, now);
}

/**
 * Instagram takes a feed picture no taller than 4:5, so it gets its own 4:5
 * JPEG copy, made once beside the picture. Should the copy fail to be made,
 * the picture itself is sent and Buffer says whether Instagram took it.
 */
async function instagramPictureLink(picture: PictureRow, deps: SocialDeps, now: number): Promise<string> {
  const dir = pictureDir(picture.seo_id, deps.dataDir ?? resolveDataDir());
  try {
    await (deps.instagramPicture ?? makeInstagramPicture)(join(dir, picture.file), join(dir, instagramFileOf(picture.file)));
  } catch (err) {
    log.warn(`picture ${picture.id}: no 4:5 copy for Instagram, sending it as it is: ${errorMessage(err)}`);
    return pictureLink(picture, deps, now);
  }
  const base = deps.settings.get('public_base_url').trim();
  if (!base) return pictureLink(picture, deps, now); // says what is missing
  return pictureMediaUrl(base, picture.id, 'jpg', Number(deps.settings.get('reel_media_link_days')), deps.encryptionKey, now, 'ig-picture');
}

/**
 * Buffer fails a post whose picture it cannot download ("Image could not be
 * read from its URL"), so the link is tried first, the way Buffer will try it.
 */
async function checkPictureLink(url: string, deps: SocialDeps, who = 'Buffer'): Promise<void> {
  let status = 0;
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, { method: 'GET', signal: AbortSignal.timeout(20_000) });
    status = res.status;
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && type.startsWith('image/')) return;
  } catch (err) {
    throw new Error(`${who} could not download the picture: ${new URL(url).origin} did not answer (${errorMessage(err)}). Check the public address in Platform settings → Images.`);
  }
  throw new Error(`${who} could not download the picture: ${new URL(url).origin} answered HTTP ${status} instead of the picture. Check the public address in Platform settings → Images, and that /media/ reaches this platform.`);
}

const typeOf = (file: string): string => (file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'image/webp');

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

/**
 * The website's social random gap (gaps.ts): a post or reel due later than
 * now waits for its time, and is sent then. True when it waits.
 */
export function holdForSocialGap(table: 'newsite_social_posts' | 'newsite_reel_shares', id: number, site: NewWebsiteRow, channelId: number, now: number): boolean {
  if (!(site.social_gap_to > 0)) return false;
  const due = socialDueAt(site, channelId, lastSocialSent(site.id, channelId));
  if (due <= now) {
    // Let through: from now on the other sender counts it too.
    claimSocialSlot(site.id, channelId, now);
    return false;
  }
  run(`UPDATE ${table} SET status = 'waiting', retry_at = ?, error = '' WHERE id = ?`, due, id);
  return true;
}

/**
 * The service-specific part of a Buffer post, as GraphQL. Unknown services
 * need none. `type` is Buffer's post type: post for a picture, reel for a video.
 */
export function bufferMetadata(
  platform: string,
  extra: { title: string; url: string; boardServiceId?: string; firstComment: string; type?: 'post' | 'reel' },
): string {
  const q = BufferClient.literal;
  const comment = extra.firstComment ? ` firstComment: ${q(extra.firstComment)}` : '';
  const type = extra.type ?? 'post';
  switch (platform) {
    case 'pinterest':
      return `pinterest: { title: ${q(extra.title)} url: ${q(extra.url)} boardServiceId: ${q(extra.boardServiceId ?? '')} }`;
    case 'facebook':
      return `facebook: { type: ${type}${comment} }`;
    case 'instagram':
      return `instagram: { type: ${type} shouldShareToFeed: true${comment} }`;
    case 'youtube':
      // Buffer needs a title and a category for YouTube: 26 is How-to & Style.
      return `youtube: { title: ${q(extra.title.slice(0, 100))} categoryId: "26" }`;
    case 'linkedin':
      return comment ? `linkedin: {${comment} }` : '';
    default:
      return '';
  }
}

/** Step 3, through Buffer: the confirmed post id and its due time are recorded, nothing less. */
async function sendThroughBuffer(w: Work, picture: PictureRow, deps: SocialDeps, now: number): Promise<void> {
  const api = (deps.buffer ?? realBuffer)(bufferTokenOf(w.channel, deps.encryptionKey));
  try {
    const found = (await api.channels()).find((c) => c.id === w.channel.buffer_channel_id);
    if (!found) throw new Error(`Buffer no longer lists this ${w.rules.label} channel. Check it on the Channels page.`);
    let board: { serviceId: string; name: string } | undefined;
    if (w.channel.platform === 'pinterest') {
      if (!found.boards.length) throw new Error('This Pinterest channel has no boards. Create one on Pinterest first.');
      board = await pickBoard(w, found.boards, deps);
      if (!board) return fail(w.item.id, NO_BOARD);
    }
    // The link, only ever where the rules put it: the pin's own link, or the first comment (paid Buffer plans only).
    const firstComment = w.rules.link === 'first_comment' && w.channel.paid_buffer && !commentsThroughApi(w.channel) ? w.row.post_url : '';
    const url = w.channel.platform === 'instagram' ? await instagramPictureLink(picture, deps, now) : pictureLink(picture, deps, now);
    await checkPictureLink(url, deps);
    const { id, dueAt } = await api.createImagePost({
      text: w.item.text,
      channelId: w.channel.buffer_channel_id,
      imageUrl: url,
      altText: w.item.alt || w.row.title,
      metadata: bufferMetadata(w.channel.platform, {
        title: postFields(w.item).title ?? w.item.title,
        url: w.row.post_url,
        boardServiceId: board?.serviceId,
        firstComment,
      }),
    });
    const note = w.rules.link === 'first_comment' && !w.channel.paid_buffer && !commentsThroughApi(w.channel) ? 'Queued without the link: Buffer’s free plan cannot add a first comment.' : '';
    run(
      `UPDATE newsite_social_posts SET status = 'sent', external_id = ?, due_at = ?, board_name = ?, error = ?, retry_at = NULL, sent_at = datetime('now') WHERE id = ?`,
      id, dueAt, board?.name ?? '', note, w.item.id,
    );
  } catch (err) {
    if (isQueueFull(err)) return waitForRoom(w, err, deps, now);
    fail(w.item.id, errorMessage(err));
  }
}

/** Step 3, through the Facebook API: the photo, then the link as the first comment. */
async function sendThroughFacebook(w: Work, picture: PictureRow, deps: SocialDeps): Promise<void> {
  const api = (deps.facebook ?? realFacebook)(fbTokenOf(w.channel, deps.encryptionKey));
  let postId: string;
  try {
    const data = readFileSync(join(pictureDir(picture.seo_id, deps.dataDir ?? resolveDataDir()), picture.file));
    ({ postId } = await api.publishPhoto({ pageId: w.channel.fb_page_id, image: data, contentType: typeOf(picture.file), message: w.item.text }));
  } catch (err) {
    return fail(w.item.id, errorMessage(err));
  }
  run(`UPDATE newsite_social_posts SET status = 'sent', external_id = ?, post_link = ?, error = '', sent_at = datetime('now') WHERE id = ?`, postId, `https://www.facebook.com/${postId}`, w.item.id);
  if (w.rules.link !== 'first_comment') return;
  try {
    const { commentId } = await api.commentOnPost({ pageId: w.channel.fb_page_id, postId, message: w.row.post_url });
    run('UPDATE newsite_social_posts SET comment_id = ? WHERE id = ?', commentId, w.item.id);
  } catch (err) {
    run('UPDATE newsite_social_posts SET error = ? WHERE id = ?', `Posted, but the link comment failed: ${errorMessage(err).slice(0, 300)}`, w.item.id);
  }
}

/**
 * Step 3, through Instagram's or Threads' own API: both fetch the picture
 * from its public link (the 4:5 JPEG copy, which both take), post it, and say
 * where the post is.
 */
async function sendThroughMetaApi(w: Work, picture: PictureRow, deps: SocialDeps, now: number): Promise<void> {
  const who = w.rules.label;
  try {
    const url = await instagramPictureLink(picture, deps, now);
    await checkPictureLink(url, deps, who);
    const posted =
      w.channel.platform === 'instagram'
        ? await (deps.instagram ?? realInstagram)(fbTokenOf(w.channel, deps.encryptionKey)).publishInstagram({
            pageId: w.channel.fb_page_id, igUserId: w.channel.api_account_id, kind: 'image', mediaUrl: url, caption: w.item.text,
          })
        : await (deps.threads ?? realThreads)(await threadsTokenOf(w.channel, deps.encryptionKey, deps.renewThreads)).publish({
            userId: w.channel.api_account_id, kind: 'image', mediaUrl: url, text: w.item.text,
          });
    run(
      `UPDATE newsite_social_posts SET status = 'sent', external_id = ?, post_link = ?, error = '', sent_at = datetime('now') WHERE id = ?`,
      posted.mediaId, posted.permalink, w.item.id,
    );
  } catch (err) {
    fail(w.item.id, errorMessage(err));
  }
}

/** One post, one step further: words, then picture, then sending. */
async function work(item: SocialPostRow, deps: SocialDeps, now: number): Promise<void> {
  const row = getSeoRow(item.seo_id);
  const channel = getChannel(item.channel_id);
  const site = row ? websiteOf(row.id) : undefined;
  if (!row || !channel || !site) return fail(item.id, 'Its article, website or channel is gone.');
  if (row.post_status !== 'published' || !row.post_url) return fail(item.id, 'The article is not published on the website yet.');
  if (!websiteChannels(site.id).some((c) => c.id === channel.id && c.post_image && channelTakes(c, row.post_category))) {
    // The website no longer sends image posts there (or not of this category): it is dropped, never sent.
    run('DELETE FROM newsite_social_posts WHERE id = ?', item.id);
    return;
  }
  // The channel's own rules, read fresh every time: a saved edit counts from the next post on.
  const check = channelRules(channel);
  if (!check.rules) return fail(item.id, `${check.file} have problems (open the channel and click Edit rules): ${check.errors.join(' ')}`);
  const w: Work = { item, row, site, channel, rules: check.rules };

  if (!item.text && !(await writeFields(w, deps))) return;
  const picture = item.picture_id ? get<PictureRow>('SELECT * FROM newsite_pictures WHERE id = ?', item.picture_id) : undefined;
  if (!picture || picture.status !== 'done') return queuePicture(w, deps);
  if (holdForSocialGap('newsite_social_posts', item.id, site, channel.id, now)) return;
  if (channel.via === 'buffer') return sendThroughBuffer(w, picture, deps, now);
  if (channel.platform === 'facebook') return sendThroughFacebook(w, picture, deps);
  if (channel.platform === 'instagram' || channel.platform === 'threads') return sendThroughMetaApi(w, picture, deps, now);
  return fail(item.id, `Posting to ${w.rules.label} through its own API is not built; connect it through Buffer.`);
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
      // A post whose picture is gone, finished or failed while nobody was
      // listening (a restart) goes back to work: it makes a new picture or
      // sends the finished one.
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

/** A social post's picture is made (or failed): its post carries on. */
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
