import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createRun,
  getKeyword,
  getSite,
  insertFbToken,
  insertKeyword,
  listReels,
  listSteps,
  setFbPageOptions,
  setLink,
  upsertFbPage,
  upsertSite,
} from '../src/db/repos.js';
import { upsertEndpoint } from '../src/llm/pool.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { executePipeline } from '../src/pipeline/index.js';
import { postRetry } from '../src/pipeline/steps/article.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { setLogLevel } from '../src/lib/logger.js';
import { buildWorld, writeFakePrompts } from './helpers/pipeline-world.js';

/**
 * A published article becomes a reel on the page for its niche, with nobody
 * asked. The step is the one place that decides a run gets a reel, and it
 * never fails the run: by then the article is live, and a run marked failed
 * after publishing reads as an article that did not go out.
 */

const KEY = randomBytes(32);
const PROMPT_DIR = './data/test-prompts-reel';

describe('the create-reel step', () => {
  let settings: Settings;
  let siteId: number;
  let keywordId: number;

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    writeFakePrompts(PROMPT_DIR);
    configurePrompts(PROMPT_DIR);
    postRetry.baseMs = 0;

    settings = new Settings(KEY);
    settings.set('image_api_key', 'image-key');
    settings.set('image_base_url', 'https://imggen.test');
    settings.set('image_poll_interval_seconds', '0');
    settings.set('image_poll_max_attempts', '5');
    settings.set('buffer_enabled', 'false');
    settings.set('telegram_enabled', 'false');
    settings.set('fb_enabled', 'true');

    upsertEndpoint(
      { name: 'ollama-a', baseUrl: 'http://a:11434', apiKey: '', models: [], enabled: true },
      KEY,
    );

    siteId = upsertSite(
      {
        name: 'testsite',
        domain: 'testsite.com',
        status: 'active',
        pin_username: 'testsite',
        project_id: 'p1',
        daily_target: 5,
        interval_minutes: 0,
        apiToken: 'test-token',
        bufferToken: '',
      },
      KEY,
    );

    keywordId = insertKeyword({ seed_keyword: 'chicken breast', spy_title: 'Test Chicken' });
    setLink(keywordId, siteId, 'go');
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const makeContext = (runId: number): PipelineContext =>
    new PipelineContext({
      runId,
      site: getSite(siteId)!,
      keyword: getKeyword(keywordId)!,
      settings,
      encryptionKey: KEY,
    });

  const pageForKeyword = (autoPublish = true): number => {
    const token = insertFbToken('A', 'tok', KEY);
    const id = upsertFbPage({ pageId: '77', name: 'Chicken Page', tokenId: token });
    setFbPageOptions(id, { niche: 'Chicken Breast', autoPublish, enabled: true });
    return id;
  };

  const reelStep = (runId: number) => listSteps(runId).find((s) => s.step === 'create-reel');

  it('makes a reel from the four images with a written caption and no link', async () => {
    const pageId = pageForKeyword();
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);
    const runId = createRun(keywordId, siteId);

    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('published');
    const [reel] = listReels();
    expect(reel).toMatchObject({
      run_id: runId,
      fb_page_id: pageId,
      status: 'generating',
      job_id: 'video-1',
    });
    expect(reel!.caption).toBe(['Hook line!', '', 'A cosy stew.'].join(String.fromCharCode(10)));
    expect(JSON.parse(reel!.reference_json)).toHaveLength(4);
    expect(JSON.parse(reel!.reference_json)[0]).toMatch(/^https:\/\/testsite\.com\//);
    expect(reel!.prompt).toContain('reel video for Test Chicken');
    expect(world.videoBodies[0]).toMatchObject({ orientation: 'VERTICAL', project_id: 'p1' });
    expect(reelStep(runId)?.status).toBe('ok');
  });

  it('skips, and the run is still published, when no page has the niche', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    const runId = createRun(keywordId, siteId);

    expect((await executePipeline(makeContext(runId))).status).toBe('published');

    expect(listReels()).toEqual([]);
    expect(reelStep(runId)?.status).toBe('ok');
    expect(reelStep(runId)?.output_json).toContain('no page');
  });

  it('does nothing when reels are switched off', async () => {
    settings.set('fb_enabled', 'false');
    pageForKeyword();
    vi.stubGlobal('fetch', buildWorld().fetchStub);

    await executePipeline(makeContext(createRun(keywordId, siteId)));

    expect(listReels()).toEqual([]);
  });

  it('a video submit that fails leaves a failed reel, not a failed run', async () => {
    pageForKeyword();
    vi.stubGlobal('fetch', buildWorld({ failVideoSubmit: true }).fetchStub);
    const runId = createRun(keywordId, siteId);

    expect((await executePipeline(makeContext(runId))).status).toBe('published');

    expect(listReels()[0]).toMatchObject({ status: 'failed' });
    expect(listReels()[0]!.error).toContain('503');
    expect(reelStep(runId)?.status).toBe('ok');
  });

  it('falls back to the title when the caption model answers nothing', async () => {
    pageForKeyword();
    vi.stubGlobal('fetch', buildWorld({ llmOverrides: { 'reel-caption': '' } }).fetchStub);

    await executePipeline(makeContext(createRun(keywordId, siteId)));

    expect(listReels()[0]!.caption).toBe('Test Chicken');
  });

  it('a resumed run does not make a second reel', async () => {
    pageForKeyword();
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    const runId = createRun(keywordId, siteId);

    await executePipeline(makeContext(runId));
    await executePipeline(makeContext(runId));

    expect(listReels()).toHaveLength(1);
  });
});
