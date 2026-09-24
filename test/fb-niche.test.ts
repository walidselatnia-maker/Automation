import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  deleteFbToken,
  fbPageToken,
  fbTokenSecret,
  insertFbToken,
  listFbPages,
  listFbTokens,
  pageForNiche,
  setFbPageOptions,
  syncFbPages,
} from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * One page, one niche. Pages exist only because a token said so, and the
 * three things a person sets on a page -- niche, auto-publish, enabled --
 * survive every sync.
 */

const KEY = randomBytes(32);

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
});
afterEach(() => closeDatabase());

const sorted = () => [...listFbPages()].sort((a, b) => a.page_id.localeCompare(b.page_id));

describe('tokens and their pages', () => {
  it('stores a token encrypted and reads it back', () => {
    const id = insertFbToken('App 1', 'EAAB-secret', KEY);

    expect(listFbTokens()[0]).toMatchObject({ id, name: 'App 1', page_count: 0 });
    expect(listFbTokens()[0]!.token_encrypted).not.toContain('EAAB');
    expect(fbTokenSecret(id, KEY)).toBe('EAAB-secret');
  });

  it('names an unnamed token and refuses an empty one', () => {
    insertFbToken('  ', 'x', KEY);
    expect(listFbTokens()[0]!.name).toBe('Token 1');
    expect(() => insertFbToken('B', '  ', KEY)).toThrow(/token/i);
  });

  it('sync adds, renames, and disables pages that left the token', () => {
    const t = insertFbToken('App 1', 'x', KEY);
    expect(
      syncFbPages(t, [
        { id: '1', name: 'One' },
        { id: '2', name: 'Two' },
      ]),
    ).toEqual({ added: 2, renamed: 0, dropped: 0 });
    setFbPageOptions(sorted()[0]!.id, { niche: 'soup', autoPublish: false, enabled: true });

    expect(syncFbPages(t, [{ id: '1', name: 'One renamed' }])).toEqual({
      added: 0,
      renamed: 1,
      dropped: 1,
    });

    const [one, two] = sorted();
    expect(one).toMatchObject({ name: 'One renamed', niche: 'soup', auto_publish: 0, enabled: 1 });
    expect(two).toMatchObject({ enabled: 0, last_error: 'No longer under this token' });
    expect(listFbTokens()[0]!.page_count).toBe(2);
  });

  it('a new page arrives with auto-publish on', () => {
    const t = insertFbToken('A', 'x', KEY);
    syncFbPages(t, [{ id: '1', name: 'One' }]);
    expect(listFbPages()[0]).toMatchObject({ auto_publish: 1, enabled: 1, niche: null });
  });

  it('deleting a token deletes its pages', () => {
    const t = insertFbToken('App 1', 'x', KEY);
    syncFbPages(t, [{ id: '1', name: 'One' }]);
    deleteFbToken(t);
    expect(listFbPages()).toEqual([]);
    expect(listFbTokens()).toEqual([]);
  });

  it('the page token is the token of the page', () => {
    const a = insertFbToken('A', 'tok-a', KEY);
    const b = insertFbToken('B', 'tok-b', KEY);
    syncFbPages(a, [{ id: '1', name: 'One' }]);
    syncFbPages(b, [{ id: '2', name: 'Two' }]);

    const two = listFbPages().find((p) => p.page_id === '2')!;
    expect(fbPageToken(two.id, KEY)).toBe('tok-b');
  });
});

describe('niches', () => {
  const twoPages = () => {
    const t = insertFbToken('A', 'x', KEY);
    syncFbPages(t, [
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);
    const [one, two] = sorted();
    return { one: one!, two: two! };
  };

  it('finds the enabled page for a niche, ignoring case', () => {
    const { one } = twoPages();
    setFbPageOptions(one.id, { niche: 'Slow Cooker', autoPublish: true, enabled: true });

    expect(pageForNiche('slow cooker')?.id).toBe(one.id);
    expect(pageForNiche('cake')).toBeUndefined();
  });

  it('a disabled page is not found', () => {
    const { one } = twoPages();
    setFbPageOptions(one.id, { niche: 'soup', autoPublish: true, enabled: false });
    expect(pageForNiche('soup')).toBeUndefined();
  });

  it('refuses a niche another enabled page already holds, naming it', () => {
    const { one, two } = twoPages();
    setFbPageOptions(one.id, { niche: 'soup', autoPublish: true, enabled: true });

    expect(() =>
      setFbPageOptions(two.id, { niche: 'SOUP', autoPublish: true, enabled: true }),
    ).toThrow(/already on One/);
  });

  it('a disabled page may keep a niche another page takes over', () => {
    const { one, two } = twoPages();
    setFbPageOptions(one.id, { niche: 'soup', autoPublish: true, enabled: false });
    setFbPageOptions(two.id, { niche: 'soup', autoPublish: true, enabled: true });
    expect(pageForNiche('soup')?.id).toBe(two.id);
  });

  it('blank niche means not used', () => {
    const { one } = twoPages();
    setFbPageOptions(one.id, { niche: '  ', autoPublish: true, enabled: true });
    expect(listFbPages().find((p) => p.id === one.id)!.niche).toBeNull();
  });
});
