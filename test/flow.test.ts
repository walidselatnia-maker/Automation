import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOW_EDGES, FLOW_NODES, START, flowNode } from '../src/core/flow-graph.js';
import { flowCells } from '../src/core/flow-run.js';
import type { RunRow, StepRow } from '../src/db/repos.js';

/**
 * The Flow page exists to answer one question: this picture is wrong, which
 * words produced it?
 *
 * So what is pinned here is the trace. Every image node names the prompt file
 * that wrote its brief, a step's stored input is what the card shows, and a
 * step that never ran still draws -- because on a run that died at the third
 * image, the gap is the diagnosis.
 *
 * And the graph is a hand-written mirror of executePipeline, which is the one
 * thing that can quietly rot: a card for a step that no longer exists teaches
 * something false. The last test reads the pipeline source and checks the
 * names still line up.
 */

const run = (over: Partial<RunRow> = {}): RunRow & { site_domain: string; seed_keyword: string } =>
  ({
    id: 1,
    status: 'published',
    title: 'One Skillet Garlic Butter Chicken',
    post_url: 'https://bitespoon.com/garlic-chicken',
    site_domain: 'bitespoon.com',
    seed_keyword: 'garlic chicken',
    started_at: '2026-09-25 10:00:00',
    ...over,
  }) as never;

function step(over: Partial<StepRow>): StepRow {
  return {
    id: 1, run_id: 1, step: '', status: 'ok', attempt: 1,
    started_at: '', finished_at: null, duration_ms: 1000,
    endpoint: null, model: null, input_json: null, output_json: null,
    tokens_in: 0, tokens_out: 0, images: 0, error: null,
    ...over,
  } as StepRow;
}

const BRIEFS = {
  feature: 'Overhead shot of golden garlic butter chicken, window light from the left.',
  topShot: 'Straight down on the skillet.',
  textureMacro: 'Extreme close-up of the crisped skin.',
  beforeAfter: 'Raw on the left, finished on the right.',
};

const cellFor = (cells: ReturnType<typeof flowCells>, stepName: string) =>
  cells.find((c) => c.node.step === stepName)!;

describe('the trace from a bad picture back to the words', () => {
  it('shows the brief that produced each image', () => {
    const cells = flowCells(run(), [
      step({ step: 'generate-image-prompts', output_json: JSON.stringify(BRIEFS) }),
      step({
        step: 'generate-image-feature',
        input_json: JSON.stringify(BRIEFS.feature),
        output_json: JSON.stringify({ path: '/uploads/feature.webp' }),
      }),
    ]);

    const feature = cellFor(cells, 'generate-image-feature');
    expect(feature.input).toBe(BRIEFS.feature);
    expect(feature.imageUrl).toBe('https://bitespoon.com/uploads/feature.webp');
  });

  it('names the prompt file that wrote the brief, not one of the image step’s own', () => {
    // The point of the page: a wrong picture is fixed by editing the template
    // that described it, and an image step has no template of its own.
    for (const name of [
      'generate-image-feature',
      'generate-image-top-shot',
      'generate-image-texture-macro',
      'generate-image-before-after',
    ]) {
      expect(flowNode(name)?.promptFile).toBe('image-prompts');
    }
  });

  it('falls back to the six briefs when the image step never ran', () => {
    // Exactly when it matters most: the picture is missing, and the question
    // is whether it was described badly or never attempted.
    const cells = flowCells(run(), [
      step({ step: 'generate-image-prompts', output_json: JSON.stringify(BRIEFS) }),
    ]);

    const missing = cellFor(cells, 'generate-image-before-after');
    expect(missing.status).toBe('pending');
    expect(missing.input).toBe(BRIEFS.beforeAfter);
  });

  it('draws a step that was never reached rather than dropping it', () => {
    const cells = flowCells(run(), [step({ step: 'validate-spy', status: 'failed', error: 'no' })]);

    expect(cells).toHaveLength(FLOW_NODES.length);
    expect(cellFor(cells, 'post-article').status).toBe('pending');
    expect(cellFor(cells, 'validate-spy')).toMatchObject({ status: 'failed', error: 'no' });
  });

  it('lays the six briefs out named, because reading them is the job', () => {
    const cells = flowCells(run(), [
      step({ step: 'generate-image-prompts', output_json: JSON.stringify(BRIEFS) }),
    ]);

    const summary = cellFor(cells, 'generate-image-prompts').summary;
    expect(summary).toContain('feature: Overhead shot');
    expect(summary).toContain('beforeAfter: Raw on the left');
  });

  it('keeps the newest attempt of a step that was retried', () => {
    const cells = flowCells(run(), [
      step({ id: 1, step: 'generate-image-feature', status: 'failed', error: 'timed out' }),
      step({
        id: 2, step: 'generate-image-feature', status: 'ok',
        output_json: JSON.stringify({ path: '/uploads/second.webp' }),
      }),
    ]);

    expect(cellFor(cells, 'generate-image-feature')).toMatchObject({
      status: 'ok',
      imageUrl: 'https://bitespoon.com/uploads/second.webp',
    });
  });

  it('survives a step that stored half a document', () => {
    // A diagnostic view is opened over broken runs by definition, so a card
    // reading "—" beats a page that will not render.
    const cells = flowCells(run(), [
      step({ step: 'generate-recipe', output_json: '{"raw": "unterminated' }),
    ]);

    expect(cellFor(cells, 'generate-recipe').summary).toBe('');
  });
});

describe('the graph itself', () => {
  it('joins every node to the rest', () => {
    const wired = new Set(FLOW_EDGES.flatMap((e) => [e.from, e.to]));
    for (const node of FLOW_NODES) expect(wired.has(node.step)).toBe(true);
  });

  it('wires only nodes that exist, and never backwards', () => {
    const at = new Map(FLOW_NODES.map((n) => [n.step, n] as const));
    for (const edge of FLOW_EDGES) {
      const from = at.get(edge.from);
      const to = at.get(edge.to);
      expect(from, `no node ${edge.from}`).toBeDefined();
      expect(to, `no node ${edge.to}`).toBeDefined();
      // Left to right, or the wires cross back over the cards they came from.
      expect(from!.column).toBeLessThan(to!.column);
    }
  });

  it('gives every column and row one card only', () => {
    const seen = new Set<string>();
    for (const node of FLOW_NODES) {
      const at = `${node.column}:${node.row}`;
      expect(seen.has(at), `two cards at ${at}`).toBe(false);
      seen.add(at);
    }
  });

  it('names steps the pipeline actually runs', () => {
    // The graph is written by hand against executePipeline. A card for a step
    // that was renamed shows a permanently empty box and teaches a lie.
    const source = readFileSync('src/pipeline/index.ts', 'utf8') +
      readFileSync('src/pipeline/steps/images.ts', 'utf8') +
      readFileSync('src/pipeline/steps/content.ts', 'utf8') +
      readFileSync('src/pipeline/steps/publish.ts', 'utf8') +
      readFileSync('src/pipeline/steps/article.ts', 'utf8') +
      readFileSync('src/pipeline/steps/reel.ts', 'utf8');

    for (const node of FLOW_NODES) {
      if (node.step === START) continue;
      expect(source, `"${node.step}" is on no step in the pipeline`).toContain(`'${node.step}'`);
    }
  });

  it('names prompt files that are on disk', () => {
    const files = readdirSync('prompts').filter((f) => f.endsWith('.txt'));
    for (const node of FLOW_NODES) {
      if (!node.promptFile) continue;
      const hit = files.some((f) => f.startsWith(`${node.promptFile}.`));
      expect(hit, `no prompt file for "${node.promptFile}"`).toBe(true);
    }
  });
});
