import { parseJson } from '../pipeline/json.js';
import type { ReelFormat } from './formats.js';

/**
 * The storyboard for one reel: what the model writes, and what is checked
 * before anything is spent on it.
 */

export type SourceRole = 'feature' | 'topShot' | 'textureMacro' | 'beforeAfter' | 'pin';

/** The length of one clip Flow produces on the reel path. */
export const CLIP_SECONDS = 10;
const MAX_LINE_WORDS = 22;

export interface PlannedScene {
  seconds: number;
  /** Which of the article's images this scene is filmed from, by role. */
  sources: SourceRole[];
  presenter: boolean;
  /** Fresh-image mode only: what the frame shows. */
  image: string;
  /** What physically happens over the clip. */
  motion: string;
  /** What the presenter says; empty for cooking sound only. */
  line: string;
}

export interface ReelPlan {
  format: string;
  hook: string;
  scenes: PlannedScene[];
  cta: string;
}

/** Clips are ten seconds; a length that does not divide rounds up rather than short. */
export const scenesFor = (targetSeconds: number): number =>
  Math.min(6, Math.max(2, Math.ceil(targetSeconds / CLIP_SECONDS)));

interface Rules {
  sources: SourceRole[];
  hasPresenter: boolean;
  targetSeconds: number;
  format: ReelFormat;
}

/**
 * Check a plan before anything is spent on it.
 *
 * Every rule here is one the model was told; this is what happens when it
 * did not listen. The error is a sentence, because it lands on the reel page.
 */
export function validatePlan(raw: unknown, rules: Rules): ReelPlan {
  const plan = (raw ?? {}) as Partial<ReelPlan>;
  const scenes = Array.isArray(plan.scenes) ? (plan.scenes as Partial<PlannedScene>[]) : [];
  const wanted = scenesFor(rules.targetSeconds);

  if (scenes.length < 2 || scenes.length > 6) {
    throw new Error(`The plan has ${scenes.length} scene(s); a reel has between 2 and 6.`);
  }
  if (Math.abs(scenes.length - wanted) > 1) {
    throw new Error(
      `The plan has ${scenes.length} scenes, but ${rules.targetSeconds} seconds is ${wanted}.`,
    );
  }

  const cta = String(plan.cta ?? '').trim();
  const out: PlannedScene[] = scenes.map((s, i) => {
    const n = i + 1;
    const sources = (Array.isArray(s.sources) ? s.sources : []).map(String) as SourceRole[];
    if (sources.length === 0) throw new Error(`Scene ${n} names no image to film from.`);
    for (const src of sources) {
      if (!rules.sources.includes(src)) {
        throw new Error(`Scene ${n} wants an image "${src}" the article does not have.`);
      }
    }

    const line = String(s.line ?? '').trim();
    if (line.split(/\s+/).filter(Boolean).length > MAX_LINE_WORDS) {
      throw new Error(
        `Scene ${n}'s line is longer than ${MAX_LINE_WORDS} words; it cannot be said in ten seconds.`,
      );
    }
    if (!rules.format.speech && line) {
      throw new Error(`The ${rules.format.title} format has no speech, but scene ${n} has a line.`);
    }

    const presenter = Boolean(s.presenter);
    if (presenter && (!rules.hasPresenter || rules.format.presenter === 'never')) {
      throw new Error(`Scene ${n} puts the presenter in a ${rules.format.key} reel that has none.`);
    }

    const motion = String(s.motion ?? '').trim();
    if (!motion) throw new Error(`Scene ${n} does not say what happens in it.`);

    return {
      seconds: CLIP_SECONDS,
      sources: sources.slice(0, 3),
      presenter,
      image: String(s.image ?? '').trim(),
      motion,
      line,
    };
  });

  if (rules.hasPresenter && rules.format.presenter !== 'never' && !out.some((s) => s.presenter)) {
    throw new Error('The page has a presenter, but no scene puts them in the reel.');
  }

  const last = out[out.length - 1]!;
  if (rules.format.speech && cta && !last.line.toLowerCase().includes(cta.toLowerCase().slice(0, 12))) {
    throw new Error('The last scene has to carry the call to action.');
  }

  return { format: rules.format.key, hook: String(plan.hook ?? '').trim(), scenes: out, cta };
}

export async function planReel(input: {
  prompt: (name: string, vars: Record<string, unknown>) => Promise<{ content: string }>;
  article: { title: string; recipe: string; imagePrompts: Record<string, string> };
  sources: SourceRole[];
  presenter: { name: string; voice: string } | null;
  targetSeconds: number;
  format: ReelFormat;
  cta?: string;
}): Promise<ReelPlan> {
  const cta = input.cta?.trim() || 'Full recipe in the comments';
  const result = await input.prompt('reel-plan', {
    article: {
      title: input.article.title,
      recipe: input.article.recipe,
      imagePrompts: Object.entries(input.article.imagePrompts)
        .map(([role, text]) => `${role}: ${text}`)
        .join('\n'),
    },
    sources: input.sources.join(', '),
    presenter: input.presenter ?? { name: 'nobody', voice: 'there is no presenter in this reel' },
    format: { key: input.format.key, title: input.format.title, shape: input.format.shape },
    scenes: scenesFor(input.targetSeconds),
    targetSeconds: input.targetSeconds,
    cta,
  });

  return validatePlan(parseJson(result.content, 'the reel plan'), {
    sources: input.sources,
    hasPresenter: input.presenter !== null,
    targetSeconds: input.targetSeconds,
    format: input.format,
  });
}
