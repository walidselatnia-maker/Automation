import { describe, expect, it } from 'vitest';
import { SECTIONS, sectionFor } from '../src/web/views/layout.js';

/**
 * Five sections, in the order a person uses them: what is happening, what we
 * publish, where, why something did not happen, and setup. A page belongs to
 * exactly one section, found from its URL, so a route never has to say which.
 */
describe('navigation', () => {
  it('has the five sections in order', () => {
    expect(SECTIONS.map((s) => s.label)).toEqual([
      'Home', 'Content', 'Channels', 'Activity', 'Setup',
    ]);
  });

  it.each([
    ['/', 'Home'],
    ['/runs', 'Content'],
    ['/runs/42', 'Content'],
    ['/keywords/7', 'Content'],
    ['/reels/new/3/caption', 'Content'],
    ['/sites', 'Channels'],
    ['/sites/2', 'Channels'],
    ['/settings/facebook', 'Channels'],
    ['/events', 'Activity'],
    ['/decisions', 'Activity'],
    ['/settings', 'Setup'],
    ['/settings/prompts/part-1', 'Setup'],
    ['/browser', 'Setup'],
  ])('%s belongs to %s', (path, label) => {
    expect(sectionFor(path)?.label).toBe(label);
  });

  it('marks the page inside the section, not only the section', () => {
    const section = sectionFor('/settings/prompts/part-1')!;
    const page = section.pages.find((p) => p.href === '/settings/prompts');
    expect(page).toBeDefined();
  });
});
