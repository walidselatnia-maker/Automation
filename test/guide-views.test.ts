import { describe, expect, it } from 'vitest';
import { guideCardPage, guideListPage, summarizeResult } from '../src/web/views/guide.js';
import { STEPS, stepDef } from '../src/guide/steps.js';

/**
 * One card on screen, never a wall: the map exists but is closed, the chat is
 * there, and what has been decided is shown in plain words.
 */

const site = { id: 3, name: 'Bitespoon', domain: 'bitespoon.com' };

describe('guide views', () => {
  it('lists sites with where each one is', () => {
    const out = guideListPage([
      {
        site,
        progress: { started: true, step: 'pillars', index: 2, total: 6, round: 1, finished: false },
        stepTitle: 'Pick 3 pillar topics',
      },
    ]).toString();
    expect(out).toContain('Step 2 of 6');
    expect(out).toContain('href="/guide/3"');
    expect(out).toContain('Continue');
  });

  it('shows one card, the chat, and a closed map', () => {
    const out = guideCardPage({
      site,
      step: stepDef('pillars'),
      index: 2,
      total: 6,
      round: 1,
      currentPillar: '',
      messages: [
        { id: 1, role: 'assistant', content: 'Tap 3 <b>', payload: { choices: ['A', 'B'], multi: true }, created_at: '' },
      ],
      result: null,
      map: STEPS.map((def, i) => ({ def, state: i === 0 ? 'done' : i === 1 ? 'current' : 'locked' })),
      finished: false,
    }).toString();
    expect(out).toContain('Step 2 of 6');
    expect(out).toContain('Pick 3 pillar topics');
    expect(out).toContain('Tap 3 &lt;b&gt;');
    expect(out).toContain('<details class="guide-map">');
    expect(out).not.toContain('<details class="guide-map" open');
    expect(out).toContain('data-chat-url="/guide/3/chat"');
    expect(out).toContain('name="manual"');
  });

  it('says what a saved result is in plain words', () => {
    expect(summarizeResult('identity', { identity: 'Dinners for parents' })).toEqual(['Dinners for parents']);
    expect(summarizeResult('pillars', { pillars: ['A', 'B', 'C'] })).toEqual(['A', 'B', 'C']);
    expect(
      summarizeResult('shortlist', {
        pillar: 'P',
        items: [{ keyword: 'g', type: 'article' }, { keyword: 'r', type: 'recipe' }],
      }),
    ).toEqual(['Article: g', 'Recipe: r']);
    expect(summarizeResult('identity', null)).toEqual([]);
  });
});
