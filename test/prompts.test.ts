import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { describe, expect, it, beforeAll } from 'vitest';
import { configurePrompts, missingVariables, PROMPT_MODELS } from '../src/pipeline/prompts.js';

/**
 * Guards the contract between prompt files and the steps that render them.
 *
 * A prompt is just text, so a placeholder that no step supplies fails
 * silently — it renders as an empty string and quietly degrades the article
 * instead of raising an error. These tests make that a build failure.
 *
 * If you add a placeholder to a prompt, add it to the context below AND to
 * the step that renders it.
 */

const PROMPTS_DIR = './prompts';

/** Exactly what each step passes to `ctx.prompt(...)`. Keep in sync. */
const STEP_CONTEXTS: Record<string, Record<string, unknown>> = {
  'spy-validation': {
    spy: { title: 't', articleUrl: 'u', annotation: 'a', description: 'd' },
    categoryTitles: '[]',
    site: { domain: 'example.com' },
  },
  'recipe-generator': {
    seo: { keyword: 'k', title: 't', description: 'd', category: 'c' },
    spy: { title: 't', description: 'd', annotation: 'a' },
  },
  'image-prompts': {
    seo: { keyword: 'k', title: 't', description: 'd', category: 'c' },
    recipe: { raw: '{}' },
    recipeJson: '{}',
  },
  'pin-description': {
    seo: { keyword: 'k', title: 't', description: 'd', category: 'c' },
    cta: 'Try it!',
    site: { domain: 'example.com' },
    spy: { title: 't', description: 'd', annotation: 'a' },
  },
  'pick-board': {
    seo: { keyword: 'k', title: 't', description: 'd', category: 'c' },
    boardsJson: '{}',
  },
  'repair-json': { postError: 'e', articleJson: '{}' },
};

/** The three article parts and their fallbacks share one context. */
const ARTICLE_CONTEXT = {
  seo: { keyword: 'k', title: 't', description: 'd', category: 'c' },
  recipe: { raw: '{}' },
  images: { feature: '/a.webp', topShot: '/b.webp', textureMacro: '/c.webp', beforeAfter: '/d.webp' },
};

for (const part of ['part-1', 'part-2', 'part-3']) {
  STEP_CONTEXTS[part] = ARTICLE_CONTEXT;
  STEP_CONTEXTS[`${part}.fallback`] = ARTICLE_CONTEXT;
}

const PIN_GRAPHIC_CONTEXT = {
  seo: { keyword: 'k', title: 't', description: 'd', category: 'c' },
  cta: 'Try it!',
  site: { domain: 'example.com' },
  imagePrompts: { feature: 'f', textureMacro: 'm' },
};

describe('prompt files', () => {
  beforeAll(() => {
    configurePrompts(PROMPTS_DIR);
  });

  const hasPrompts = existsSync(PROMPTS_DIR);

  it.skipIf(!hasPrompts)('every prompt named in PROMPT_MODELS exists on disk', () => {
    for (const name of Object.keys(PROMPT_MODELS)) {
      expect(
        existsSync(`${PROMPTS_DIR}/${name}.user.txt`),
        `missing prompts/${name}.user.txt`,
      ).toBe(true);
    }
  });

  it.skipIf(!hasPrompts)('every prompt file is claimed by a step context', () => {
    const names = new Set(
      readdirSync(PROMPTS_DIR)
        .filter((f) => f.endsWith('.txt') && !f.startsWith('pin-graphic'))
        .map((f) => f.replace(/\.(system|user)\.txt$/, '')),
    );

    for (const name of names) {
      expect(STEP_CONTEXTS[name], `no step context defined for prompt "${name}"`).toBeDefined();
    }
  });

  it.skipIf(!hasPrompts)(
    'REGRESSION: every placeholder is supplied by the step that renders it',
    () => {
      // Two placeholders were unsupplied when this test was written:
      // spy.annotation in pin-description, and site.domain in the pin
      // graphic template. Both rendered as empty strings, silently.
      const failures: string[] = [];

      for (const [name, context] of Object.entries(STEP_CONTEXTS)) {
        for (const half of ['system', 'user'] as const) {
          const path = `${PROMPTS_DIR}/${name}.${half}.txt`;
          if (!existsSync(path)) continue;

          const missing = missingVariables(readFileSync(path, 'utf8'), context);
          if (missing.length > 0) {
            failures.push(`${name}.${half}: ${missing.join(', ')}`);
          }
        }
      }

      const pinGraphic = `${PROMPTS_DIR}/pin-graphic.template.txt`;
      if (existsSync(pinGraphic)) {
        const missing = missingVariables(readFileSync(pinGraphic, 'utf8'), PIN_GRAPHIC_CONTEXT);
        if (missing.length > 0) failures.push(`pin-graphic.template: ${missing.join(', ')}`);
      }

      expect(failures, `unsupplied prompt variables:\n  ${failures.join('\n  ')}`).toEqual([]);
    },
  );

  it.skipIf(!hasPrompts)('no n8n expression syntax survived the extraction', () => {
    const leftovers: string[] = [];

    for (const file of readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.txt'))) {
      const text = readFileSync(`${PROMPTS_DIR}/${file}`, 'utf8');
      // $('Node Name') and JSON.stringify(...) are n8n-isms, not templates.
      if (/\$\(['"]/.test(text) || /JSON\.stringify\(/.test(text)) {
        leftovers.push(file);
      }
    }

    expect(leftovers, `these still contain n8n expressions: ${leftovers.join(', ')}`).toEqual([]);
  });

  it.skipIf(!hasPrompts)('article prompts request JSON output', () => {
    for (const part of ['part-1', 'part-2', 'part-3']) {
      expect(PROMPT_MODELS[part]?.format).toBe('json');
    }
  });

  it.skipIf(!hasPrompts)('prompts are not empty', () => {
    for (const name of Object.keys(STEP_CONTEXTS)) {
      const path = `${PROMPTS_DIR}/${name}.user.txt`;
      if (!existsSync(path)) continue;
      expect(readFileSync(path, 'utf8').trim().length, `${name} is empty`).toBeGreaterThan(10);
    }
  });
});
