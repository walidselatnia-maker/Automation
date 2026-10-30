import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { createReels, getReel, kickReels, listPlanReels, remakeReel, type ReelDeps } from '../src/newsite/reels.js';
import {
  CLIP_LABELS, checkClipPrompt, checkStory, clipPrompt, listScenes, reelKindKey, reelSecondsKey, type LongReelFlow, type Story,
} from '../src/newsite/long-reels.js';
import type { EditInput } from '../src/newsite/reel-edit.js';
import { addMusic, deleteMusic, listMusic, pickMusic, setMusicUsed } from '../src/newsite/music.js';
import { registerSocialRoutes } from '../src/newsite/social-routes.js';

const KEY = randomBytes(32);
const PROMPTS = resolve('./prompts');
const CLOSING = 'Full recipe on f.longlivo.com.';

const VOICE = 'A warm French woman in her thirties, soft Parisian accent, calm and friendly, medium pace, smiling as she speaks, close to the microphone, like a friend in her kitchen.';
const story = (seconds: number[]): Story => ({
  hook: 'Ce gâteau se fait sans four',
  voice: VOICE,
  closing_line: CLOSING,
  caption: 'Un gâteau sans four. #recette',
  scenes: seconds.map((s, i) => ({
    seconds: s,
    purpose: `Scene ${i + 1} of the cake story.`,
    subject: 'A strawberry cream cake on a white plate',
    action: 'A hand lifts a slice at natural speed',
    setting: 'A bright kitchen counter, morning light from the left',
    link: 'Follows the scene before',
    script: i === seconds.length - 1 ? `Regardez bien. ${CLOSING}` : 'Ce gâteau se fait sans four',
  })),
});
const clipLines = CLIP_LABELS.map((l) => `${l}: the ${l.toLowerCase()} of this scene, described fully.`).join('\n');

describe('long reels: a story in scenes, one picture and one clip each, edited together', () => {
  let settings: Settings;
  let dataDir: string;
  let seoId: number;
  let planId: number;
  let websiteId: number;
  let asked: string[];
  let pictures: { prompt: string; referenceUrls: string[]; referenceMediaIds: string[] }[];
  let clips: { prompt: string; referenceUrls: string[]; referenceMediaIds: string[]; seconds: number }[];
  let edits: EditInput[];
  let failClip: number;

  const flow = (): LongReelFlow => ({
    submitPicture: async (input) => {
      pictures.push(input);
      return `pic-${pictures.length}`;
    },
    submitClip: async (input) => {
      clips.push(input);
      return `clip-${clips.length}`;
    },
    poll: async (jobId) => {
      if (jobId === `clip-${failClip}`) return { status: 'FAILED', error: 'policy' };
      return jobId.startsWith('pic')
        ? { status: 'COMPLETED', image_url: `https://flow/${jobId}.png`, media_id: `media-${jobId}` }
        : { status: 'COMPLETED', video_url: `https://flow/${jobId}.mp4` };
    },
  });
  const deps = (): ReelDeps => ({
    settings,
    encryptionKey: KEY,
    dataDir,
    ask: async (name) => {
      asked.push(name);
      if (name === 'newsite-reel-story') return JSON.stringify(story([8, 8, 8, 6]));
      if (name === 'newsite-reel-scene-picture') return JSON.stringify({ prompt: `A photorealistic vertical photograph of a strawberry cream cake on a white plate on a bright kitchen counter, morning light from the left, phone camera at eye level. ${'Detail. '.repeat(10)}` });
      return JSON.stringify({ prompt: clipLines });
    },
    sleep: async () => {},
    download: async (url) => (url.endsWith('.png') ? Buffer.from('89504e470d0a1a0a', 'hex') : Buffer.from('mp4')),
    longFlow: flow(),
    edit: async (input) => {
      edits.push(input);
    },
    onDone: () => {},
  });

  beforeEach(() => {
    configurePrompts(PROMPTS);
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('public_base_url', 'https://dash.example.com');
    websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    settings.set(reelKindKey(websiteId), 'long');
    settings.set(reelSecondsKey(websiteId), '30');
    planId = saveKeywordPlan(websiteId, 'strawberry cake', [], 'recipe');
    queuePlanSeo(planId, 'strawberry cake', [], 'recipe');
    seoId = listPlanSeo(planId)[0]!.id;
    run(`UPDATE keyword_seo SET status = 'done', title = 'Strawberry Cake', post_status = 'published', post_url = 'https://f.longlivo.com/x' WHERE id = ?`, seoId);
    run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, file) VALUES (?, 'feature', 1, 'p', 'a', 'done', 'feature.png')`, seoId);
    dataDir = mkdtempSync(join(tmpdir(), 'long-reels-'));
    asked = [];
    pictures = [];
    clips = [];
    edits = [];
    failClip = 0;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('checks the story: the length, 4/6/8-second scenes, words that fit, the voice and the closing line', () => {
    expect(checkStory(story([8, 6, 6]), 20, 'f.longlivo.com', CLOSING)).toEqual([]);
    const bad = story([5, 6, 6]);
    bad.voice = 'warm';
    bad.scenes[1]!.script = 'un deux trois quatre cinq six sept huit neuf dix onze douze treize';
    const problems = checkStory(bad, 20, 'f.longlivo.com', CLOSING).join(' ');
    expect(problems).toContain('add up to 17');
    expect(problems).toContain('must be 4, 6 or 8');
    expect(problems).toContain('at most 12');
    expect(problems).toContain('at least 20 words');
  });

  it('checks a clip prompt has every label and no spoken words of its own', () => {
    expect(checkClipPrompt(clipLines)).toEqual([]);
    expect(checkClipPrompt(clipLines.replace(/LIGHTING:[^\n]*\n/, '')).join(' ')).toContain('missing: LIGHTING');
    expect(checkClipPrompt(`${clipLines}\nVOICE: someone`).join(' ')).toContain('no spoken words');
  });

  it('puts the same voice and the scene\'s own words in every clip prompt', () => {
    const p = clipPrompt(clipLines, VOICE, 'Regardez "bien"', 'French');
    expect(p).toContain(`VOICE: an off-screen narrator, the same voice in every clip of this reel: ${VOICE}`);
    expect(p).toContain('SPOKEN in French, word for word');
    expect(p).toContain('"Regardez \'bien\'"');
  });

  it('makes a long reel: story, a picture and a clip per scene, one AI call each, then the edit', async () => {
    expect(createReels(seoId, true)).toBe(1);
    await kickReels(deps());
    const reel = listPlanReels(planId)[0]!;
    expect([reel.kind, reel.status, reel.stage]).toEqual(['long', 'done', 'done']);
    expect(reel.closing).toBe(CLOSING);
    // One call for the story, then one per scene for each picture and each clip.
    expect(asked).toEqual([
      'newsite-reel-story',
      ...Array(4).fill('newsite-reel-scene-picture'),
      ...Array(4).fill('newsite-reel-scene-video'),
    ]);
    // Scene 1 from the article's photo; the others from scene 1 and that photo.
    expect(pictures[0]!.referenceUrls).toHaveLength(1);
    expect(pictures[0]!.referenceUrls[0]).toMatch(/\/media\/picture\//);
    expect(pictures[1]!.referenceUrls[0]).toMatch(/^https:\/\/dash\.example\.com\/media\/reel-scene\/\d+\/\d+\/[\w-]+\.png$/);
    expect(pictures[1]!.referenceUrls[1]).toMatch(/\/media\/picture\//);
    // Pictures already in the Flow project go by their media id, not as an upload.
    expect(pictures[0]!.referenceMediaIds).toEqual(['']);
    expect(pictures[1]!.referenceMediaIds).toEqual(['media-pic-1', '']);
    expect(clips.map((c) => c.referenceMediaIds)).toEqual([['media-pic-1'], ['media-pic-2'], ['media-pic-3'], ['media-pic-4']]);
    // Each clip starts from its own scene's picture, at its own length, with the voice and its words.
    expect(clips.map((c) => c.seconds)).toEqual([8, 8, 8, 6]);
    expect(clips.every((c) => c.prompt.includes(VOICE))).toBe(true);
    expect(clips[3]!.prompt).toContain(CLOSING);
    expect(clips[0]!.prompt).not.toContain(CLOSING);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.scenes.map((s) => s.seconds)).toEqual([8, 8, 8, 6]);
    expect(edits[0]!.closing).toBe(CLOSING);
    expect(edits[0]!.music).toBeUndefined();
    expect(edits[0]!.out).toBe(join(dataDir, 'newsite-reels', `reel-${reel.id}.mp4`));
  });

  it('goes on from the scene it stopped at, without making the earlier ones again', async () => {
    failClip = 2;
    createReels(seoId, true);
    await kickReels(deps());
    let reel = listPlanReels(planId)[0]!;
    expect(reel.status).toBe('failed');
    expect(reel.error).toContain('policy');
    expect(listScenes(reel.id).map((s) => Boolean(s.video_file))).toEqual([true, false, false, false]);

    failClip = 0;
    asked = [];
    pictures = [];
    expect(remakeReel(reel.id, dataDir)).toBe(true);
    await kickReels(deps());
    reel = getReel(reel.id)!;
    expect(reel.status).toBe('done');
    expect(asked).toEqual([]);
    expect(pictures).toEqual([]);
    // Clip 1 kept; clip 2 sent again, then the rest.
    expect(clips.map((c) => c.seconds)).toEqual([8, 8, 8, 8, 6]);
  });

  it('keeps the 10-second reel for a website that has not picked long', async () => {
    settings.set(reelKindKey(websiteId), 'short');
    createReels(seoId, true);
    const reel = listPlanReels(planId)[0]!;
    expect(reel.kind).toBe('short');
  });

  it('keeps a music library: tracks added, picked, unpicked and deleted', () => {
    const a = addMusic('calm_morning.mp3', Buffer.from('ID3'), dataDir);
    const b = addMusic('Upbeat-Loop.wav', Buffer.from('RIFF'), dataDir);
    expect(() => addMusic('notes.txt', Buffer.from('x'), dataDir)).toThrow(/not a music file/);
    expect(listMusic().map((m) => m.name)).toEqual(['calm morning', 'Upbeat Loop']);
    expect(pickMusic(dataDir, () => 0)).toBe(join(dataDir, 'newsite-music', a.file));
    setMusicUsed([a.id], false);
    expect(pickMusic(dataDir, () => 0)).toBe(join(dataDir, 'newsite-music', b.file));
    expect(deleteMusic([a.id, b.id], dataDir)).toBe(2);
    expect(existsSync(join(dataDir, 'newsite-music', b.file))).toBe(false);
    expect(pickMusic(dataDir)).toBeUndefined();
  });

  it('lets the Reels page pick the type and length per website, and the Music page upload, pick and delete', async () => {
    const app = Fastify();
    await app.register(formbody);
    await app.register(multipart);
    registerSocialRoutes(app, { settings, encryptionKey: KEY, dataDir, ask: async () => '{}', readFlash: () => null, autoStart: false });
    const form = (url: string, body: string) =>
      app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });

    const page = await app.inject({ url: '/new-website/sharing/reels' });
    expect(page.body).toContain(`action="/new-website/sharing/reels/kind/${websiteId}"`);
    expect(page.body).toContain('<option value="long" selected>Long</option>');
    expect(page.body).toContain('href="/new-website/sharing/music"');
    expect((await form(`/new-website/sharing/reels/kind/${websiteId}`, 'kind=short&seconds=90')).statusCode).toBe(303);
    expect(settings.get(reelKindKey(websiteId))).toBe('short');
    expect(settings.get(reelSecondsKey(websiteId))).toBe('90');

    const boundary = 'xyz';
    const part = (name: string, body: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${body}\r\n`;
    const up = await app.inject({
      method: 'POST',
      url: '/new-website/sharing/music/upload',
      payload: `${part('one.mp3', 'ID3a')}${part('two.ogg', 'OggS')}${part('bad.txt', 'x')}--${boundary}--\r\n`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(decodeURIComponent(up.headers.location as string)).toContain('2 added. Not music: bad.txt.');
    const [one, two] = listMusic();
    const music = await app.inject({ url: '/new-website/sharing/music' });
    expect(music.body).toContain(`src="/new-website/sharing/music/${one!.id}/file"`);
    expect((await app.inject({ url: `/new-website/sharing/music/${one!.id}/file` })).body).toBe('ID3a');
    await form('/new-website/sharing/music/bulk', `action=unuse&id=${one!.id}&id=${two!.id}`);
    expect(listMusic().map((m) => m.used)).toEqual([0, 0]);
    await form('/new-website/sharing/music/bulk', `action=delete&id=${one!.id}`);
    expect(listMusic().map((m) => m.name)).toEqual(['two']);
  });
});
