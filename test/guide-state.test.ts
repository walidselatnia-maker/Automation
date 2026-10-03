import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { insertKeyword, setLink, upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import {
  addMessage,
  canOpen,
  existingKeywordsForSite,
  getCursor,
  getResult,
  goBack,
  goTo,
  isRoundFinished,
  listMessages,
  markDone,
  progressFor,
  saveResult,
  siteContext,
  startNextPillar,
} from '../src/guide/state.js';

/**
 * Where a site is in the guide, and what it decided along the way. Progress is
 * per site; steps 4–6 are per pillar round, so a second pillar starts clean
 * without losing the site's identity or pillars.
 */

const KEY = randomBytes(32);
let siteId = 0;

const site = (domain: string) =>
  upsertSite(
    {
      name: domain,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 1,
      interval_minutes: 0,
    },
    KEY,
  );

const keywords = (n: number) => Array.from({ length: n }, (_, i) => `easy chicken dinner ${i}`);

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  siteId = site('bitespoon.com');
});
afterEach(() => closeDatabase());

describe('guide state', () => {
  it('starts a new site at step 1, round 1', () => {
    expect(progressFor(siteId).started).toBe(false);
    expect(getCursor(siteId)).toEqual({ siteId, step: 'identity', round: 1 });
    expect(progressFor(siteId)).toMatchObject({ started: true, index: 1, total: 6, finished: false });
  });

  it('refuses Done until the step has a result', () => {
    expect(markDone(siteId)).toEqual({ ok: false, problem: expect.any(String) });
    expect(saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' }).ok).toBe(true);
    expect(markDone(siteId)).toEqual({ ok: true, next: 'pillars' });
    expect(getCursor(siteId).step).toBe('pillars');
  });

  it('refuses an invalid result and keeps the old one', () => {
    saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
    const bad = saveResult(siteId, 'identity', 1, { identity: 'x' });
    expect(bad.ok).toBe(false);
    expect(getResult(siteId, 'identity', 1)).toEqual({ identity: 'Quick dinners for busy parents' });
  });

  it('keeps site-wide results across rounds and per-round results apart', () => {
    saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
    expect(getResult(siteId, 'identity', 2)).toEqual({ identity: 'Quick dinners for busy parents' });

    saveResult(siteId, 'keywords', 1, { pillar: 'Chicken', keywords: keywords(10) });
    expect(getResult(siteId, 'keywords', 2)).toBeNull();
  });

  it('goes back one step, and only opens done steps or the next open one', () => {
    saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
    markDone(siteId);
    goBack(siteId);
    expect(getCursor(siteId).step).toBe('identity');
    expect(canOpen(siteId, 'pillars')).toBe(true);
    expect(canOpen(siteId, 'keywords')).toBe(false);
    expect(goTo(siteId, 'keywords')).toBe(false);
    expect(goTo(siteId, 'pillars')).toBe(true);
    expect(getCursor(siteId).step).toBe('pillars');
  });

  it('builds the context later steps need', () => {
    saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
    saveResult(siteId, 'pillars', 1, { pillars: ['Chicken', 'Pasta', 'Soup'] });
    saveResult(siteId, 'keywords', 1, { pillar: 'Chicken', keywords: keywords(10) });
    expect(siteContext(siteId, 1)).toEqual({
      identity: 'Quick dinners for busy parents',
      pillars: ['Chicken', 'Pasta', 'Soup'],
      currentPillar: 'Chicken',
    });
    expect(siteContext(siteId, 2).currentPillar).toBe('');
  });

  it('starts the next pillar only after the import is done', () => {
    expect(startNextPillar(siteId)).toBe(false);
    goToImportDone();
    expect(isRoundFinished(siteId)).toBe(true);
    expect(startNextPillar(siteId)).toBe(true);
    expect(getCursor(siteId)).toEqual({ siteId, step: 'keywords', round: 2 });
  });

  it('keeps the chat per step and round, oldest first', () => {
    addMessage(siteId, 'identity', 1, 'assistant', 'Hi', { choices: ['A'] });
    addMessage(siteId, 'identity', 1, 'user', 'A');
    addMessage(siteId, 'keywords', 1, 'user', 'other step');
    const messages = listMessages(siteId, 'identity', 1);
    expect(messages.map((m) => m.content)).toEqual(['Hi', 'A']);
    expect(messages[0].payload).toEqual({ choices: ['A'] });
  });

  it('lists the keywords already linked to the site', () => {
    const id = insertKeyword({ seed_keyword: 'honey garlic chicken' });
    setLink(id, siteId, 'go');
    insertKeyword({ seed_keyword: 'not linked' });
    expect(existingKeywordsForSite(siteId)).toEqual(['honey garlic chicken']);
  });
});

function goToImportDone() {
  saveResult(siteId, 'identity', 1, { identity: 'Quick dinners for busy parents' });
  markDone(siteId);
  saveResult(siteId, 'pillars', 1, { pillars: ['Chicken', 'Pasta', 'Soup'] });
  markDone(siteId);
  saveResult(siteId, 'search-console', 1, { confirmed: true });
  markDone(siteId);
  saveResult(siteId, 'keywords', 1, { pillar: 'Chicken', keywords: keywords(10) });
  markDone(siteId);
  saveResult(siteId, 'shortlist', 1, {
    pillar: 'Chicken',
    items: [
      { keyword: 'chicken guide', type: 'article' },
      ...keywords(5).map((keyword) => ({ keyword, type: 'recipe' })),
    ],
  });
  markDone(siteId);
  saveResult(siteId, 'import', 1, { imported_ids: [1] });
  markDone(siteId);
}
