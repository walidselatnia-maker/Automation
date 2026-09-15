import { mkdirSync, writeFileSync } from 'node:fs';
import { vi } from 'vitest';

/**
 * A fake world for pipeline tests: Ollama, the image service, the site API,
 * Buffer. Every prompt is identified by a MARKER in its text, so a test can
 * say what the model answers to which question.
 */

/* -------------------------------------------------------------------------
 * A fake world: Ollama, the image service, the site API, and Buffer.
 * ---------------------------------------------------------------------- */

export const RECIPE = { title: 'Test Chicken', servings: 4 };

export const LLM_REPLIES: Record<string, string> = {
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
  'reel-caption': ['Hook line!', '', 'A cosy stew. https://never.example'].join(String.fromCharCode(10)),
};

export interface WorldOptions {
  failImageJobs?: boolean;
  /** Let this many generations succeed, then fail every one after. */
  failImageAfter?: number;
  imagePendingPolls?: number;
  failPostOnce?: boolean;
  /** Reject this many article posts with the site's real validation body, then accept. */
  rejectPayloadTimes?: number;
  /** Answer every article post with this status and a plain body (a 401, say). */
  postStatus?: number;
  /** Refuse the video job submit with a 503, as a sleeping image service does. */
  failVideoSubmit?: boolean;
  failEndpoint?: string;
  /** Replace one prompt's reply, to stand in for a model behaving badly. */
  llmOverrides?: Record<string, string>;
}

export function buildWorld(options: WorldOptions = {}) {
  const calls: string[] = [];
  const generateBodies: Record<string, unknown>[] = [];
  const videoBodies: Record<string, unknown>[] = [];
  let pollCount = 0;
  let postAttempts = 0;
  const promptCalls: Record<string, number> = {};

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
        : text.includes('MARKER-repair-json') ? 'repair-json'
        : text.includes('MARKER-reel-caption') ? 'reel-caption'
        : 'unknown';
      promptCalls[which] = (promptCalls[which] ?? 0) + 1;

      const reply = options.llmOverrides?.[which] ?? LLM_REPLIES[which] ?? '{}';
      return json({ message: { content: reply } });
    }

    // -- Image service -----------------------------------------------------
    if (url.includes('/v1/generate-video')) {
      videoBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (options.failVideoSubmit) return new Response('imagegen down', { status: 503 });
      return json({ job_id: 'video-1' });
    }

    if (url.includes('/v1/generate')) {
      generateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return json({ job_id: 'job-123' });
    }

    if (url.includes('/v1/jobs/')) {
      const failing =
        options.failImageJobs ||
        (options.failImageAfter !== undefined && generateBodies.length > options.failImageAfter);
      if (failing) {
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

    // A published image on one of the sites. This is what a second site
    // downloads when it reuses a keyword's images instead of generating them.
    if (url.includes('/uploads/')) {
      return new Response(new Uint8Array([4, 5, 6]), {
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
        if (options.postStatus) {
          return new Response('Unauthorized', { status: options.postStatus });
        }
        if (options.rejectPayloadTimes && postAttempts <= options.rejectPayloadTimes) {
          // The real thing, as longlivo.com sent it.
          return json(
            {
              error: 'Recipe payload validation failed',
              count: 1,
              errors: [{
                field: 'recipeInfo.servings',
                message: '"recipeInfo.servings" does not look like a yield/serving value.',
                received: 'string("4 medium pizzas")',
                expected: 'e.g. "24 clusters", "Serves 4", "8 slices"',
                hint: 'Use a short yield phrase, not a long sentence.',
              }],
              hint: 'Fix the listed field issues and retry the request.',
            },
            400,
          );
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

  return { fetchStub, calls, generateBodies, videoBodies, postAttempts: () => postAttempts, promptCalls };
}

/** Write prompt files whose text identifies which prompt was invoked. */
export function writeFakePrompts(dir: string): void {
  mkdirSync(dir, { recursive: true });

  const names = [
    'spy-validation', 'recipe-generator', 'image-prompts',
    'part-1', 'part-2', 'part-3',
    'part-1.fallback', 'part-2.fallback', 'part-3.fallback',
    'pin-description', 'pick-board', 'repair-json', 'reel-caption',
  ];

  for (const name of names) {
    const base = name.replace('.fallback', '');
    writeFileSync(`${dir}/${name}.user.txt`, `MARKER-${base} {{seo.title}}`);
    writeFileSync(`${dir}/${name}.system.txt`, `system for ${base}`);
  }
  writeFileSync(`${dir}/pin-graphic.template.txt`, 'pin graphic for {{seo.title}} {{cta}}');
  writeFileSync(`${dir}/reel-video.template.txt`, 'reel video for {{seo.title}}');
}

