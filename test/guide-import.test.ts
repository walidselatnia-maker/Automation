import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, openDatabase } from '../src/db/index.js';
import { getKeyword, insertKeyword, setKeywordStatus, setLink, upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import { importShortlist, importShortlistReport } from '../src/guide/import.js';

/**
 * The last step of a pillar round: the shortlist becomes ordinary keywords,
 * switched on for this site, so the scheduler writes them like any other.
 */

const KEY = randomBytes(32);
let siteId = 0;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  siteId = upsertSite(
    {
      name: 'bitespoon',
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

describe('importShortlist', () => {
  it('adds each item as a keyword switched on for the site', () => {
    const ids = importShortlist(siteId, 'Chicken', [
      { keyword: 'chicken dinner guide', type: 'article' },
      { keyword: 'crispy chicken thighs', type: 'recipe' },
    ]);
    expect(ids).toHaveLength(2);

    const article = getKeyword(ids[0])!;
    expect(article).toMatchObject({
      seed_keyword: 'chicken dinner guide',
      content_type: 'article',
      niche: 'Chicken',
      annotation: 'guide:Chicken',
      status: 'go',
    });
    expect(getKeyword(ids[1])).toMatchObject({ content_type: 'recipe', niche: '' });

    const links = all<{ keyword_id: number; status: string }>(
      'SELECT keyword_id, status FROM keyword_sites WHERE site_id = ? ORDER BY keyword_id',
      siteId,
    );
    expect(links).toEqual(ids.map((keyword_id) => ({ keyword_id, status: 'go' })));
  });

  it('links an exact existing keyword instead of adding it twice', () => {
    const existing = insertKeyword({ seed_keyword: 'Crispy Chicken Thighs' });
    setKeywordStatus(existing, 'done');

    const ids = importShortlist(siteId, 'Chicken', [{ keyword: 'crispy chicken thighs', type: 'recipe' }]);

    expect(ids).toEqual([existing]);
    expect(getKeyword(existing)?.status).toBe('go');
    expect(all('SELECT id FROM keywords')).toHaveLength(1);
    expect(linkOf(existing)).toBe('go');
  });

  it('leaves a keyword already published on this site alone', () => {
    const existing = insertKeyword({ seed_keyword: 'crispy chicken thighs' });
    setLink(existing, siteId, 'done');

    const report = importShortlistReport(siteId, 'Chicken', [{ keyword: 'crispy chicken thighs', type: 'recipe' }]);

    expect(linkOf(existing)).toBe('done');
    expect(report.ids).toEqual([existing]);
    expect(report.alreadyOnSite).toEqual([existing]);
    expect(report.switchedOff).toEqual([]);
  });

  it('does not switch a keyword back on that was turned off everywhere', () => {
    const existing = insertKeyword({ seed_keyword: 'crispy chicken thighs' });
    setKeywordStatus(existing, 'no');

    const report = importShortlistReport(siteId, 'Chicken', [{ keyword: 'crispy chicken thighs', type: 'recipe' }]);

    expect(getKeyword(existing)?.status).toBe('no');
    expect(linkOf(existing)).toBe('go');
    expect(report.ids).toEqual([existing]);
    expect(report.switchedOff).toEqual([existing]);
    expect(report.alreadyOnSite).toEqual([]);
  });

  it('reports nothing skipped for new and plainly reused keywords', () => {
    const existing = insertKeyword({ seed_keyword: 'a b c' });
    const report = importShortlistReport(siteId, 'Chicken', [
      { keyword: 'a b c', type: 'recipe' },
      { keyword: 'x y z', type: 'recipe' },
    ]);
    expect(report.ids).toHaveLength(2);
    expect(report.ids[0]).toBe(existing);
    expect(report.alreadyOnSite).toEqual([]);
    expect(report.switchedOff).toEqual([]);
  });
});

function linkOf(keywordId: number): string | undefined {
  return all<{ status: string }>(
    'SELECT status FROM keyword_sites WHERE keyword_id = ? AND site_id = ?',
    keywordId,
    siteId,
  )[0]?.status;
}
