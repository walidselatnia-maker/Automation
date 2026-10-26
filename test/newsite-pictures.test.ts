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
  queueStepPictures,
  retryFailedPictures,
  failedArticlePictures,
  shapeOf,
  NEXT_STEP_KEY,
  restartPictureMaker,
  stopPictureMaker,
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

  it('Stop puts the picture in hand back, drops its answer and sends nothing more; Restart sends it again', async () => {
    setPrompts(['feature', 'overhead']);
    queuePictures(seoId, dataDir);
    let release!: () => void;
    const stuck = deps(() => new Promise((r) => { release = () => r({ data: Buffer.from('late'), contentType: 'image/png' }); }));
    const first = kickPictureMaker(stuck);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    stopPictureMaker(settings);
    expect(listPictures(seoId).map((p) => p.status)).toEqual(['queued', 'queued']);
    release();
    await first;
    expect(sent).toHaveLength(1); // the late answer is dropped and nothing more goes out
    expect(listPictures(seoId).map((p) => p.status)).toEqual(['queued', 'queued']);
    await kickPictureMaker(deps(ok));
    expect(sent).toHaveLength(1); // still stopped

    await restartPictureMaker(deps(ok));
    expect(prompts()).toEqual(['prompt for feature', 'prompt for feature', 'prompt for overhead']);
    expect(listPictures(seoId).map((p) => p.status)).toEqual(['done', 'done']);
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

  it('calls the old image client with the same settings, 3:4 for article pictures and square for recipe steps', async () => {
    settings.set('image_base_url', 'http://imagegen:8100');
    settings.set('flow_project_id', 'shared-project');
    const generate = vi
      .spyOn(ImageClient.prototype, 'generate')
      .mockResolvedValue({ jobId: 'j', imageUrl: 'u', data: Buffer.from('img'), contentType: 'image/png' });
    setPrompts(['feature']);
    queuePictures(seoId, dataDir);
    await kickPictureMaker({ settings, dataDir, now: () => clock, sleep: async () => {} });
    expect(generate).toHaveBeenCalledWith('prompt for feature', 'PORTRAIT_3_4');
    expect([shapeOf('feature'), shapeOf('section-2'), shapeOf('step-3'), shapeOf('pin-4')]).toEqual(['PORTRAIT_3_4', 'PORTRAIT_3_4', 'SQUARE', 'PORTRAIT_3_4']);
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

  it('tries failed pictures again on request (one, or all of a keyword), never an old prompt or a social picture', async () => {
    setPrompts(['feature', 'overhead']);
    queuePictures(seoId, dataDir);
    run(`UPDATE newsite_pictures SET status = 'failed', error = 'Image job x failed'`);
    run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, status) VALUES (?, 'social-9', 1000, 'pin', 'failed')`, seoId);
    run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, status) VALUES (?, 'closeup', 2, 'an old prompt', 'failed')`, seoId);
    // What the dashboard counts as needing attention: the same two the Images step shows.
    expect(failedArticlePictures().map((p) => p.slot)).toEqual(['feature', 'overhead']);
    const [feature] = listPictures(seoId);
    expect(retryFailedPictures({ pictureId: feature!.id })).toBe(1);
    expect(listPictures(seoId).find((p) => p.slot === 'feature')).toMatchObject({ status: 'queued', error: '', attempts: 0 });
    expect(retryFailedPictures({ seoId })).toBe(1); // overhead; not the social picture, not the old prompt
    expect(listPictures(seoId).filter((p) => p.status === 'failed').map((p) => p.slot).sort()).toEqual(['closeup', 'social-9']);
    await kickPictureMaker(deps(ok));
    expect(prompts()).toEqual(['prompt for feature', 'prompt for overhead']);
  });

  it('makes the main pictures first; once posted, the steps go through the slow queue, 15 to 30 minutes apart', async () => {
    setPrompts(['feature', 'overhead', 'step-1', 'step-2']);
    // Make pictures queues the main ones only.
    expect(queuePictures(seoId, dataDir)).toBe(2);
    const wakes: number[] = [];
    const slow = () => ({ ...deps(ok), random: () => 0.5, wakeIn: (ms: number) => { wakes.push(ms); } });

    await kickPictureMaker(slow());
    expect(prompts()).toEqual(['prompt for feature', 'prompt for overhead']);
    // Steps wait for the article to be posted, which queues them.
    expect(listPictures(seoId).map((p) => p.slot)).toEqual(['feature', 'overhead']);
    expect(queueStepPictures(seoId, settings, clock, () => 0.5, dataDir)).toBe(2);
    await kickPictureMaker(slow());
    // Nothing was sent for the steps yet.
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

  it('says when the main pictures of an article are all made, so it can be published', async () => {
    setPrompts(['feature', 'overhead', 'step-1']);
    queuePictures(seoId, dataDir);
    const ready: number[] = [];
    await kickPictureMaker({ ...deps(ok), afterMain: async (id: number) => { ready.push(id); } });
    expect(ready).toEqual([seoId]);
  });

  it('keeps the slow queue going past a failed step picture', async () => {
    setPrompts(['feature', 'step-1', 'step-2']);
    queuePictures(seoId, dataDir);
    const slow = (make: (p: string) => Promise<{ data: Buffer; contentType: string }>) => ({ ...deps(make), random: () => 0, wakeIn: () => {} });
    await kickPictureMaker(slow(ok));
    queueStepPictures(seoId, settings, clock, () => 0, dataDir);
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
