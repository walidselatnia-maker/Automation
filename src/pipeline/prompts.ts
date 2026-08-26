import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPromptOverride } from '../db/repos.js';

/**
 * Loads and renders the prompt files extracted verbatim from the n8n
 * workflow. The prompts are the product; they are stored as plain text so
 * they can be edited without touching code, and so a diff shows exactly what
 * changed about article quality.
 *
 * Template syntax is {{dotted.path}}. Nothing else is interpreted — no
 * expressions, no logic. Anything clever belongs in the step, not the prompt.
 */

export interface PromptPair {
  system: string;
  user: string;
}

let promptsDir = './prompts';
const cache = new Map<string, string>();

export function configurePrompts(dir: string): void {
  promptsDir = dir;
  cache.clear();
}

/** Drop the cache so the next render picks up an edit. */
export function invalidatePromptCache(): void {
  cache.clear();
}

/** The prompt as shipped, ignoring any edit. */
export function readShippedPrompt(name: string): string {
  const path = resolve(promptsDir, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * An edit made in the UI wins over the shipped file.
 *
 * The files live inside the image, so editing them in a running container
 * lasts until the next redeploy and then silently reverts. The database is the
 * only place an edit survives, and the file remains the fallback — deleting
 * the override restores the shipped text exactly.
 *
 * Cached because a run renders a dozen prompts and this sits in the hot path;
 * saving an edit clears it.
 */
function readPromptFile(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  let text: string;
  try {
    text = getPromptOverride(name) ?? readShippedPrompt(name);
  } catch {
    // Rendering a prompt must not depend on the database being open — the
    // prompt tests and any offline tooling read these without one.
    text = readShippedPrompt(name);
  }

  cache.set(name, text);
  return text;
}

/** Look up a dotted path in a context object. */
function lookup(context: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined) return undefined;
    if (typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[part];
  }, context);
}

export function render(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = lookup(context, path);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/** Report placeholders a context does not satisfy, for diagnostics. */
export function missingVariables(
  template: string,
  context: Record<string, unknown>,
): string[] {
  const missing = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const path = match[1];
    if (path && lookup(context, path) === undefined) missing.add(path);
  }
  return [...missing];
}

/**
 * Load a prompt pair by name, rendering both halves.
 * `name` matches the extracted files, e.g. "part-1" or "part-1.fallback".
 */
export function loadPrompt(name: string, context: Record<string, unknown>): PromptPair {
  return {
    system: render(readPromptFile(`${name}.system.txt`), context),
    user: render(readPromptFile(`${name}.user.txt`), context),
  };
}

export function loadTemplate(name: string, context: Record<string, unknown>): string {
  return render(readPromptFile(name), context);
}

/** Models each prompt was authored against, preserved from the workflow. */
export const PROMPT_MODELS: Record<string, { model: string; format: 'json' | null }> = {
  'spy-validation': { model: 'gpt-oss:120b', format: null },
  'recipe-generator': { model: 'gpt-oss:20b', format: null },
  'image-prompts': { model: 'gemma4:31b', format: null },
  'part-1': { model: 'gemma4:31b', format: 'json' },
  'part-2': { model: 'gemma4:31b', format: 'json' },
  'part-3': { model: 'gemma4:31b', format: 'json' },
  'part-1.fallback': { model: 'gemma4:31b', format: 'json' },
  'part-2.fallback': { model: 'gemma4:31b', format: 'json' },
  'part-3.fallback': { model: 'gemma4:31b', format: 'json' },
  'pin-description': { model: 'gpt-oss:120b', format: null },
  'pick-board': { model: 'gpt-oss:120b', format: null },
  'repair-json': { model: 'gpt-oss:120b', format: null },
};
