import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createRun,
  getKeyword,
  getRun,
  getSite,
  insertKeyword,
  listSteps,
  setLink,
  upsertSite,
  getLinksForKeyword,
} from '../src/db/repos.js';
import { upsertEndpoint } from '../src/llm/pool.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { executePipeline } from '../src/pipeline/index.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);

/* -------------------------------------------------------------------------
 * A fake world: Ollama, the image service, the site API, and Buffer.
 * ---------------------------------------------------------------------- */

const RECIPE = { title: 'Test Chicken', servings: 4 };

const LLM_REPLIES: Record<string, string> = {
  'spy-validation': JSON.stringify({
    keyword: 'chicken breast',
    title: 'Test Chicken',
    description: 'A test recipe',
    category: 'Quick & Easy Everyday Recipes',
  }),
  'recipe-generator': JSON.stringify(RECIPE),
  'image-prompts': JSON.stringify({
    image_1_feature: 'feature prompt',
    image_2_top_shot: 'top prompt',
    image_3_angle_shot: 'angle prompt',
    image_4_texture_macro: 'macro prompt',
    image_5_cooking_process: 'process prompt',
    image_6_before_after_split: 'split prompt',
  }),
  'part-1': JSON.stringify({ title: 'Test Chicken', slug: 'test-chicken' }),
  'part-2': JSON.stringify({ sections: ['a'] }),
  'part-3': JSON.stringify({ ingredients: ['chicken'], instructions: ['cook'] }),
  'pin-description': 'A delicious test pin description',
  'pick-board': JSON.stringify({ id: 'board-1', name: 'Chicken Recipes' }),
};

interface WorldOptions {
  failImageJobs?: boolean;
  imagePendingPolls?: number;
  failPostOnce?: boolean;
  failEndpoint?: string;
}

function buildWorld(options: WorldOptions = {}) {
  const calls: string[] = [];
  let pollCount = 0;
  let postAttempts = 0;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);

    // -- Ollama ------------------------------------------------------------
    if (url.includes('/api/chat')) {
      const host = new URL(url).hostname;
      if (options.failEndpoint && host === options.failEndpoint) {
        return new Response('endpoint down', { status: 500 });
      }

      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: { content: string }[];
      };
      const text = body.messages.map((m) => m.content).join(' ');

      // Identify which prompt this is by a distinctive marker in its text.
      const which =
        text.includes('MARKER-spy-validation') ? 'spy-validation'
        : text.includes('MARKER-recipe-generator') ? 'recipe-generator'
        : text.includes('MARKER-image-prompts') ? 'image-prompts'
        : text.includes('MARKER-part-1') ? 'part-1'
        : text.includes('MARKER-part-2') ? 'part-2'
        : text.includes('MARKER-part-3') ? 'part-3'
        : text.includes('MARKER-pin-description') ? 'pin-description'
        : text.includes('MARKER-pick-board') ? 'pick-board'
        : 'unknown';

      return json({ message: { content: LLM_REPLIES[which] ?? '{}' } });
    }

    // -- Image service -----------------------------------------------------
    if (url.includes('/v1/generate')) return json({ job_id: 'job-123' });

    if (url.includes('/v1/jobs/')) {
      if (options.failImageJobs) {
        return json({ job_id: 'job-123', status: 'FAILED', error: 'GPU unavailable' });
      }
      pollCount++;
      if (options.imagePendingPolls && pollCount <= options.imagePendingPolls) {
        return json({ job_id: 'job-123', status: 'PENDING', image_url: null, error: null });
      }
      return json({
        job_id: 'job-123',
        status: 'COMPLETED',
        image_url: 'https://images.test/out.webp',
        error: null,
      });
    }

    if (url.startsWith('https://images.test/')) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }

    // -- Site API ----------------------------------------------------------
    if (url.includes('/api/categories')) {
      return json([
        { id: 'cat-1', slug: 'quick', title: 'Quick & Easy Everyday Recipes', href: '/c/quick' },
      ]);
    }

    if (url.includes('/api/upload')) {
      return json({ success: true, url: '/uploads/recipes/x.webp', thumbnailUrl: '', filename: 'x.webp' });
    }

    if (url.includes('/api/recipe')) {
      if (init?.method === 'POST') {
        postAttempts++;
        if (options.failPostOnce && postAttempts === 1) {
          return new Response('Invalid JSON: unexpected token', { status: 400 });
        }
        return json({ id: 'recipe-1', title: 'Test Chicken', href: '/r/test-chicken' });
      }
      return json({ id: 'recipe-1', title: 'Test Chicken', href: '/r/test-chicken' });
    }

    // -- Buffer ------------------------------------------------------------
    if (url.includes('api.buffer.com')) {
      const body = String(init?.body ?? '');
      if (body.includes('GetOrganizations')) {
        return json({ data: { account: { organizations: [{ id: 'org-1', name: 'Org' }] } } });
      }
      if (body.includes('GetChannelsWithBoards')) {
        return json({
          data: {
            channels: [
              {
                id: 'chan-1',
                name: 'testsite',
                metadata: { boards: [{ serviceId: 'board-1', name: 'Chicken Recipes' }] },
              },
            ],
          },
        });
      }
      return json({ data: { createPost: { post: { id: 'buffer-post-1' } } } });
    }

    return new Response('not found', { status: 404 });
  });

  return { fetchStub, calls, postAttempts: () => postAttempts };
}

/** Write prompt files whose text identifies which prompt was invoked. */
function writeFakePrompts(dir: string): void {
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(dir, { recursive: true });

  const names = [
    'spy-validation', 'recipe-generator', 'image-prompts',
    'part-1', 'part-2', 'part-3',
    'part-1.fallback', 'part-2.fallback', 'part-3.fallback',
    'pin-description', 'pick-board', 'repair-json',
  ];

  for (const name of names) {
    const base = name.replace('.fallback', '');
    writeFileSync(`${dir}/${name}.user.txt`, `MARKER-${base} {{seo.title}}`);
    writeFileSync(`${dir}/${name}.system.txt`, `system for ${base}`);
  }
  writeFileSync(`${dir}/pin-graphic.template.txt`, 'pin graphic for {{seo.title}} {{cta}}');
}

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

const PROMPT_DIR = './data/test-prompts';

describe('pipeline end to end', () => {
  let settings: Settings;
  let siteId: number;
  let keywordId: number;

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    writeFakePrompts(PROMPT_DIR);
    configurePrompts(PROMPT_DIR);

    settings = new Settings(KEY);
    settings.set('site_api_token', 'test-token');
    settings.set('image_api_key', 'image-key');
    settings.set('image_base_url', 'https://imggen.test');
    settings.set('image_poll_interval_seconds', '0');
    settings.set('image_poll_max_attempts', '5');
    settings.set('buffer_api_token', 'buffer-token');
    settings.set('buffer_enabled', 'true');
    settings.set('telegram_enabled', 'false');

    upsertEndpoint(
      { name: 'ollama-a', baseUrl: 'http://a:11434', apiKey: '', models: [], enabled: true },
      KEY,
    );

    siteId = upsertSite({
      name: 'testsite',
      domain: 'testsite.com',
      status: 'active',
      pin_username: 'testsite',
      project_id: 'p1',
      buffer_channel_id: 'chan-1',
      daily_target: 5,
      hours_between: 0,
    });

    keywordId = insertKeyword({ seed_keyword: 'chicken breast', spy_title: 'Test Chicken' });
    setLink(keywordId, siteId, 'go');
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  const makeContext = (runId: number): PipelineContext =>
    new PipelineContext({
      runId,
      site: getSite(siteId)!,
      keyword: getKeyword(keywordId)!,
      settings,
      encryptionKey: KEY,
    });

  it('publishes successfully through every stage', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('published');
    expect(outcome.postId).toBe('recipe-1');
    expect(outcome.postUrl).toBe('https://testsite.com/r/test-chicken');

    const run = getRun(runId);
    expect(run?.status).toBe('published');
    expect(run?.published_at).not.toBeNull();

    const steps = listSteps(runId);
    expect(steps.every((s) => s.status === 'ok')).toBe(true);
    expect(steps.map((s) => s.step)).toContain('publish-to-buffer');
  });

  it('marks the keyword done for that site after publishing', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    await executePipeline(makeContext(createRun(keywordId, siteId)));

    expect(getLinksForKeyword(keywordId)[0]?.status).toBe('done');
    // No site is still 'go', so the keyword closes globally too.
    expect(getKeyword(keywordId)?.status).toBe('done');
  });

  it('generates four article images plus the Pinterest graphic', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);
    await executePipeline(makeContext(createRun(keywordId, siteId)));

    const generates = world.calls.filter((u) => u.includes('/v1/generate'));
    expect(generates).toHaveLength(5);
  });

  it('polls a pending image job until it completes', async () => {
    const world = buildWorld({ imagePendingPolls: 2 });
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));
    expect(outcome.status).toBe('published');
  });

  // -- The second infinite loop, now bounded --------------------------------
  it('REGRESSION: a FAILED image job fails the step instead of polling forever', async () => {
    vi.stubGlobal('fetch', buildWorld({ failImageJobs: true }).fetchStub);

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('failed');
    expect(outcome.failedStep).toBe('generate-images');
    expect(outcome.error).toContain('GPU unavailable');
    expect(getRun(runId)?.status).toBe('failed');
  });

  it('repairs and retries when the site rejects the article JSON', async () => {
    const world = buildWorld({ failPostOnce: true });
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));
    expect(outcome.status).toBe('published');
    expect(world.postAttempts()).toBe(2);
  });

  // -- Checkpointing --------------------------------------------------------
  it('resumes from the failed step without repeating completed work', async () => {
    vi.stubGlobal('fetch', buildWorld({ failImageJobs: true }).fetchStub);

    const runId = createRun(keywordId, siteId);
    const first = await executePipeline(makeContext(runId));
    expect(first.status).toBe('failed');

    const completedFirstTime = listSteps(runId).filter((s) => s.status === 'ok').length;
    expect(completedFirstTime).toBeGreaterThan(0);

    // The image service recovers; re-running must not redo the LLM calls.
    const second = buildWorld();
    vi.stubGlobal('fetch', second.fetchStub);

    const outcome = await executePipeline(makeContext(runId));
    expect(outcome.status).toBe('published');

    const chatCalls = second.calls.filter((u) => u.includes('/api/chat'));
    // Only the article, pin description and board prompts remain — the spy,
    // recipe and image-prompt calls were restored from checkpoints.
    expect(chatCalls.length).toBeLessThan(8);
    expect(second.calls.some((u) => u.includes('/api/categories'))).toBe(false);
  });

  it('records which endpoint served each LLM step', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    const runId = createRun(keywordId, siteId);
    await executePipeline(makeContext(runId));

    const step = listSteps(runId).find((s) => s.step === 'validate-spy');
    expect(step?.endpoint).toBe('ollama-a');
  });

  it('fails the run with a clear message when no LLM endpoint works', async () => {
    vi.stubGlobal('fetch', buildWorld({ failEndpoint: 'a' }).fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('ollama-a');
  });

  it('skips Buffer when it is disabled', async () => {
    settings.set('buffer_enabled', 'false');
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));
    expect(outcome.status).toBe('published');
    expect(world.calls.some((u) => u.includes('api.buffer.com'))).toBe(false);
  });
});
