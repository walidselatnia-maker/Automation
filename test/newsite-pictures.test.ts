import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { placeholderProjectId } from '../src/core/project-id.js';
import { ImageClient } from '../src/integrations/images.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import {
  clearPictures,
  kickPictureMaker,
  listPictures,
  pictureDir,
  queuePictures,
  resetPictureMakerState,
  NEXT_STEP_KEY,
} from '../src/newsite/pictures.js';

const KEY = randomBytes(32);

const promptsFor = (slots: string[], tag = '') => ({
  theme: { surface: 's', lighting: 'l', palette: 'p', style: 'st', mood: 'm' },
  images: slots.map((slot) => ({ slot, prompt: `prompt for ${slot}${tag}`, alt: `alt for ${slot}` })),
});

describe('Pictures, made the old dashboard way', () => {
  let settings: Settings;
  let seoId: number;
  let dataDir: string;
  let clock: number;
  let sleeps: number[];
  let sent: { prompt: string; projectId: string }[];

  const setPrompts = (slots: string[], tag = '') =>
    run(`UPDATE keyword_seo SET images_status = 'done', images_json = ? WHERE id = ?`, JSON.stringify(promptsFor(slots, tag)), seoId);

  const deps = (make: (prompt: string) => Promise<{ data: Buffer; contentType: string }>) => ({
    settings,
    dataDir,
    make: async (prompt: string, projectId: string) => {
      sent.push({ prompt, projectId });
      clock += 5000; // a picture takes a while
      return make(prompt);
    },
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

  const ok = async () => ({ data: Buffer.from('img'), contentType: 'image/png' });
  const prompts = () => sent.map((s) => s.prompt);

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
    vi.restoreAllMocks();
  });

  it('sends nothing until pictures are asked for', async () => {
    setPrompts(['feature', 'overhead']);
    await kickPictureMaker(deps(ok));
    expect(sent).toEqual([]);
    expect(listPictures(seoId)).toEqual([]);
  });

  it('makes them one at a time, with the old gap between them, and keeps the files', async () => {
    setPrompts(['feature', 'overhead', 'closeup']);
    expect(queuePictures(seoId, dataDir)).toBe(3);
    await kickPictureMaker(deps(ok));
    expect(prompts()).toEqual(['prompt for feature', 'prompt for overhead', 'prompt for closeup']);
    // No wait before the first; the gap after each one came back before the next.
    expect(sleeps).toEqual([30000, 30000]);
    const pictures = listPictures(seoId);
    expect(pictures.map((p) => p.status)).toEqual(['done', 'done', 'done']);
    expect(readFileSync(join(pictureDir(seoId, dataDir), pictures[0]!.file), 'utf8')).toBe('img');
  });

  it('uses the old project rule: the website, else Settings, else the old placeholder', async () => {
    setPrompts(['feature']);
    queuePictures(seoId, dataDir);
    await kickPictureMaker(deps(ok));
    expect(sent[0]!.projectId).toBe(placeholderProjectId('f.longlivo.com'));

    settings.set('flow_project_id', 'shared-project');
    clearPictures(seoId, dataDir);
    queuePictures(seoId, dataDir);
    await kickPictureMaker(deps(ok));
    expect(sent[1]!.projectId).toBe('shared-project');

    run(`UPDATE new_websites SET project_id = 'site-project'`);
    clearPictures(seoId, dataDir);
    queuePictures(seoId, dataDir);
    await kickPictureMaker(deps(ok));
    expect(sent[2]!.projectId).toBe('site-project');
  });

  it('calls the old image client the old way: VERTICAL, with the same settings', async () => {
    settings.set('image_base_url', 'http://imagegen:8100');
    settings.set('flow_project_id', 'shared-project');
    const generate = vi
      .spyOn(ImageClient.prototype, 'generate')
      .mockResolvedValue({ jobId: 'j', imageUrl: 'u', data: Buffer.from('img'), contentType: 'image/png' });
    setPrompts(['feature']);
    queuePictures(seoId, dataDir);
    await kickPictureMaker({ settings, dataDir, now: () => clock, sleep: async () => {} });
    expect(generate).toHaveBeenCalledWith('prompt for feature', 'VERTICAL');
    expect(listPictures(seoId)[0]).toMatchObject({ status: 'done' });
  });

  it('stops the article at a failed picture, and carries on from it when asked again', async () => {
    setPrompts(['feature', 'overhead', 'closeup']);
    queuePictures(seoId, dataDir);
    let fail = true;
    await kickPictureMaker(deps(async (prompt) => {
      if (fail && prompt.includes('overhead')) throw new Error('Image job x failed with status FAILED: blocked');
      return ok();
    }));
    expect(prompts()).toEqual(['prompt for feature', 'prompt for overhead']);
    const pictures = listPictures(seoId);
    expect(pictures.map((p) => p.slot + ':' + p.status)).toEqual(['feature:done', 'overhead:failed']);
    expect(pictures[1]!.error).toMatch(/blocked/);

    fail = false;
    sent = [];
    expect(queuePictures(seoId, dataDir)).toBe(2);
    await kickPictureMaker(deps(ok));
    expect(prompts()).toEqual(['prompt for overhead', 'prompt for closeup']);
    expect(listPictures(seoId).map((p) => p.status)).toEqual(['done', 'done', 'done']);
  });

  it('makes the main pictures first, then sends the steps to the slow queue, 15 to 30 minutes apart', async () => {
    setPrompts(['feature', 'overhead', 'step-1', 'step-2']);
    // Make pictures queues the main ones only.
    expect(queuePictures(seoId, dataDir)).toBe(2);
    const wakes: number[] = [];
    const slow = () => ({ ...deps(ok), random: () => 0.5, wakeIn: (ms: number) => { wakes.push(ms); } });

    await kickPictureMaker(slow());
    // The main two were made; the steps joined the slow queue, but nothing was sent for them yet.
    expect(prompts()).toEqual(['prompt for feature', 'prompt for overhead']);
    expect(listPictures(seoId).map((p) => `${p.slot}:${p.status}`)).toEqual([
      'feature:done', 'overhead:done', 'step-1:queued', 'step-2:queued',
    ]);
    // The first step waits 22.5 minutes (halfway between 15 and 30), and the maker wakes for it.
    expect(Number(settings.get(NEXT_STEP_KEY))).toBe(clock + 22.5 * 60_000);
    expect(wakes).toEqual([22.5 * 60_000]);

    // Woken too early: still nothing.
    sent = [];
    clock += 10 * 60_000;
    await kickPictureMaker(slow());
    expect(sent).toEqual([]);

    // Due: one step picture, then the next one waits again.
    clock += 13 * 60_000;
    await kickPictureMaker(slow());
    expect(prompts()).toEqual(['prompt for step-1']);
    expect(Number(settings.get(NEXT_STEP_KEY)) - clock).toBe(22.5 * 60_000);
    expect(listPictures(seoId).map((p) => p.status)).toEqual(['done', 'done', 'done', 'queued']);
  });

  it('keeps the slow queue going past a failed step picture', async () => {
    setPrompts(['feature', 'step-1', 'step-2']);
    queuePictures(seoId, dataDir);
    const slow = (make: (p: string) => Promise<{ data: Buffer; contentType: string }>) => ({ ...deps(make), random: () => 0, wakeIn: () => {} });
    await kickPictureMaker(slow(ok));
    clock += 15 * 60_000;
    await kickPictureMaker(slow(async (p) => { if (p.includes('step-1')) throw new Error('blocked'); return ok(); }));
    clock += 15 * 60_000;
    await kickPictureMaker(slow(ok));
    expect(listPictures(seoId).map((p) => `${p.slot}:${p.status}`)).toEqual(['feature:done', 'step-1:failed', 'step-2:done']);
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
