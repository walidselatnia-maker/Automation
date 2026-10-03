import { beforeEach, describe, expect, it } from 'vitest';
import { setLogLevel } from '../src/lib/logger.js';
import {
  holdToTarget,
  isGuideRow,
  stripMachineTags,
  validateSpy,
} from '../src/pipeline/steps/content.js';
import type { PipelineContext } from '../src/pipeline/context.js';

/**
 * How spy-validation treats a guide keyword, and how it re-asks when its first
 * answer breaks an SEO rule. Only the model is faked.
 */

beforeEach(() => setLogLevel('error'));

const SEED = 'honey garlic chicken thighs';
const GOOD = {
  keyword: SEED,
  title: 'Honey Garlic Chicken Thighs With Crispy Skin',
  description: 'Sticky honey garlic chicken thighs baked until the skin crisps, ready in under an hour.',
  category: 'Dinner',
};
const BAD = { ...GOOD, title: 'Chicken' };

interface Seen {
  vars: Record<string, any>;
}

function fakeCtx(annotation: string, answers: string[], seen: Seen[] = []): PipelineContext {
  return {
    runId: 1,
    site: { domain: 'bitespoon.com' },
    keyword: {
      seed_keyword: SEED,
      spy_title: 'Crispy honey garlic thighs',
      spy_description: 'A sticky glaze.',
      spy_article_url: '',
      annotation,
    },
    prompt: async (name: string, vars: Record<string, any>) => {
      if (name !== 'spy-validation') return { content: 'not json', endpoint: 'e', model: 'm' };
      seen.push({ vars });
      return { content: answers.shift() ?? 'FALSE', endpoint: 'e', model: 'm' };
    },
  } as unknown as PipelineContext;
}

const run = (ctx: PipelineContext) => validateSpy.run(ctx, [{ id: 1, title: 'Dinner' }] as never);

describe('stripMachineTags', () => {
  it('drops guide and fallback tags and keeps the notes', () => {
    expect(stripMachineTags('guide:Dinners | Sticky glaze. | seo:fallback')).toBe('Sticky glaze.');
    expect(stripMachineTags('guide:Dinners')).toBe('');
    expect(stripMachineTags('my own note | guide:x')).toBe('my own note');
    expect(stripMachineTags('')).toBe('');
  });

  it('recognises a guide row', () => {
    expect(isGuideRow('guide:Dinners | note')).toBe(true);
    expect(isGuideRow('imported from sheet')).toBe(false);
  });
});

describe('holdToTarget', () => {
  it('keeps a keyword that contains every seed word, and replaces one that does not', () => {
    expect(holdToTarget('honey garlic chicken thighs baked', SEED)).toBe('honey garlic chicken thighs baked');
    expect(holdToTarget('baked chicken thighs', 'Honey Garlic Chicken Thighs')).toBe('honey garlic chicken thighs');
  });
});

describe('validate-spy on a guide keyword', () => {
  it('sends the seed as the target with no group, and no machine tags', async () => {
    const seen: Seen[] = [];
    await run(fakeCtx('guide:Dinners | Sticky glaze.', [JSON.stringify(GOOD)], seen));
    const { vars } = seen[0]!;
    expect(vars.spy.group).toBe('');
    expect(vars.targetSection).toContain(`TARGET KEYWORD: ${SEED}`);
    expect(vars.spy.annotation).toBe('Sticky glaze.');
  });

  it('replaces a drifted keyword with the seed', async () => {
    const drifted = { ...GOOD, keyword: 'baked chicken thighs' };
    const out = await run(fakeCtx('guide:Dinners', [JSON.stringify(drifted)]));
    expect(out.value.keyword).toBe(SEED);
  });

  it('keeps sending the topic group, and no target, for other rows', async () => {
    const seen: Seen[] = [];
    await run(fakeCtx('from the sheet', [JSON.stringify(GOOD)], seen));
    expect(seen[0]!.vars.spy.group).toBe(SEED);
    expect(seen[0]!.vars.targetSection).toBe('');
  });
});

describe('validate-spy re-ask', () => {
  const ask = (answers: string[]) => run(fakeCtx('from the sheet', answers));

  it('keeps the first answer when the second is FALSE', async () => {
    const out = await ask([JSON.stringify(BAD), 'FALSE']);
    expect(out.value.title).toBe('Chicken');
  });

  it('keeps the first answer when the second cannot be read', async () => {
    const out = await ask([JSON.stringify(BAD), 'this is not json at all']);
    expect(out.value.title).toBe('Chicken');
  });

  it('uses a better second answer', async () => {
    const out = await ask([JSON.stringify(BAD), JSON.stringify(GOOD)]);
    expect(out.value.title).toBe(GOOD.title);
  });

  it('asks only once when the first answer is fine', async () => {
    const seen: Seen[] = [];
    await run(fakeCtx('from the sheet', [JSON.stringify(GOOD)], seen));
    expect(seen).toHaveLength(1);
  });
});
