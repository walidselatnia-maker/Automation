import { describe, expect, it } from 'vitest';
import {
  expandSeeds,
  parseSuggestResponse,
  suggest,
  SUGGEST_MODIFIERS,
} from '../src/integrations/google-suggest.js';

/**
 * A model alone invents keywords nobody types. Google's autocomplete is what
 * people actually type, free and keyless; these tests pin its response shape
 * and keep the number of requests bounded.
 */

const answer = (body: unknown, ok = true) =>
  ({ ok, json: async () => body }) as unknown as Response;

describe('google suggest', () => {
  it('reads the client=firefox shape', () => {
    expect(parseSuggestResponse(['chicken', ['chicken thighs', ' chicken soup ', 3]])).toEqual([
      'chicken thighs',
      'chicken soup',
    ]);
    expect(parseSuggestResponse({})).toEqual([]);
    expect(parseSuggestResponse(['q'])).toEqual([]);
  });

  it('returns nothing when Google fails or refuses', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await suggest('x', { fetchImpl: throwing })).toEqual([]);
    const refused = (async () => answer(null, false)) as unknown as typeof fetch;
    expect(await suggest('x', { fetchImpl: refused })).toEqual([]);
  });

  it('asks for each seed with each modifier, de-duplicated', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      const q = new URL(url).searchParams.get('q')!;
      asked.push(q);
      return answer([q, [`${q} recipe`, 'Same Everywhere']]);
    }) as unknown as typeof fetch;

    const out = await expandSeeds(['chicken', ' '], { fetchImpl, delayMs: 0 });

    expect(asked).toHaveLength(SUGGEST_MODIFIERS.length);
    expect(asked[0]).toBe('chicken');
    expect(asked).toContain('chicken can you');
    expect(out.filter((s) => s.toLowerCase() === 'same everywhere')).toHaveLength(1);
    expect(out).toContain('chicken how recipe');
  });

  it('never sends more than the cap', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return answer(['q', []]);
    }) as unknown as typeof fetch;
    await expandSeeds(['a', 'b', 'c'], { fetchImpl, delayMs: 0, maxRequests: 5 });
    expect(calls).toBe(5);
  });

  it('stops asking once the overall deadline has passed', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return answer(['q', [`found ${calls}`]]);
    }) as unknown as typeof fetch;
    const out = await expandSeeds(['a', 'b', 'c'], { fetchImpl, delayMs: 20, deadlineMs: 50 });
    expect(calls).toBeLessThan(6);
    expect(calls).toBeGreaterThan(0);
    expect(out.length).toBe(calls);
  });
});
