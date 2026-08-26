/**
 * What each prompt is allowed to reference.
 *
 * A prompt is plain text, so a placeholder no step supplies renders as an empty
 * string rather than raising anything — the article quietly comes out worse and
 * nothing says why. Two shipped that way before this existed: `spy.annotation`
 * in pin-description and `site.domain` in the pin graphic template.
 *
 * This is the single source of truth for that contract. The build asserts every
 * placeholder in every prompt file appears here, and the prompt editor lists
 * these to whoever is writing one and flags anything else on save.
 *
 * Adding a placeholder to a prompt means adding it here *and* passing it from
 * the step that renders that prompt.
 */

/** A sample value per variable. Shape matters; the values are placeholders. */
const SEO = { keyword: 'k', title: 't', description: 'd', category: 'c' };
const SPY = { title: 't', description: 'd', annotation: 'a', articleUrl: 'u' };

const ARTICLE_CONTEXT = {
  seo: SEO,
  recipe: { raw: '{}' },
  images: { feature: '/a.webp', topShot: '/b.webp', textureMacro: '/c.webp', beforeAfter: '/d.webp' },
};

export const STEP_CONTEXTS: Record<string, Record<string, unknown>> = {
  'spy-validation': {
    spy: SPY,
    categoryTitles: '[]',
    site: { domain: 'example.com' },
  },
  'recipe-generator': { seo: SEO, spy: SPY },
  'image-prompts': { seo: SEO, recipe: { raw: '{}' }, recipeJson: '{}' },
  'pin-description': {
    seo: SEO,
    cta: 'Try it!',
    site: { domain: 'example.com' },
    spy: SPY,
  },
  'pick-board': { seo: SEO, boardsJson: '{}' },
  'repair-json': { postError: 'e', articleJson: '{}' },
};

for (const part of ['part-1', 'part-2', 'part-3']) {
  STEP_CONTEXTS[part] = ARTICLE_CONTEXT;
  STEP_CONTEXTS[`${part}.fallback`] = ARTICLE_CONTEXT;
}

/** The pin graphic is a template rather than a prompt pair, so it stands alone. */
export const PIN_GRAPHIC_CONTEXT = {
  seo: SEO,
  cta: 'Try it!',
  site: { domain: 'example.com' },
  imagePrompts: { feature: 'f', textureMacro: 'm' },
};

/** Flatten a context into the dotted paths a template may use. */
function dottedPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : [];

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    dottedPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** Every variable this prompt may reference, sorted. Empty if unknown. */
export function variablesFor(promptName: string): string[] {
  const context =
    promptName === 'pin-graphic.template' ? PIN_GRAPHIC_CONTEXT : STEP_CONTEXTS[promptName];
  return context ? dottedPaths(context).sort() : [];
}

/** Placeholders in `body` that the step behind `promptName` does not supply. */
export function unknownVariables(promptName: string, body: string): string[] {
  const allowed = new Set(variablesFor(promptName));
  if (allowed.size === 0) return [];

  const used = new Set<string>();
  for (const match of body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const path = match[1];
    if (path && !allowed.has(path)) used.add(path);
  }
  return [...used];
}
