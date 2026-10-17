import { describe, expect, it } from 'vitest';
import { homePage, homeStages, type HomeState } from '../src/newsite/home.js';

const fresh: HomeState = {
  platformReady: false,
  websites: [],
  channels: 0,
  linkedChannels: 0,
  plans: 0,
  articles: { published: 0, working: 0, stopped: 0 },
  social: { sent: 0, failed: 0 },
  reels: { made: 0, failed: 0, sharesSent: 0, sharesFailed: 0 },
};

describe('Start here', () => {
  it('on a fresh install, says what the platform does and that connecting it comes first', () => {
    const stages = homeStages(fresh);
    expect(stages.map((s) => s.state)).toEqual(['next', 'locked', 'locked', 'locked', 'locked', 'locked']);
    const page = homePage(fresh).value;
    expect(page).toContain('writes articles from your keywords, publishes them on your website, and shares them');
    expect(page).toContain('href="/new-website/platform/setup">Set up the platform</a>');
    expect(page).not.toContain('Needs your attention');
  });

  it('moves on step by step: the website, then keywords, with social channels optional in between', () => {
    const ready = { ...fresh, platformReady: true };
    expect(homeStages(ready)[1]!.state).toBe('next');
    const withSite = { ...ready, websites: [{ id: 7, name: 'Long Livo' }] };
    expect(homeStages(withSite).map((s) => s.state)).toEqual(['done', 'done', 'optional', 'next', 'locked', 'locked']);
    // Channels that no website uses yet: the way in is the website's own channel settings.
    const unused = homeStages({ ...withSite, channels: 2 })[2]!;
    expect(unused.fact).toContain('no website shares on them yet');
    expect(unused.action!.href).toBe('/new-website/7/edit?section=4');
  });

  it('points at what stopped, with where to fix it', () => {
    const busy: HomeState = {
      ...fresh,
      platformReady: true,
      websites: [{ id: 1, name: 'A' }],
      channels: 1,
      linkedChannels: 1,
      plans: 1,
      articles: { published: 2, working: 1, stopped: 1 },
      social: { sent: 3, failed: 2 },
      reels: { made: 1, failed: 0, sharesSent: 1, sharesFailed: 1 },
    };
    const stages = homeStages(busy);
    expect(stages[4]).toMatchObject({ state: 'attention', fact: '2 published articles · 1 on the way · 1 stopped' });
    expect(stages[5]!.state).toBe('attention');
    const page = homePage(busy).value;
    expect(page).toContain('Needs your attention');
    expect(page).toContain('href="/new-website/sharing">2 social posts could not be sent.</a>');
    expect(page).toContain('href="/new-website/sharing/reels">1 reel could not be made or sent.</a>');
  });
});
