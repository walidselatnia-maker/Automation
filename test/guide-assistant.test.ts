import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { insertKeyword, setLink, upsertSite } from '../src/db/repos.js';
import { NoEndpointAvailableError } from '../src/llm/client.js';
import { setLogLevel } from '../src/lib/logger.js';
import { parseReply, respond, type Ask } from '../src/guide/assistant.js';
import { getCursor, goTo, listMessages, markDone, saveResult } from '../src/guide/state.js';

/**
 * The assistant is a loop around one model call: build the variables from what
 * the site has decided, ask, check the reply, keep the chat. Step 4 asks twice
 * with Google in between; step 5 drops keywords the site already has.
 */

const KEY = randomBytes(32);
let siteId = 0;

const reply = (fields: Record<string, unknown>) =>
  JSON.stringify({ message: 'ok', choices: [], multi: false, draft: null, ...fields });

const noSuggest = async () => [] as string[];

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  siteId = upsertSite(
    {
      name: 'Bitespoon',
      domain: 'bitespoon.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 1,
      interval_minutes: 0,
    },
    KEY,
  );
});
afterEach(() => closeDatabase());

describe('parseReply', () => {
  it('reads message, choices and a valid draft', () => {
    const parsed = parseReply(
      reply({ choices: ['a', 'b'], draft: { identity: 'Quick dinners for busy parents' } }),
      'identity',
    );
    expect(parsed?.reply).toEqual({
      message: 'ok',
      choices: ['a', 'b'],
      multi: false,
      draft: { identity: 'Quick dinners for busy parents' },
    });
    expect(parsed?.problem).toBeNull();
  });

  it('drops an invalid draft and says why', () => {
    const parsed = parseReply(reply({ draft: { pillars: ['one'] } }), 'pillars');
    expect(parsed?.reply.draft).toBeNull();
    expect(parsed?.problem).toMatch(/exactly 3/);
  });

  it('caps choices at eight and refuses a reply with no message', () => {
    const many = Array.from({ length: 12 }, (_, i) => `c${i}`);
    expect(parseReply(reply({ choices: many }), 'identity')?.reply.choices).toHaveLength(8);
    expect(parseReply('{"choices": []}', 'identity')).toBeNull();
    expect(parseReply('not json at all', 'identity')).toBeNull();
  });
});

describe('respond', () => {
  it('opens a step with the site in the variables and stores the reply', async () => {
    const seen: Record<string, unknown>[] = [];
    const ask: Ask = async (name, vars) => {
      expect(name).toBe('guide-identity');
      seen.push(vars);
      return reply({ message: 'Who cooks?', choices: ['Parents', 'Students'] });
    };

    const out = await respond({ ask, suggest: noSuggest }, siteId, null);

    expect(out.message).toBe('Who cooks?');
    expect(seen[0]).toMatchObject({ site_domain: 'bitespoon.com', user_text: '', history: '(nothing yet)' });
    const stored = listMessages(siteId, 'identity', 1);
    expect(stored.map((m) => m.role)).toEqual(['assistant']);
    expect(stored[0].payload).toMatchObject({ choices: ['Parents', 'Students'] });
  });

  it('stores what the person said and passes the history', async () => {
    await respond({ ask: async () => reply({ message: 'Who cooks?' }), suggest: noSuggest }, siteId, null);
    let vars: Record<string, unknown> = {};
    await respond(
      { ask: async (_n, v) => ((vars = v), reply({ message: 'Got it' })), suggest: noSuggest },
      siteId,
      'Parents',
    );
    expect(vars.user_text).toBe('Parents');
    expect(vars.history).toBe('YOU: Who cooks?');
    expect(listMessages(siteId, 'identity', 1).map((m) => m.content)).toEqual([
      'Who cooks?', 'Parents', 'Got it',
    ]);
  });

  it('asks once more when the draft is invalid, with the problem', async () => {
    const extras: unknown[] = [];
    let n = 0;
    const ask: Ask = async (_name, vars) => {
      extras.push(vars.extra);
      n += 1;
      return n === 1
        ? reply({ draft: { identity: 'x' } })
        : reply({ draft: { identity: 'Quick dinners for busy parents' } });
    };
    const out = await respond({ ask, suggest: noSuggest }, siteId, 'go');
    expect(n).toBe(2);
    expect(extras[1]).toMatchObject({ problem: expect.any(String) });
    expect(out.draft).toEqual({ identity: 'Quick dinners for busy parents' });
  });

  it('says it is confused rather than throwing on nonsense', async () => {
    const out = await respond({ ask: async () => 'nonsense', suggest: noSuggest }, siteId, 'hi');
    expect(out.message).toMatch(/confused/);
    expect(listMessages(siteId, 'identity', 1).map((m) => m.role)).toEqual(['user']);
  });

  it('says plainly when no model can be reached', async () => {
    const ask: Ask = async () => {
      throw new NoEndpointAvailableError('gpt-oss:120b', [], '');
    };
    const out = await respond({ ask, suggest: noSuggest }, siteId, null);
    expect(out.message).toMatch(/can't reach a model/);
  });

  it('step 4: expands seeds through Google, then asks the model to pick', async () => {
    reachStep('keywords');
    const phases: unknown[] = [];
    const ask: Ask = async (_name, vars) => {
      const extra = vars.extra as { phase: string; suggestions?: string[] };
      phases.push(extra);
      if (extra.phase === 'start') return reply({ seeds: ['chicken thighs'], pillar: 'Chicken' });
      return reply({
        draft: { pillar: 'Chicken', keywords: extra.suggestions!.slice(0, 10) },
      });
    };
    const suggestions = Array.from({ length: 12 }, (_, i) => `crispy chicken thighs ${i}`);
    let seeded: string[] = [];
    const out = await respond(
      { ask, suggest: async (s) => ((seeded = s), suggestions) },
      siteId,
      'Chicken',
    );
    expect(seeded).toEqual(['chicken thighs']);
    expect(phases[1]).toMatchObject({ phase: 'pick', pillar: 'Chicken', suggestions, verified: true });
    expect(out.draft).toMatchObject({ pillar: 'Chicken', verified: true });
    // Only the final reply is kept, not the "checking…" one.
    expect(listMessages(siteId, 'keywords', 1).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('step 4: marks the list unverified when Google gave nothing', async () => {
    reachStep('keywords');
    const ten = Array.from({ length: 10 }, (_, i) => `easy chicken dinner ${i}`);
    const ask: Ask = async (_name, vars) =>
      (vars.extra as { phase: string }).phase === 'start'
        ? reply({ seeds: ['chicken'], pillar: 'Chicken' })
        : reply({ draft: { pillar: 'Chicken', keywords: ten } });
    const out = await respond({ ask, suggest: noSuggest }, siteId, 'Chicken');
    expect(out.draft).toMatchObject({ verified: false });
  });

  it('step 4: marks the list unverified when Google check throws', async () => {
    reachStep('keywords');
    const ten = Array.from({ length: 10 }, (_, i) => `easy chicken dinner ${i}`);
    const ask: Ask = async (_name, vars) =>
      (vars.extra as { phase: string }).phase === 'start'
        ? reply({ seeds: ['chicken'], pillar: 'Chicken' })
        : reply({ draft: { pillar: 'Chicken', keywords: ten } });
    const throwingSuggest = async () => {
      throw new Error('Google service error');
    };
    const out = await respond({ ask, suggest: throwingSuggest }, siteId, 'Chicken');
    expect(out.message).not.toMatch(/confused/);
    expect(out.draft).toMatchObject({ verified: false });
  });

  it('step 4: a start-phase draft with no seeds is never verified', async () => {
    reachStep('keywords');
    const ten = Array.from({ length: 10 }, (_, i) => `easy chicken dinner ${i}`);
    const ask: Ask = async () => reply({ draft: { pillar: 'Chicken', keywords: ten } });
    const out = await respond({ ask, suggest: async () => ten }, siteId, 'Chicken');
    expect(out.draft).toMatchObject({ verified: false });
  });

  it('step 4: one invented keyword makes the whole draft unverified', async () => {
    reachStep('keywords');
    const suggestions = Array.from({ length: 10 }, (_, i) => `crispy chicken thighs ${i}`);
    const ask: Ask = async (_name, vars) =>
      (vars.extra as { phase: string }).phase === 'start'
        ? reply({ seeds: ['chicken'], pillar: 'Chicken' })
        : reply({ draft: { pillar: 'Chicken', keywords: [...suggestions.slice(0, 9), 'made up phrase'] } });
    const out = await respond({ ask, suggest: async () => suggestions }, siteId, 'Chicken');
    expect(out.draft).toMatchObject({ verified: false });
  });

  it('step 4: a pick made only from suggestions is verified, ignoring case and spacing', async () => {
    reachStep('keywords');
    const suggestions = Array.from({ length: 10 }, (_, i) => `crispy chicken thighs ${i}`);
    const ask: Ask = async (_name, vars) =>
      (vars.extra as { phase: string }).phase === 'start'
        ? reply({ seeds: ['chicken'], pillar: 'Chicken' })
        : reply({ draft: { pillar: 'Chicken', keywords: suggestions.map((s) => ` ${s.toUpperCase()} `) } });
    const out = await respond({ ask, suggest: async () => suggestions }, siteId, 'Chicken');
    expect(out.draft).toMatchObject({ verified: true });
  });

  it('passes the last draft back to the model on a follow-up', async () => {
    reachStep('keywords');
    const ten = Array.from({ length: 10 }, (_, i) => `easy chicken dinner ${i}`);
    const extras: Record<string, unknown>[] = [];
    const ask: Ask = async (_name, vars) => {
      extras.push(vars.extra as Record<string, unknown>);
      return reply({ draft: { pillar: 'Chicken', keywords: ten } });
    };
    await respond({ ask, suggest: noSuggest }, siteId, 'Chicken');
    expect(extras[0]).not.toHaveProperty('current_draft');
    await respond({ ask, suggest: noSuggest }, siteId, 'swap the first one');
    expect(extras[1].current_draft).toMatchObject({ pillar: 'Chicken', keywords: ten });
  });

  it('step 5: leaves out keywords the site already has', async () => {
    reachStep('shortlist');
    const id = insertKeyword({ seed_keyword: 'honey garlic chicken thighs' });
    setLink(id, siteId, 'go');
    let extra: Record<string, unknown> = {};
    await respond(
      { ask: async (_n, v) => ((extra = v.extra as Record<string, unknown>), reply({})), suggest: noSuggest },
      siteId,
      null,
    );
    expect(extra.pillar).toBe('Chicken');
    expect(extra.already_have).toEqual(['Honey garlic chicken thighs']);
    expect((extra.keywords as string[]).length).toBe(10);
  });
});

/** Fill the site's results up to `step` and put the cursor there. */
function reachStep(step: 'keywords' | 'shortlist') {
  saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
  markDone(siteId);
  saveResult(siteId, 'pillars', 1, { pillars: ['Chicken', 'Pasta', 'Soup'] });
  markDone(siteId);
  saveResult(siteId, 'search-console', 1, { confirmed: true });
  markDone(siteId);
  if (step === 'shortlist') {
    saveResult(siteId, 'keywords', 1, {
      pillar: 'Chicken',
      keywords: [
        'Honey garlic chicken thighs',
        ...Array.from({ length: 10 }, (_, i) => `easy chicken dinner ${i}`),
      ],
    });
    markDone(siteId);
  }
  expect(goTo(siteId, step)).toBe(true);
  expect(getCursor(siteId).step).toBe(step);
}
