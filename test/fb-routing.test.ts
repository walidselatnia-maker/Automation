import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  deleteFbPage,
  EVERY_NICHE,
  deleteFbRoute,
  insertKeyword,
  keywordGroups,
  listFbPages,
  listFbRoutes,
  resolveFbPage,
  upsertFbPage,
  upsertFbRoute,
  upsertSite,
} from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * One site carries several nano-niches, and each niche has its own page.
 *
 * So neither half decides alone: the site cannot, because it publishes to
 * several pages, and the niche cannot, because a site may need its own page
 * for a niche that every other site shares. The pair decides, with the shared
 * route as the fallback — and no match means the reel waits, because posting a
 * recipe to the wrong audience is worse than posting it late.
 */

const KEY = randomBytes(32);

const seedSite = (domain: string): number =>
  upsertSite(
    {
      name: domain,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 1,
      interval_minutes: 60,
    },
    KEY,
  );

const addPage = (pageId: string, name: string): number =>
  upsertFbPage({ pageId, name, autoPublish: false, enabled: true });

describe('which page a reel publishes to', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
  });

  afterEach(() => closeDatabase());

  it('sends a niche to the page routed for it', () => {
    const site = seedSite('bitespoon.com');
    const page = addPage('111', 'Slow Cooker Suppers');
    upsertFbRoute({ siteId: site, seedKeyword: 'slow cooker', fbPageId: page });

    const resolved = resolveFbPage(site, 'slow cooker');

    expect(resolved?.page.page_id).toBe('111');
    expect(resolved?.via).toBe('site');
  });

  it('sends a whole site to one page with a single every-niche route', () => {
    // The case that made this necessary: a site with its own page. Naming
    // every niche one at a time is thirty routes to say one thing, and the
    // first niche anyone forgets is a reel that waits forever.
    const site = seedSite('bitespoon.com');
    const page = addPage('333', 'Bitespoon');
    upsertFbRoute({ siteId: site, seedKeyword: EVERY_NICHE, fbPageId: page });

    expect(resolveFbPage(site, 'slow cooker')?.page.page_id).toBe('333');
    expect(resolveFbPage(site, 'air fryer')?.page.page_id).toBe('333');
  });

  it('prefers the niche named on the site over that site catch-all', () => {
    const site = seedSite('bitespoon.com');
    const everything = addPage('333', 'Bitespoon');
    const specific = addPage('444', 'Slow Cooker Suppers');
    upsertFbRoute({ siteId: site, seedKeyword: EVERY_NICHE, fbPageId: everything });
    upsertFbRoute({ siteId: site, seedKeyword: 'slow cooker', fbPageId: specific });

    expect(resolveFbPage(site, 'slow cooker')?.page.page_id).toBe('444');
    expect(resolveFbPage(site, 'air fryer')?.page.page_id).toBe('333');
  });

  it('prefers this site catch-all over a shared route that names the niche', () => {
    // A page chosen for this site is a statement about this site's audience.
    // A shared route is what to do when nobody made one.
    const site = seedSite('bitespoon.com');
    const mine = addPage('333', 'Bitespoon');
    const shared = addPage('555', 'Slow Cooker Everywhere');
    upsertFbRoute({ siteId: site, seedKeyword: EVERY_NICHE, fbPageId: mine });
    upsertFbRoute({ siteId: null, seedKeyword: 'slow cooker', fbPageId: shared });

    expect(resolveFbPage(site, 'slow cooker')?.page.page_id).toBe('333');
  });

  it('uses a shared every-niche route as the last resort', () => {
    const site = seedSite('bitespoon.com');
    const page = addPage('666', 'The Everything Page');
    upsertFbRoute({ siteId: null, seedKeyword: EVERY_NICHE, fbPageId: page });

    const resolved = resolveFbPage(site, 'anything at all');

    expect(resolved?.page.page_id).toBe('666');
    expect(resolved?.via).toBe('fallback');
  });

  it('falls back to the shared route when the site has none of its own', () => {
    const site = seedSite('bitespoon.com');
    const page = addPage('222', 'Air Fryer Everything');
    upsertFbRoute({ siteId: null, seedKeyword: 'air fryer', fbPageId: page });

    const resolved = resolveFbPage(site, 'air fryer');

    expect(resolved?.page.page_id).toBe('222');
    expect(resolved?.via).toBe('fallback');
  });

  it("prefers a site's own route over the shared one", () => {
    // The case the whole design exists for: a niche normally goes to one page
    // everywhere, and one site needs its own.
    const site = seedSite('bitespoon.com');
    const other = seedSite('forkful.com');

    const shared = addPage('333', 'Air Fryer Everything');
    const mine = addPage('444', 'Bitespoon Air Fryer');

    upsertFbRoute({ siteId: null, seedKeyword: 'air fryer', fbPageId: shared });
    upsertFbRoute({ siteId: site, seedKeyword: 'air fryer', fbPageId: mine });

    expect(resolveFbPage(site, 'air fryer')?.page.page_id).toBe('444');
    expect(resolveFbPage(other, 'air fryer')?.page.page_id).toBe('333');
  });

  it('one site can publish to a different page per niche', () => {
    const site = seedSite('bitespoon.com');
    const slow = addPage('555', 'Slow Cooker');
    const fryer = addPage('666', 'Air Fryer');

    upsertFbRoute({ siteId: site, seedKeyword: 'slow cooker', fbPageId: slow });
    upsertFbRoute({ siteId: site, seedKeyword: 'air fryer', fbPageId: fryer });

    expect(resolveFbPage(site, 'slow cooker')?.page.page_id).toBe('555');
    expect(resolveFbPage(site, 'air fryer')?.page.page_id).toBe('666');
  });

  it('matches the niche without regard to case', () => {
    const site = seedSite('bitespoon.com');
    const page = addPage('777', 'Slow Cooker');
    upsertFbRoute({ siteId: site, seedKeyword: 'Slow Cooker', fbPageId: page });

    expect(resolveFbPage(site, 'slow cooker')).toBeDefined();
  });

  it('returns nothing rather than guessing when no route matches', () => {
    const site = seedSite('bitespoon.com');
    addPage('888', 'Some Page');

    expect(resolveFbPage(site, 'one pot pasta')).toBeUndefined();
  });

  it('ignores a disabled page instead of publishing to it', () => {
    const site = seedSite('bitespoon.com');
    const page = upsertFbPage({
      pageId: '999',
      name: 'Retired',
      autoPublish: true,
      enabled: false,
    });
    upsertFbRoute({ siteId: site, seedKeyword: 'slow cooker', fbPageId: page });

    expect(resolveFbPage(site, 'slow cooker')).toBeUndefined();
  });

  it('re-routing a niche replaces the route rather than adding a second', () => {
    // NULL never equals NULL, so a naive upsert would insert a duplicate
    // fallback route and the winner would be whichever the query saw first.
    const first = addPage('100', 'First');
    const second = addPage('200', 'Second');

    upsertFbRoute({ siteId: null, seedKeyword: 'air fryer', fbPageId: first });
    upsertFbRoute({ siteId: null, seedKeyword: 'air fryer', fbPageId: second });

    expect(listFbRoutes()).toHaveLength(1);
    expect(resolveFbPage(seedSite('bitespoon.com'), 'air fryer')?.page.page_id).toBe('200');
  });

  it('removing a page takes its routes with it', () => {
    const site = seedSite('bitespoon.com');
    const page = addPage('300', 'Doomed');
    upsertFbRoute({ siteId: site, seedKeyword: 'slow cooker', fbPageId: page });

    deleteFbPage(page);

    expect(listFbRoutes()).toHaveLength(0);
    expect(resolveFbPage(site, 'slow cooker')).toBeUndefined();
  });

  it('removing a route leaves the page registered', () => {
    const site = seedSite('bitespoon.com');
    const page = addPage('400', 'Keeper');
    upsertFbRoute({ siteId: site, seedKeyword: 'slow cooker', fbPageId: page });

    deleteFbRoute(listFbRoutes()[0]!.id);

    expect(listFbPages()).toHaveLength(1);
    expect(resolveFbPage(site, 'slow cooker')).toBeUndefined();
  });

  it('re-adding a page by id updates it instead of failing', () => {
    addPage('500', 'Old name');
    const again = upsertFbPage({
      pageId: '500',
      name: 'New name',
      autoPublish: true,
      enabled: true,
    });

    const pages = listFbPages();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.name).toBe('New name');
    expect(pages[0]!.auto_publish).toBe(1);
    expect(again).toBe(pages[0]!.id);
  });

  it('offers each niche once for the route picker', () => {
    insertKeyword({ seed_keyword: 'air fryer', spy_title: 'Wings' });
    insertKeyword({ seed_keyword: 'air fryer', spy_title: 'Chips' });
    insertKeyword({ seed_keyword: 'slow cooker', spy_title: 'Stew' });

    expect(keywordGroups()).toEqual(['air fryer', 'slow cooker']);
  });
});
