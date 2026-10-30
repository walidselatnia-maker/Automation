import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { ImageClient } from '../integrations/images.js';
import { createLogger } from '../lib/logger.js';
import { reelSceneMediaUrl } from '../core/media-links.js';
import type { Settings } from '../settings.js';
import { withGoogleAccount } from './google-accounts.js';
import { flowProjectFor } from './pictures.js';
import { getKeywordPlan, getNewWebsite, type NewWebsiteRow } from './repo.js';
import { getSeoRow, type SeoRow } from './seo.js';
import { pictureStyleFor } from './images.js';
import { articlePictureStyle } from './style-library.js';
import { correctUntilRight } from './rounds.js';
import { editReel } from './reel-edit.js';
import { pickMusic } from './music.js';
import { articleParts, articleReferences, reelDir, reelRules, withDomain, type ReelDeps, type ReelRow } from './reels.js';

/**
 * A long reel: one story of 30 to 90 seconds told in scenes, each scene one
 * picture brought to life as one Flow clip (4, 6 or 8 seconds), then the clips
 * edited together with music and subtitles (reel-edit.ts).
 *
 * The AI writes the story once, then every scene's picture prompt and every
 * scene's clip prompt in a call of its own: one call for all of them mixes the
 * scenes up. The narrator's words go into each clip's prompt with the same
 * full description of the voice, so Flow speaks them and every clip sounds
 * like the same person. The subtitles are those words, written by the
 * platform, never by the AI.
 *
 * Every step is kept as it is done, so a reel stopped half way (a restart, a
 * failed clip) goes on from where it stopped, and a Flow job already sent is
 * waited for again rather than paid for twice.
 */

const log = createLogger('newsite-long-reels');

/** The reel lengths a website can pick. */
export const LONG_REEL_SECONDS = [30, 45, 60, 90] as const;
export const DEFAULT_LONG_REEL_SECONDS = 60;
/** The clip lengths Flow makes. */
export const CLIP_SECONDS = [4, 6, 8] as const;
const FAILED = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);
/** The labels every clip prompt has, in order. */
export const CLIP_LABELS = [
  'SCENE', 'SUBJECT', 'ACTION', 'CAMERA', 'ANGLE', 'MOVEMENT', 'FOREGROUND', 'MIDGROUND',
  'BACKGROUND', 'FOCUS', 'LIGHTING', 'SHADOWS', 'ATMOSPHERE', 'SOUND', 'CONTINUITY', 'AVOID',
] as const;
const BANNED = /slow[- ]?motion|slowly|cinematic|masterpiece|\b8k\b|hyper-detailed/i;

export type ReelKind = 'short' | 'long';
export const reelKindKey = (websiteId: number): string => `newsite_reel_kind_${websiteId}`;
export const reelSecondsKey = (websiteId: number): string => `newsite_reel_seconds_${websiteId}`;
export const reelKindFor = (settings: Settings, websiteId: number): ReelKind => (settings.get(reelKindKey(websiteId)) === 'long' ? 'long' : 'short');
export function reelSecondsFor(settings: Settings, websiteId: number): number {
  const n = Number(settings.get(reelSecondsKey(websiteId)));
  return (LONG_REEL_SECONDS as readonly number[]).includes(n) ? n : DEFAULT_LONG_REEL_SECONDS;
}

export interface SceneRow {
  id: number;
  reel_id: number;
  position: number;
  seconds: number;
  purpose: string;
  subject: string;
  action: string;
  setting: string;
  link: string;
  script: string;
  picture_prompt: string;
  picture_job: string;
  picture_file: string;
  /** The picture's Flow media id, and the Flow project it is in. */
  picture_media: string;
  picture_project: string;
  video_prompt: string;
  video_job: string;
  video_file: string;
}

export interface StoryScene {
  seconds: number;
  purpose: string;
  subject: string;
  action: string;
  setting: string;
  link: string;
  script: string;
}

export interface Story {
  hook: string;
  voice: string;
  closing_line: string;
  caption: string;
  scenes: StoryScene[];
}

/** Flow, for a long reel's pictures and clips. Tests pass their own. */
export interface LongReelFlow {
  /** `referenceMediaIds`: beside each url, its Flow media id when it is in this project already ('' when not). */
  submitPicture(input: { prompt: string; referenceUrls: string[]; referenceMediaIds: string[]; projectId: string }): Promise<string>;
  submitClip(input: { prompt: string; referenceUrls: string[]; referenceMediaIds: string[]; projectId: string; seconds: number }): Promise<string>;
  poll(jobId: string): Promise<{ status?: string; image_url?: string | null; video_url?: string | null; media_id?: string | null; error?: string | null }>;
}

/** Where a long reel's scene pictures and clips are kept. */
export const sceneDir = (reelId: number, dataDir = resolveDataDir()): string => join(reelDir(dataDir), `long-${reelId}`);
export const listScenes = (reelId: number): SceneRow[] =>
  all<SceneRow>('SELECT * FROM newsite_reel_scenes WHERE reel_id = ? ORDER BY position', reelId);
const getScene = (id: number): SceneRow => get<SceneRow>('SELECT * FROM newsite_reel_scenes WHERE id = ?', id)!;

/** A long reel to make from the start again: its scenes and files go. */
export function clearLongReel(reelId: number, dataDir?: string): void {
  run('DELETE FROM newsite_reel_scenes WHERE reel_id = ?', reelId);
  run(`UPDATE newsite_reels SET story_json = '', stage = '' WHERE id = ?`, reelId);
  rmSync(sceneDir(reelId, dataDir), { recursive: true, force: true });
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

function parseJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseStory(raw: string): Story | null {
  const o = parseJson(raw);
  if (!o || !Array.isArray(o.scenes)) return null;
  return {
    hook: clean(o.hook),
    voice: clean(o.voice),
    closing_line: clean(o.closing_line),
    caption: typeof o.caption === 'string' ? o.caption.trim() : '',
    scenes: (o.scenes as Record<string, unknown>[]).map((s) => ({
      seconds: Number(s?.seconds) || 0,
      purpose: clean(s?.purpose),
      subject: clean(s?.subject),
      action: clean(s?.action),
      setting: clean(s?.setting),
      link: clean(s?.link),
      script: clean(s?.script),
    })),
  };
}

/** What is checked in a story before anything is made from it. */
export function checkStory(story: Story, seconds: number, domain: string, closing = ''): string[] {
  const problems: string[] = [];
  const scenes = story.scenes;
  if (scenes.length < 2) problems.push('Write at least 2 scenes.');
  const total = scenes.reduce((a, s) => a + s.seconds, 0);
  if (total !== seconds) problems.push(`The scenes' seconds add up to ${total}; they must add up to exactly ${seconds}.`);
  scenes.forEach((s, i) => {
    const n = i + 1;
    if (!(CLIP_SECONDS as readonly number[]).includes(s.seconds)) problems.push(`Scene ${n}: "seconds" must be 4, 6 or 8 (it is ${s.seconds}).`);
    for (const key of ['purpose', 'subject', 'action', 'setting', 'script'] as const) {
      if (!s[key]) problems.push(`Scene ${n}: "${key}" is empty.`);
    }
    const most = s.seconds * 2;
    if (s.script && words(s.script) > most) problems.push(`Scene ${n}: the script has ${words(s.script)} words; a ${s.seconds}-second scene takes at most ${most}.`);
  });
  if (!story.hook) problems.push('The "hook" is empty.');
  if (words(story.voice) < 20) problems.push('Describe the "voice" fully, in at least 20 words: gender, age, accent, tone, pace, warmth.');
  if (!story.closing_line) problems.push('The "closing_line" is empty.');
  else if (closing && story.closing_line !== closing) problems.push(`The "closing_line" must be exactly: "${closing}".`);
  else if (domain && !story.closing_line.toLowerCase().includes(domain.toLowerCase())) problems.push(`The "closing_line" must name the website: ${domain}.`);
  const last = scenes.at(-1);
  if (last && story.closing_line && !last.script.includes(story.closing_line)) problems.push('The last scene\'s script must end with the closing_line, word for word.');
  if (!story.caption) problems.push('The "caption" is empty.');
  return problems;
}

/** What is checked in a scene's picture prompt. */
export function checkPicturePrompt(prompt: string): string[] {
  const problems: string[] = [];
  if (prompt.length < 150) problems.push(`The prompt is ${prompt.length} characters; describe the picture fully (at least 150).`);
  if (prompt.length > 2500) problems.push(`The prompt is ${prompt.length} characters; at most 2500.`);
  if (BANNED.test(prompt)) problems.push('The prompt uses a banned word (slow motion, slowly, cinematic, masterpiece, 8k, hyper-detailed).');
  return problems;
}

/** What is checked in a scene's clip prompt: every label, in order, no banned words. */
export function checkClipPrompt(prompt: string): string[] {
  const problems: string[] = [];
  let at = -1;
  const missing: string[] = [];
  for (const label of CLIP_LABELS) {
    const found = prompt.search(new RegExp(`(^|\\n)\\s*${label}:`));
    if (found < 0) missing.push(label);
    else if (found < at) problems.push(`The line ${label}: is out of order; keep the order asked for.`);
    else at = found;
  }
  if (missing.length) problems.push(`The prompt must have a line for each label; missing: ${missing.join(', ')}.`);
  if (BANNED.test(prompt.replace(/AVOID:[^\n]*/i, ''))) problems.push('The prompt uses a banned word (slow motion, slowly, cinematic, masterpiece, 8k, hyper-detailed).');
  if (/^\s*(VOICE|NARRATOR|SPOKEN|DIALOGUE)\s*:/im.test(prompt)) problems.push('Write no spoken words and no voice line: the platform adds them.');
  if (prompt.length > 3800) problems.push(`The prompt is ${prompt.length} characters; at most 3800.`);
  return problems;
}

/** The clip prompt Flow gets: the AI's lines, then the voice and its words, the same way in every clip. */
export function clipPrompt(aiPrompt: string, voice: string, script: string, language: string): string {
  const lang = language && language !== 'English' ? ` in ${language}` : '';
  return [
    aiPrompt.trim(),
    `VOICE: an off-screen narrator, the same voice in every clip of this reel: ${voice}`,
    `SPOKEN${lang}, word for word, at a natural pace over the clip: "${script.replace(/"/g, "'")}"`,
    'No text, captions or subtitles on screen.',
  ].join('\n');
}

const storyboardOf = (scenes: SceneRow[]): string =>
  scenes.map((s) => `${s.position}. (${s.seconds}s) ${s.purpose} Subject: ${s.subject}. Action: ${s.action}. Setting: ${s.setting}.`).join('\n');
const sceneText = (s: SceneRow): string =>
  [`Seconds: ${s.seconds}`, `Purpose: ${s.purpose}`, `Subject: ${s.subject}`, `Action: ${s.action}`, `Setting: ${s.setting}`, `Link: ${s.link || '-'}`, `Spoken words: "${s.script}"`].join('\n');
const neighbour = (s: SceneRow | undefined, none: string): string => (s ? `${s.purpose} ${s.action}` : none);

/** The kind of picture Flow sent, from its first bytes. */
export function pictureExt(data: Buffer): string {
  if (data.subarray(0, 4).toString('hex') === '89504e47') return 'png';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return 'jpg';
}

const defaultDownload = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`a file could not be downloaded from Flow (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
};

function flowOf(settings: Settings): LongReelFlow {
  const options = {
    baseUrl: settings.get('image_base_url'),
    apiKey: settings.get('image_api_key'),
    pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
    maxAttempts: settings.getNumber('image_poll_max_attempts'),
  };
  const shared = new ImageClient(options);
  return {
    submitPicture: ({ prompt, referenceUrls, referenceMediaIds, projectId }) =>
      new ImageClient({ ...options, projectId, imageModel: settings.get('image_model') }).submit(prompt, 'VERTICAL', { referenceUrls, referenceMediaIds }),
    submitClip: ({ prompt, referenceUrls, referenceMediaIds, projectId, seconds }) =>
      shared.submitVideo({ prompt, referenceUrls, referenceMediaIds, projectId, videoMode: 'frames', seconds }),
    poll: (jobId) => shared.poll(jobId),
  };
}

interface Ctx {
  reel: ReelRow;
  row: SeoRow;
  site: NewWebsiteRow;
  deps: ReelDeps;
  flow: LongReelFlow;
  projectId: string;
}

const setStage = (reelId: number, stage: string): void => {
  run('UPDATE newsite_reels SET stage = ? WHERE id = ?', stage, reelId);
};

/**
 * Ask the AI until its answer passes the checks. `strict`: an answer still
 * wrong after every round stops the reel (the story: its seconds and words are
 * what everything after is built on); otherwise the best answer is kept.
 */
async function askChecked<T>(ctx: Ctx, name: string, vars: Record<string, unknown>, parse: (raw: string) => T | null, check: (t: T) => string[], what: string, strict = false): Promise<T> {
  const ask = ctx.deps.ask;
  if (!ask) throw new Error('No AI to write the reel.');
  const out = await correctUntilRight<T>({
    ask: (corrections) => ask(name, { language: ctx.site.language, ...vars, problemsJson: corrections }),
    parse,
    check,
  });
  if (out.technical || !out.answer || (strict && out.problems.length)) throw new Error(`${what} could not be written: ${out.problems.join(' ')}`);
  if (out.problems.length) log.warn(`reel ${ctx.reel.id}: ${what} kept with: ${out.problems.join(' ')}`);
  return out.answer;
}

const promptOnly = (raw: string): string | null => {
  const o = parseJson(raw);
  return o && typeof o.prompt === 'string' && o.prompt.trim() ? o.prompt.trim() : null;
};

/** The story and its scenes, written once. */
async function writeStory(ctx: Ctx, described: string): Promise<void> {
  const { reel, row, site, deps } = ctx;
  const seconds = reelSecondsFor(deps.settings, site.id);
  const closing = /closing line, word for word: "([^"]+)"/i.exec(withDomain(reelRules(deps.settings), site.domain))?.[1] ?? '';
  const parts = articleParts(row);
  const story = await askChecked<Story>(
    ctx,
    'newsite-reel-story',
    {
      seconds,
      domain: site.domain,
      title: row.title || row.keyword,
      keyword: row.keyword,
      niche: site.niche,
      nicheContext: site.niche_context || '(none)',
      steps: parts.steps,
      things: parts.things,
      articleOutline: row.article_md.split('\n').filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '- ')).join('\n') || '- (no headings)',
      references: described,
    },
    parseStory,
    (s) => checkStory(s, seconds, site.domain, closing),
    'The reel story',
    true,
  );
  run('DELETE FROM newsite_reel_scenes WHERE reel_id = ?', reel.id);
  story.scenes.forEach((s, i) =>
    run(
      `INSERT INTO newsite_reel_scenes (reel_id, position, seconds, purpose, subject, action, setting, link, script) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reel.id, i + 1, s.seconds, s.purpose, s.subject, s.action, s.setting, s.link, s.script,
    ),
  );
  run(
    `UPDATE newsite_reels SET story_json = ?, hook = ?, closing = ?, prompt = ? WHERE id = ?`,
    JSON.stringify(story), story.hook, story.closing_line, storyboardOf(listScenes(reel.id)), reel.id,
  );
  log.info(`reel ${reel.id}: story of ${story.scenes.length} scenes, ${seconds}s`);
}

interface Made {
  url: string;
  /** Its media id in the Flow project it was made in. */
  mediaId: string;
}

/** Wait for a Flow job and hand back its file's address and media id. */
async function waitFor(ctx: Ctx, jobId: string, everyMs: number, tries: number, what: string): Promise<Made> {
  const sleep = ctx.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0, unreachable = 0; i < tries; i++) {
    await sleep(everyMs);
    let job: Awaited<ReturnType<LongReelFlow['poll']>>;
    try {
      job = await ctx.flow.poll(jobId);
      unreachable = 0;
    } catch (err) {
      // The image service restarting (a deploy) is not Flow saying no: the
      // job is still in its queue, so it is asked again, for a while.
      if (++unreachable >= 20) throw err;
      log.warn(`reel ${ctx.reel.id}: could not ask after ${what} (${(err as Error).message}); asking again`);
      continue;
    }
    const status = (job.status ?? '').toUpperCase();
    const url = job.video_url || job.image_url;
    if (status === 'COMPLETED' && url) return { url, mediaId: job.media_id ?? '' };
    if (FAILED.has(status)) throw new Error(`Flow could not make ${what}: ${job.error ?? status}`);
  }
  throw new Error(`Flow took more than ${Math.round((everyMs * tries) / 60_000)} minutes to make ${what}.`);
}

/**
 * `send`, asked again while the image service cannot be reached at all (it
 * is restarting: a deploy) rather than failing the reel for it.
 */
async function untilReachable<T>(ctx: Ctx, send: () => Promise<T>, what: string): Promise<T> {
  const sleep = ctx.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await send();
    } catch (err) {
      const message = (err as Error).message;
      if (i >= 20 || !/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(message)) throw err;
      log.warn(`reel ${ctx.reel.id}: could not send ${what} (${message}); trying again`);
      await sleep(15_000);
    }
  }
}

/**
 * One Flow job for a scene: the one already sent when there is one (after a
 * restart), else a new one on the first working Google account.
 */
async function flowJob(
  ctx: Ctx,
  scene: SceneRow,
  column: 'picture_job' | 'video_job',
  submit: (projectId: string) => Promise<string>,
  everyMs: number,
  tries: number,
  what: string,
): Promise<Made> {
  const sent = scene[column];
  if (sent) {
    try {
      return await waitFor(ctx, sent, everyMs, tries, what);
    } catch (err) {
      log.warn(`reel ${ctx.reel.id}: ${what} sent before did not come (${(err as Error).message}); sending it again`);
      run(`UPDATE newsite_reel_scenes SET ${column} = '' WHERE id = ?`, scene.id);
    }
  }
  return withGoogleAccount(
    ctx.projectId,
    async (projectId) => {
      const jobId = await untilReachable(ctx, () => submit(projectId), what);
      run(`UPDATE newsite_reel_scenes SET ${column} = ? WHERE id = ?`, jobId, scene.id);
      if (column === 'picture_job') run('UPDATE newsite_reel_scenes SET picture_project = ? WHERE id = ?', projectId, scene.id);
      try {
        return await waitFor(ctx, jobId, everyMs, tries, what);
      } catch (err) {
        // Flow said no: the next try sends it again. A job that only took
        // long is kept, and waited for again next time.
        if (/^Flow could not make/.test((err as Error).message)) run(`UPDATE newsite_reel_scenes SET ${column} = '' WHERE id = ?`, scene.id);
        throw err;
      }
    },
    ctx.deps.now,
  );
}

/**
 * A scene picture's Flow media id when it is in this project, so Flow uses it
 * as it is; '' when it was made on another account's project (it is then
 * fetched by its link and uploaded).
 */
const inProject = (scene: SceneRow, projectId: string): string =>
  scene.picture_media && scene.picture_project === projectId ? scene.picture_media : '';

function sceneUrl(ctx: Ctx, scene: SceneRow): string {
  const base = ctx.deps.settings.get('public_base_url').trim();
  const days = Number(ctx.deps.settings.get('reel_media_link_days')) || 7;
  const ext = scene.picture_file.split('.').pop() ?? 'jpg';
  return reelSceneMediaUrl(base, scene.id, ext, days, ctx.deps.encryptionKey, (ctx.deps.now ?? Date.now)());
}

/** Make a long reel, or go on with one stopped half way. */
export async function makeLongReel(reel: ReelRow, deps: ReelDeps): Promise<void> {
  const row = getSeoRow(reel.seo_id);
  const plan = row ? getKeywordPlan(row.plan_id) : undefined;
  const site = plan ? getNewWebsite(plan.website_id) : undefined;
  if (!row || !site) throw new Error('Its article is gone.');
  run(`UPDATE newsite_reels SET kind = 'long', status = 'making', error = '' WHERE id = ?`, reel.id);
  const project = flowProjectFor(site.project_id, site.domain, deps.settings);
  const ctx: Ctx = { reel, row, site, deps, flow: deps.longFlow ?? flowOf(deps.settings), projectId: project.projectId };
  const refs = articleReferences(reel.seo_id, deps);
  const dir = sceneDir(reel.id, deps.dataDir);
  mkdirSync(dir, { recursive: true });
  const download = deps.download ?? defaultDownload;

  // 1. The story.
  if (!get<{ n: number }>('SELECT COUNT(*) AS n FROM newsite_reel_scenes WHERE reel_id = ?', reel.id)?.n || !getStory(reel.id)) {
    setStage(reel.id, 'story');
    await writeStory(ctx, refs.described);
  }
  const story = getStory(reel.id)!;
  let scenes = listScenes(reel.id);
  const storyboard = storyboardOf(scenes);
  const style = articlePictureStyle(reel.seo_id);
  const pictureStyle = style ? style.description || style.name : pictureStyleFor(site, Boolean(row.recipe_json));

  // 2. One picture prompt per scene, one call each.
  setStage(reel.id, 'pictures');
  for (const scene of scenes) {
    if (scene.picture_prompt) continue;
    const i = scene.position - 1;
    const prompt = await askChecked<string>(
      ctx,
      'newsite-reel-scene-picture',
      {
        title: row.title || row.keyword,
        niche: site.niche,
        position: scene.position,
        count: scenes.length,
        storyboard,
        scene: sceneText(scene),
        previous: neighbour(scenes[i - 1], 'none, this is the first scene'),
        next: neighbour(scenes[i + 1], 'none, this is the last scene'),
        reference: scene.position === 1
          ? 'Reference: the article\'s own photo of the subject is sent along. The subject looks exactly like it.'
          : 'References: the first scene\'s picture and the article\'s own photo are sent along. The subject, the objects and the place are exactly as in them.',
        pictureStyle,
      },
      promptOnly,
      checkPicturePrompt,
      `The picture prompt of scene ${scene.position}`,
    );
    run('UPDATE newsite_reel_scenes SET picture_prompt = ? WHERE id = ?', prompt, scene.id);
  }

  // 3. The pictures: scene 1 from the article's photo, the rest from scene 1 and that photo.
  scenes = listScenes(reel.id);
  for (const scene of scenes) {
    if (scene.picture_file) continue;
    const first = scene.position === 1 ? undefined : getScene(scenes[0]!.id);
    const fromFirst = first?.picture_file ? [first] : [];
    const referenceUrls = [...fromFirst.map((s) => sceneUrl(ctx, s)), refs.urls[0]!];
    const made = await flowJob(
      ctx,
      scene,
      'picture_job',
      (projectId) =>
        ctx.flow.submitPicture({ prompt: scene.picture_prompt, referenceUrls, referenceMediaIds: [...fromFirst.map((s) => inProject(s, projectId)), ''], projectId }),
      5_000,
      120,
      `the picture of scene ${scene.position}`,
    );
    const data = await download(made.url);
    const file = `scene-${scene.position}.${pictureExt(data)}`;
    writeFileSync(join(dir, file), data);
    run('UPDATE newsite_reel_scenes SET picture_file = ?, picture_media = ? WHERE id = ?', file, made.mediaId, scene.id);
    log.info(`reel ${reel.id}: picture of scene ${scene.position} of ${scenes.length}`);
  }

  // 4. One clip prompt per scene, one call each.
  setStage(reel.id, 'clips');
  scenes = listScenes(reel.id);
  for (const scene of scenes) {
    if (scene.video_prompt) continue;
    const i = scene.position - 1;
    const lines = await askChecked<string>(
      ctx,
      'newsite-reel-scene-video',
      {
        title: row.title || row.keyword,
        niche: site.niche,
        position: scene.position,
        count: scenes.length,
        seconds: scene.seconds,
        storyboard,
        scene: sceneText(scene),
        picturePrompt: scene.picture_prompt,
        previous: neighbour(scenes[i - 1], 'none, this is the first scene'),
        next: neighbour(scenes[i + 1], 'none, this is the last scene'),
      },
      promptOnly,
      checkClipPrompt,
      `The clip prompt of scene ${scene.position}`,
    );
    run('UPDATE newsite_reel_scenes SET video_prompt = ? WHERE id = ?', clipPrompt(lines, story.voice, scene.script, site.language), scene.id);
  }

  // 5. The clips, each from its scene's picture as the first frame.
  scenes = listScenes(reel.id);
  for (const scene of scenes) {
    if (scene.video_file) continue;
    const made = await flowJob(
      ctx,
      scene,
      'video_job',
      (projectId) =>
        ctx.flow.submitClip({
          prompt: scene.video_prompt,
          referenceUrls: [sceneUrl(ctx, scene)],
          referenceMediaIds: [inProject(scene, projectId)],
          projectId,
          seconds: scene.seconds,
        }),
      15_000,
      100,
      `the clip of scene ${scene.position}`,
    );
    const file = `clip-${scene.position}.mp4`;
    writeFileSync(join(dir, file), await download(made.url));
    run('UPDATE newsite_reel_scenes SET video_file = ? WHERE id = ?', file, scene.id);
    log.info(`reel ${reel.id}: clip of scene ${scene.position} of ${scenes.length}`);
  }

  // 6. The edit.
  setStage(reel.id, 'edit');
  scenes = listScenes(reel.id);
  const file = `reel-${reel.id}.mp4`;
  await (deps.edit ?? editReel)({
    scenes: scenes.map((s) => ({ file: join(dir, s.video_file), seconds: s.seconds, script: s.script })),
    music: pickMusic(deps.dataDir),
    closing: story.closing_line,
    out: join(reelDir(deps.dataDir), file),
    workDir: dir,
  });
  run(`UPDATE newsite_reels SET status = 'done', stage = 'done', file = ?, error = '', done_at = datetime('now') WHERE id = ?`, file, reel.id);
  log.info(`reel ${reel.id}: long reel made, ${scenes.length} scenes`);
}

export function getStory(reelId: number): Story | null {
  const raw = get<{ story_json: string }>('SELECT story_json FROM newsite_reels WHERE id = ?', reelId)?.story_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Story;
  } catch {
    return null;
  }
}

/** How far a long reel is, for its card: "Clips 3 of 9". */
export function longReelProgress(reelId: number, stage: string): string {
  const scenes = listScenes(reelId);
  const n = scenes.length;
  if (stage === 'story' || !n) return 'Story';
  if (stage === 'pictures') return `Pictures ${scenes.filter((s) => s.picture_file).length} of ${n}`;
  if (stage === 'clips') return `Clips ${scenes.filter((s) => s.video_file).length} of ${n}`;
  if (stage === 'edit') return 'Edit';
  return `${n} scenes`;
}
