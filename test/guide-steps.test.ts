import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase } from '../src/db/index.js';
import { setLogLevel } from '../src/lib/logger.js';
import {
  isStepKey,
  manualResult,
  nextStep,
  prevStep,
  STEP_KEYS,
  stepDef,
  validateResult,
} from '../src/guide/steps.js';

/**
 * The guide is six small steps in a fixed order. Each step's result has one
 * shape, and anything a model or a person hands in is cleaned and checked
 * against it before it is saved, so later steps can trust what they read.
 */

describe('guide steps', () => {
  it('runs in the agreed order', () => {
    expect(STEP_KEYS).toEqual([
      'identity', 'pillars', 'search-console', 'keywords', 'shortlist', 'import',
    ]);
    expect(nextStep('identity')).toBe('pillars');
    expect(nextStep('import')).toBeNull();
    expect(prevStep('identity')).toBeNull();
    expect(prevStep('keywords')).toBe('search-console');
    expect(isStepKey('pillars')).toBe(true);
    expect(isStepKey('nope')).toBe(false);
  });

  it('keeps steps 1–3 site-wide and 4–6 per pillar round', () => {
    expect(STEP_KEYS.filter((k) => stepDef(k).perRound)).toEqual([
      'keywords', 'shortlist', 'import',
    ]);
  });

  it('has an assistant on every step but the import', () => {
    expect(stepDef('identity').prompt).toBe('guide-identity');
    expect(stepDef('search-console').prompt).toBe('guide-search-console');
    expect(stepDef('import').prompt).toBeNull();
  });
});

describe('validateResult', () => {
  it('cleans and accepts a one-line identity', () => {
    expect(validateResult('identity', { identity: '  Quick   dinners for busy parents ' })).toEqual({
      ok: true,
      value: { identity: 'Quick dinners for busy parents' },
    });
  });

  it('rejects an identity that is too short', () => {
    const result = validateResult('identity', { identity: 'food' });
    expect(result.ok).toBe(false);
  });

  it('wants exactly three different pillars', () => {
    expect(validateResult('pillars', { pillars: ['A', 'B', 'C'] }).ok).toBe(true);
    expect(validateResult('pillars', { pillars: ['A', 'a', 'B'] }).ok).toBe(false);
    expect(validateResult('pillars', { pillars: ['A', 'B', 'C', 'D'] }).ok).toBe(false);
  });

  it('accepts search console only when confirmed', () => {
    expect(validateResult('search-console', { confirmed: true }).ok).toBe(true);
    expect(validateResult('search-console', {}).ok).toBe(false);
  });

  it('accepts 10 to 60 unique keywords with a pillar', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `easy chicken dinner ${i}`);
    expect(validateResult('keywords', { pillar: 'Chicken', keywords: ten })).toEqual({
      ok: true,
      value: { pillar: 'Chicken', keywords: ten, verified: true },
    });
    expect(validateResult('keywords', { pillar: 'Chicken', keywords: ten.slice(0, 9) }).ok).toBe(false);
    expect(validateResult('keywords', { pillar: '', keywords: ten }).ok).toBe(false);
    expect(
      validateResult('keywords', { pillar: 'C', keywords: ten, verified: false }),
    ).toMatchObject({ ok: true, value: { verified: false } });
  });

  it('wants one article and five to fifteen recipes, article first', () => {
    const recipes = Array.from({ length: 10 }, (_, i) => ({ keyword: `recipe ${i}`, type: 'recipe' }));
    const result = validateResult('shortlist', {
      pillar: 'Chicken',
      items: [...recipes, { keyword: 'chicken dinner guide', type: 'article' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { items: { type: string }[] };
      expect(value.items[0].type).toBe('article');
      expect(value.items).toHaveLength(11);
    }
    expect(validateResult('shortlist', { pillar: 'Chicken', items: recipes }).ok).toBe(false);
  });

  it('needs at least one imported id', () => {
    expect(validateResult('import', { imported_ids: [3, 4] }).ok).toBe(true);
    expect(validateResult('import', { imported_ids: [] }).ok).toBe(false);
  });
});

describe('manualResult', () => {
  it('reads typed text in the shape each step expects', () => {
    expect(manualResult('identity', 'Dinners for busy parents', '')).toEqual({
      identity: 'Dinners for busy parents',
    });
    expect(manualResult('pillars', 'A\nB\n\nC', '')).toEqual({ pillars: ['A', 'B', 'C'] });
    expect(manualResult('keywords', 'Chicken\none\ntwo', '')).toEqual({
      pillar: 'Chicken',
      keywords: ['one', 'two'],
      verified: false,
    });
    expect(manualResult('shortlist', 'guide\nr1\nr2', 'Chicken')).toEqual({
      pillar: 'Chicken',
      items: [
        { keyword: 'guide', type: 'article' },
        { keyword: 'r1', type: 'recipe' },
        { keyword: 'r2', type: 'recipe' },
      ],
    });
  });
});

describe('guide tables', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
  });
  afterEach(() => closeDatabase());

  it('exist after migrating', () => {
    for (const table of ['guide_sites', 'guide_steps', 'guide_messages']) {
      const row = get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      );
      expect(row?.name).toBe(table);
    }
  });
});
