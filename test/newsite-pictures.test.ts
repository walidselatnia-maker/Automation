import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import {
  clearPictures,
  kickPictureMaker,
  listPictures,
  PAUSE_KEY,
  pictureDir,
  queuePictures,
  resetPictureMakerState,
  resumePictures,
  retryPicture,
} from '../src/newsite/pictures.js';

const KEY = randomBytes(32);

const promptsFor = (slots: string[], tag = '') => ({
  theme: { surface: 's', lighting: 'l', palette: 'p', style: 'st', mood: 'm' },
  images: slots.map((slot) => ({ slot, prompt: `prompt for ${slot}${tag}`, alt: `alt for ${slot}` })),
});

describe('Pictures from Google Flow', () => {
  let settings: Settings;
  let seoId: number;
  let dataDir: string;
  let clock: number;
  let sleeps: number[];
  let sent: string[];

  const setPrompts = (slots: string[], tag = '') =>
    run(`UPDATE keyword_seo SET images_status = 'done', images_json = ? WHERE id = ?`, JSON.stringify(promptsFor(slots, tag)), seoId);

  const deps = (make: (prompt: string) => Promise<{ data: Buffer; contentType: string }>, notify?: (m: string) => Promise<void>) => ({
    settings,
    dataDir,
    make: async (prompt: string) => {
      sent.push(prompt);
      clock += 5000; // a picture takes a while
      return make(prompt);
    },
    notify,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

  const ok = async () => ({ data: Buffer.from('img'), contentType: 'image/png' });

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('image_gap_seconds', '30');
    const websiteId = createNewWebsite(
      {
        name: 'Site', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    const planId = saveKeywordPlan(websiteId, 'strawberry cake', [], 'recipe');
    queuePlanSeo(planId, 'strawberry cake', [], 'recipe');
    seoId = listPlanSeo(planId)[0]!.id;
    dataDir = mkdtempSync(join(tmpdir(), 'pictures-'));
    clock = 1_000_000;
    sleeps = [];
    sent = [];
    resetPictureMakerState();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('sends nothing until pictures are asked for', async () => {
    setPrompts(['feature', 'overhead']);
    await kickPictureMaker(deps(ok));
    expect(sent).toEqual([]);
    expect(listPictures(seoId)).toEqual([]);
  });

  it('makes them one at a time, with the gap between them, and keeps the files', async () => {
    setPrompts(['feature', 'overhead', 'closeup']);
    expect(queuePictures(seoId, dataDir)).toBe(3);
    await kickPictureMaker(deps(ok));
    expect(sent).toEqual(['prompt for feature', 'prompt for overhead', 'prompt for closeup']);
    // No wait before the first; 30 s after each one came back before the next.
    expect(sleeps).toEqual([30000, 30000]);
    const pictures = listPictures(seoId);
    expect(pictures.map((p) => p.status)).toEqual(['done', 'done', 'done']);
    expect(readFileSync(join(pictureDir(seoId, dataDir), pictures[0]!.file), 'utf8')).toBe('img');
  });

  it('never makes a finished picture again', async () => {
    setPrompts(['feature', 'overhead']);
    queuePictures(seoId, dataDir);
    await kickPictureMaker(deps(ok));
    sent = [];
    expect(queuePictures(seoId, dataDir)).toBe(0);
    await kickPictureMaker(deps(ok));
    expect(sent).toEqual([]);
  });

  it('gives each picture two tries, then moves on to the next', async () => {
    setPrompts(['feature', 'overhead']);
    queuePictures(seoId, dataDir);
    await kickPictureMaker(deps(async (prompt) => {
      if (prompt.includes('feature')) throw new Error('Image job x failed with status FAILED: blocked');
      return ok();
    }));
    expect(sent).toEqual(['prompt for feature', 'prompt for feature', 'prompt for overhead']);
    const [feature, overhead] = listPictures(seoId);
    expect(feature).toMatchObject({ status: 'failed', attempts: 2 });
    expect(feature!.error).toMatch(/blocked/);
    expect(overhead).toMatchObject({ status: 'done' });

    retryPicture(feature!.id);
    sent = [];
    await kickPictureMaker(deps(ok));
    expect(sent).toEqual(['prompt for feature']);
    expect(listPictures(seoId)[0]).toMatchObject({ status: 'done' });
  });

  it('stops everything after three failures in a row, and tells Telegram', async () => {
    setPrompts(['feature', 'overhead', 'closeup', 'serving']);
    queuePictures(seoId, dataDir);
    const messages: string[] = [];
    await kickPictureMaker(deps(async () => { throw new Error('captcha_timeout'); }, async (m) => { messages.push(m); }));
    // Feature twice (failed), overhead once: three in a row, then the stop.
    expect(sent).toEqual(['prompt for feature', 'prompt for feature', 'prompt for overhead']);
    expect(settings.get(PAUSE_KEY)).toMatch(/3 pictures failed in a row.*captcha_timeout/);
    expect(messages[0]).toMatch(/paused/);
    expect(listPictures(seoId).map((p) => p.status)).toEqual(['failed', 'queued', 'queued', 'queued']);

    // Paused: pressing on sends nothing.
    sent = [];
    await kickPictureMaker(deps(ok));
    expect(sent).toEqual([]);

    resumePictures(settings);
    await kickPictureMaker(deps(ok));
    expect(sent).toEqual(['prompt for overhead', 'prompt for closeup', 'prompt for serving']);
  });

  it('does not send a prompt that was rewritten after it was queued', async () => {
    setPrompts(['feature']);
    queuePictures(seoId, dataDir);
    setPrompts(['feature'], ' v2');
    await kickPictureMaker(deps(ok));
    expect(sent).toEqual([]);
    expect(listPictures(seoId)).toEqual([]);
  });

  it('makes a picture again when its prompt changed, and clears files with the keyword', async () => {
    setPrompts(['feature']);
    queuePictures(seoId, dataDir);
    await kickPictureMaker(deps(ok));
    const first = listPictures(seoId)[0]!;
    setPrompts(['feature'], ' v2');
    expect(queuePictures(seoId, dataDir)).toBe(1);
    expect(existsSync(join(pictureDir(seoId, dataDir), first.file))).toBe(false);
    await kickPictureMaker(deps(ok));
    expect(listPictures(seoId)[0]).toMatchObject({ status: 'done', prompt: 'prompt for feature v2' });

    clearPictures(seoId, dataDir);
    expect(listPictures(seoId)).toEqual([]);
    expect(existsSync(pictureDir(seoId, dataDir))).toBe(false);
  });
});
