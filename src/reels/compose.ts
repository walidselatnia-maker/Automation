import type { ArticleImages } from '../pipeline/steps/images.js';
import { getCompletedStep } from '../db/repos.js';
import type { SourceRole } from './plan.js';

/**
 * What every studio reel is built from, whoever asks for it -- the pipeline
 * after a publish, or a person on the reels page. One copy, so the two
 * cannot drift apart.
 */

/** The article's images by role, as public urls; the pin only when there is one. */
export function sourceUrls(
  host: string,
  images: ArticleImages,
  pin: string | null,
): Partial<Record<SourceRole, string>> {
  const abs = (path: string) => `https://${host}${path}`;
  const out: Partial<Record<SourceRole, string>> = {
    feature: abs(images.feature),
    topShot: abs(images.topShot),
    textureMacro: abs(images.textureMacro),
    beforeAfter: abs(images.beforeAfter),
  };
  if (pin) out.pin = abs(pin);
  return out;
}

/**
 * The prompt one clip is filmed from.
 *
 * The scene's own direction first, then what must hold in every clip: the
 * dish is the one in the photographs, named, and the pace is real time.
 * Then the line -- as the presenter speaking on screen, or as their
 * voiceover when they are not in the shot -- and how the delivery should
 * sound, in the same words every scene. That repetition, and the same voice
 * asset riding along with every spoken line, is what keeps the voice the
 * same clip to clip.
 */
export function clipPrompt(
  scene: { motion: string; line: string; onScreen?: boolean },
  presenter: { name: string; voice: string } | null,
  dish = '',
): string {
  const parts = [scene.motion.trim()];
  if (dish.trim()) {
    parts.push(
      `The dish is ${dish.trim()}, exactly the food in the reference photograph: ` +
        'same plate, same colours, same portion; nothing added or swapped.',
    );
  }
  parts.push('Natural real-time speed, no slow motion.');

  const line = scene.line.trim();
  if (presenter && line) {
    parts.push(
      scene.onScreen === false
        ? `${presenter.name} is not on screen; her voiceover says: "${line}"`
        : `${presenter.name} says: "${line}"`,
    );
    if (presenter.voice.trim()) parts.push(`Voice: ${presenter.voice.trim()}.`);
  } else if (line) {
    parts.push(`A voice says: "${line}"`);
  }
  return parts.join(' ');
}

/** What a reel keeps about its article before and after planning. */
export interface ReelSeed {
  article: { title: string; recipe: string; imagePrompts: Record<string, string> };
  sources: Partial<Record<SourceRole, string>>;
}

/**
 * Everything the planner needs, read off the run's checkpoints.
 *
 * The recipe and the image prompts are what the article was written from;
 * they are what makes a storyboard specific to this dish rather than to
 * "a recipe". The pin graphic joins the sources when the run made one.
 */
export function seedFromRun(
  runId: number,
  host: string,
  images: ArticleImages,
  title: string,
): ReelSeed {
  const output = (step: string): unknown => {
    const row = getCompletedStep(runId, step);
    if (!row?.output_json) return null;
    try {
      return JSON.parse(row.output_json);
    } catch {
      return null;
    }
  };

  const pin = output('generate-pin-image') as { url?: string } | null;
  const recipe = output('generate-recipe');
  const prompts = output('generate-image-prompts') as Record<string, unknown> | null;

  const imagePrompts: Record<string, string> = {};
  for (const [key, value] of Object.entries(prompts ?? {})) {
    if (typeof value === 'string') imagePrompts[key] = value;
  }

  return {
    article: {
      title,
      recipe: typeof recipe === 'string' ? recipe : recipe ? JSON.stringify(recipe) : '',
      imagePrompts,
    },
    sources: sourceUrls(host, images, pin?.url ?? null),
  };
}

/**
 * The caption with the one thing it must never carry removed.
 *
 * Belt to the prompt's braces. The model is told not to link; if it does
 * anyway, the link comes out here rather than going on the post. The article
 * url is posted as the first comment and only there.
 */
export function withoutLinks(caption: string): string {
  return caption
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
