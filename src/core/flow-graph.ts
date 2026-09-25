/**
 * The pipeline, as a picture you can trace a bad result backwards through.
 *
 * Not a diagram of the architecture. The question this answers is the one
 * asked while looking at a picture that came out wrong: which words produced
 * it, and where are those words written? So every node names the prompt file
 * responsible for its input and the settings that shape it, and the edges run
 * the way the data ran.
 *
 * The order here mirrors executePipeline. It is written out rather than
 * derived from it because the pipeline is a function with branches, not a
 * list, and a wrong picture is worse than none: this file and
 * pipeline/index.ts have to be changed together, which is what
 * test/flow-graph.test.ts checks.
 */

export type FlowNodeKind = 'source' | 'text' | 'image' | 'publish' | 'video';

export interface FlowNode {
  /** Matches run_steps.step when the node is a step; '' for the inputs. */
  step: string;
  title: string;
  kind: FlowNodeKind;
  /** One line on the card: what this does, for someone who has never read the code. */
  blurb: string;
  /** The prompt file whose words produced this node's output, if any. */
  promptFile?: string;
  /** Where the knobs for this node live. */
  settings?: { label: string; href: string };
  /** Laid out left to right in columns, top to bottom within one. */
  column: number;
  row: number;
}

export interface FlowEdge {
  from: string;
  to: string;
}

/** The id used for the node that stands for the keyword, which is no step. */
export const START = '__start';

export const FLOW_NODES: readonly FlowNode[] = [
  {
    step: START,
    title: 'Keyword',
    kind: 'source',
    blurb: 'The keyword and the page it was spied from. Everything below is written from these.',
    settings: { label: 'Keywords', href: '/keywords' },
    column: 0,
    row: 1,
  },
  {
    step: 'validate-spy',
    title: 'Title & description',
    kind: 'text',
    blurb: 'Reads the spied page and decides the recipe name, the meta description and the category.',
    promptFile: 'spy-validation',
    column: 1,
    row: 1,
  },
  {
    step: 'generate-recipe',
    title: 'Recipe',
    kind: 'text',
    blurb: 'Writes the ingredients and the method. Everything downstream quotes this.',
    promptFile: 'recipe-generator',
    column: 2,
    row: 1,
  },
  {
    step: 'generate-image-prompts',
    title: 'Image prompts',
    kind: 'text',
    blurb: 'Writes the six photo briefs. A picture that came out wrong was described wrong here.',
    promptFile: 'image-prompts',
    column: 3,
    row: 1,
  },
  {
    step: 'generate-image-feature',
    title: 'Feature image',
    kind: 'image',
    blurb: 'The hero shot, from the feature brief.',
    promptFile: 'image-prompts',
    settings: { label: 'Image generation', href: '/settings' },
    column: 4,
    row: 0,
  },
  {
    step: 'generate-image-top-shot',
    title: 'Top shot',
    kind: 'image',
    blurb: 'Overhead, from the top-shot brief.',
    promptFile: 'image-prompts',
    settings: { label: 'Image generation', href: '/settings' },
    column: 4,
    row: 1,
  },
  {
    step: 'generate-image-texture-macro',
    title: 'Texture macro',
    kind: 'image',
    blurb: 'The close-up, from the texture brief.',
    promptFile: 'image-prompts',
    settings: { label: 'Image generation', href: '/settings' },
    column: 4,
    row: 2,
  },
  {
    step: 'generate-image-before-after',
    title: 'Before / after',
    kind: 'image',
    blurb: 'The pair, from the before/after brief.',
    promptFile: 'image-prompts',
    settings: { label: 'Image generation', href: '/settings' },
    column: 4,
    row: 3,
  },
  {
    step: 'generate-article',
    title: 'Article',
    kind: 'text',
    blurb: 'Writes the post in three parts, around the images.',
    promptFile: 'part-1',
    column: 5,
    row: 1,
  },
  {
    step: 'post-article',
    title: 'Publish to the site',
    kind: 'publish',
    blurb: 'Posts it. Everything after this is distribution.',
    settings: { label: 'Sites', href: '/sites' },
    column: 6,
    row: 1,
  },
  {
    step: 'generate-pin-image',
    title: 'Pin graphic',
    kind: 'image',
    blurb: 'The Pinterest picture, from its own template rather than the article briefs.',
    promptFile: 'pin-graphic',
    column: 7,
    row: 0,
  },
  {
    step: 'generate-pin-description',
    title: 'Pin text',
    kind: 'text',
    blurb: 'What the pin says.',
    promptFile: 'pin-description',
    column: 8,
    row: 0,
  },
  {
    step: 'publish-to-buffer',
    title: 'Pin to Buffer',
    kind: 'publish',
    blurb: 'Queues the pin. Skipped entirely when Buffer is off.',
    settings: { label: 'Buffer', href: '/settings' },
    column: 9,
    row: 0,
  },
  {
    step: 'create-reel',
    title: 'Reel',
    kind: 'video',
    blurb: 'Sends the photos and one prompt to Flow, and the clip goes to the page.',
    promptFile: 'reel-video',
    settings: { label: 'Reels', href: '/settings/reels' },
    column: 7,
    row: 2,
  },
];

export const FLOW_EDGES: readonly FlowEdge[] = [
  { from: START, to: 'validate-spy' },
  { from: 'validate-spy', to: 'generate-recipe' },
  { from: 'generate-recipe', to: 'generate-image-prompts' },
  { from: 'generate-image-prompts', to: 'generate-image-feature' },
  { from: 'generate-image-prompts', to: 'generate-image-top-shot' },
  { from: 'generate-image-prompts', to: 'generate-image-texture-macro' },
  { from: 'generate-image-prompts', to: 'generate-image-before-after' },
  { from: 'generate-image-feature', to: 'generate-article' },
  { from: 'generate-image-top-shot', to: 'generate-article' },
  { from: 'generate-image-texture-macro', to: 'generate-article' },
  { from: 'generate-image-before-after', to: 'generate-article' },
  { from: 'generate-article', to: 'post-article' },
  { from: 'post-article', to: 'generate-pin-image' },
  { from: 'generate-pin-image', to: 'generate-pin-description' },
  { from: 'generate-pin-description', to: 'publish-to-buffer' },
  { from: 'post-article', to: 'create-reel' },
];

/** The image steps, in the order the article uses them. */
export const IMAGE_STEPS = FLOW_NODES.filter(
  (n) => n.kind === 'image' && n.step.startsWith('generate-image-'),
).map((n) => n.step);

export const flowNode = (step: string): FlowNode | undefined =>
  FLOW_NODES.find((n) => n.step === step);
