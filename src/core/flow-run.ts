/**
 * One run, poured into the graph.
 *
 * Every step already stores what went into it and what came out —
 * run_steps.input_json and output_json — and until now nothing showed it. The
 * work here is reading each step's own shape well enough to say, in one line
 * on a card, what it produced: the brief that was sent, the picture that came
 * back, the title that was written.
 *
 * Everything is best effort on purpose. This is a diagnostic view, most often
 * opened over a run that went wrong, and a card that renders "—" is far more
 * use than a page that throws because a failed step stored half a document.
 */
import { FLOW_NODES, START, type FlowNode } from './flow-graph.js';
import type { RunRow, StepRow } from '../db/repos.js';

export interface FlowCell {
  node: FlowNode;
  status: 'ok' | 'failed' | 'running' | 'skipped' | 'pending';
  durationMs: number | null;
  model: string | null;
  error: string | null;
  /** The brief, prompt or title this step was handed. */
  input: string;
  /** What it produced, as a line of text. */
  summary: string;
  /** An image this step produced, when it produced one. */
  imageUrl: string | null;
  tokens: number;
}

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

function parse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const field = (value: unknown, key: string): string =>
  value && typeof value === 'object' ? text((value as Record<string, unknown>)[key]) : '';

/** The slot an image step fills, read off its name. */
const IMAGE_SLOT: Record<string, string> = {
  'generate-image-feature': 'feature',
  'generate-image-top-shot': 'topShot',
  'generate-image-texture-macro': 'textureMacro',
  'generate-image-before-after': 'beforeAfter',
};

/**
 * The brief an image step was given.
 *
 * Its own input is the prompt string, but a step that never ran has no row at
 * all — and that is exactly when the brief matters most, because the question
 * is why the picture is missing. So it falls back to the image-prompts step,
 * which wrote all six in one go.
 */
function imageBrief(step: string, own: StepRow | undefined, prompts: unknown): string {
  const fromOwn = typeof parse(own?.input_json ?? null) === 'string'
    ? String(parse(own!.input_json))
    : '';
  if (fromOwn) return fromOwn;
  return field(prompts, IMAGE_SLOT[step] ?? '');
}

/** An absolute url for a path the site serves. */
const onSite = (domain: string | null | undefined, path: string): string => {
  if (!path || /^https?:\/\//.test(path)) return path;
  const host = text(domain).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return host ? `https://${host}${path}` : path;
};

interface Described {
  input: string;
  summary: string;
  imageUrl: string | null;
}

/** What one step was handed and what it made, in the step's own terms. */
function describe(
  step: string,
  row: StepRow | undefined,
  byStep: Map<string, StepRow>,
  run: RunRow & { site_domain?: string | null; seed_keyword?: string | null },
): Described {
  const input = parse(row?.input_json ?? null);
  const output = parse(row?.output_json ?? null);
  const prompts = parse(byStep.get('generate-image-prompts')?.output_json ?? null);
  const domain = run.site_domain;

  if (step === START) {
    return {
      input: '',
      summary: text(run.seed_keyword) || text(run.title) || '—',
      imageUrl: null,
    };
  }

  if (step in IMAGE_SLOT) {
    const url = field(output, 'path') || field(output, 'absolute');
    return {
      input: imageBrief(step, row, prompts),
      summary: url ? 'Generated and uploaded' : '',
      imageUrl: url ? onSite(domain, url) : null,
    };
  }

  switch (step) {
    case 'validate-spy':
      return {
        input: text(run.seed_keyword),
        summary: field(output, 'title') || '',
        imageUrl: null,
      };

    case 'generate-recipe': {
      const raw = field(output, 'raw');
      return { input: field(input, 'title'), summary: raw.slice(0, 400), imageUrl: null };
    }

    case 'generate-image-prompts': {
      // The six briefs are the output, and the whole point of this node is
      // being able to read them, so they are laid out named rather than
      // dumped as JSON.
      const slots = ['feature', 'topShot', 'angleShot', 'textureMacro', 'cookingProcess', 'beforeAfter'];
      const written = slots
        .map((slot) => [slot, field(output, slot)] as const)
        .filter(([, value]) => value);
      return {
        input: field(input, 'title') || field(field(input, 'seo') as unknown as string, 'title'),
        summary: written.map(([slot, value]) => `${slot}: ${value}`).join('\n\n'),
        imageUrl: null,
      };
    }

    case 'generate-article':
      return {
        input: 'The recipe, the briefs and the four images',
        summary: field(output, 'title') || text(run.title),
        imageUrl: null,
      };

    case 'post-article':
      return {
        input: text(run.title),
        summary: field(output, 'href') || text(run.post_url),
        imageUrl: null,
      };

    case 'generate-pin-image':
      return {
        input: 'The title and the image briefs',
        summary: field(output, 'cta'),
        imageUrl: field(output, 'url') || null,
      };

    case 'generate-pin-description':
      return { input: text(run.title), summary: typeof output === 'string' ? output : '', imageUrl: null };

    case 'publish-to-buffer':
      return {
        input: 'The pin graphic and its text',
        summary: field(output, 'postId') ? `Queued as ${field(output, 'postId')}` : 'Skipped',
        imageUrl: null,
      };

    case 'create-reel':
      return {
        input: 'The article photos and the reel prompt',
        summary: output ? 'Reel queued' : '',
        imageUrl: null,
      };

    default:
      return { input: '', summary: '', imageUrl: null };
  }
}

/**
 * Every node of the graph, filled in from this run.
 *
 * A node with no row is 'pending' rather than missing: a run that failed at
 * the third image should still draw the steps it never reached, because the
 * gap is the diagnosis.
 */
export function flowCells(
  run: RunRow & { site_domain?: string | null; seed_keyword?: string | null },
  steps: StepRow[],
): FlowCell[] {
  // Later rows win: a step retried after a failure is the one that counts.
  const byStep = new Map<string, StepRow>();
  for (const row of steps) byStep.set(row.step, row);

  return FLOW_NODES.map((node) => {
    const row = byStep.get(node.step);
    const described = describe(node.step, row, byStep, run);

    return {
      node,
      status:
        node.step === START
          ? 'ok'
          : row
            ? (row.status as FlowCell['status'])
            : 'pending',
      durationMs: row?.duration_ms ?? null,
      model: row?.model ?? null,
      error: row?.error ?? null,
      tokens: (row?.tokens_in ?? 0) + (row?.tokens_out ?? 0),
      ...described,
    };
  });
}
