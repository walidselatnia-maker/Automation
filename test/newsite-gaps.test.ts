import { describe, expect, it } from 'vitest';
import { articleGapMinutes, randomGapMinutes, seededUnit, socialDueAt } from '../src/newsite/gaps.js';

const site = { id: 3, interval_minutes: 240, random_gap_from: 0, random_gap_to: 0, social_gap_from: 0, social_gap_to: 0 };

describe('Random posting gaps', () => {
  it('draws the same number for the same seed, between 0 and 1', () => {
    expect(seededUnit('a')).toBe(seededUnit('a'));
    expect(seededUnit('a')).not.toBe(seededUnit('b'));
    for (let i = 0; i < 200; i++) {
      const u = seededUnit(String(i));
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('keeps every random gap inside its range, both ends included, and spreads over it', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const m = randomGapMinutes(10, 14, `s${i}`);
      expect(m).toBeGreaterThanOrEqual(10);
      expect(m).toBeLessThanOrEqual(14);
      seen.add(m);
    }
    expect([...seen].sort()).toEqual([10, 11, 12, 13, 14]);
    expect(randomGapMinutes(30, 30, 'x')).toBe(30);
  });

  it('uses the fixed gap when no random gap is set, exactly as before', () => {
    expect(articleGapMinutes(site, 1000)).toBe(240);
    expect(articleGapMinutes(site, 99999)).toBe(240);
  });

  it('uses a random gap inside the range when one is set, the same at every look after one article', () => {
    const r = { ...site, random_gap_from: 120, random_gap_to: 360 };
    const a = articleGapMinutes(r, 1_700_000_000_000);
    expect(a).toBeGreaterThanOrEqual(120);
    expect(a).toBeLessThanOrEqual(360);
    expect(articleGapMinutes(r, 1_700_000_000_000)).toBe(a);
    const after = new Set(Array.from({ length: 50 }, (_, i) => articleGapMinutes(r, 1_700_000_000_000 + i * 60_000)));
    expect(after.size).toBeGreaterThan(10); // a new draw after each article
  });

  it('lets a social post go at once when no social gap is set, or nothing was sent yet', () => {
    expect(socialDueAt(site, 1, 1_700_000_000_000)).toBe(0);
    expect(socialDueAt({ ...site, social_gap_from: 30, social_gap_to: 90 }, 1, 0)).toBe(0);
  });

  it('makes the next social post to a channel wait a random time inside the range after the last one', () => {
    const r = { ...site, social_gap_from: 30, social_gap_to: 90 };
    const last = 1_700_000_000_000;
    const due = socialDueAt(r, 7, last);
    expect(due).toBeGreaterThanOrEqual(last + 30 * 60_000);
    expect(due).toBeLessThanOrEqual(last + 90 * 60_000);
    expect(socialDueAt(r, 7, last)).toBe(due);
  });
});
