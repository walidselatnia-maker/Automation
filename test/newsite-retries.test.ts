import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { getSeoRow, listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { retriesOf, sweepRetries } from '../src/newsite/retries.js';

const KEY = randomBytes(32);
const MIN = 60_000;

describe('Automatic retries of the AI steps', () => {
  let settings: Settings;
  let seoId: number;

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('auto_retry_enabled', 'true');
    settings.set('auto_retry_max', '2');
    settings.set('auto_retry_delay_minutes', '15');
    const websiteId = createNewWebsite(
      {
        name: 'Site', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    const planId = saveKeywordPlan(websiteId, 'strawberry cake', [], 'recipe');
    queuePlanSeo(planId, 'strawberry cake', [], 'recipe');
    seoId = listPlanSeo(planId)[0]!.id;
    // SEO done; the skeleton failed.
    run(`UPDATE keyword_seo SET status = 'done', skeleton_status = 'failed', skeleton_problems = 'The AI could not be reached.' WHERE id = ?`, seoId);
  });

  afterEach(() => closeDatabase());

  it('waits the set time, then puts the failed step back in the queue by itself', () => {
    expect(sweepRetries(settings, 0)).toBe(false);
    expect(getSeoRow(seoId)).toMatchObject({ retry_step: 'skeleton', retry_at: 15 * MIN, skeleton_status: 'failed' });

    expect(sweepRetries(settings, 10 * MIN)).toBe(false);
    expect(sweepRetries(settings, 15 * MIN)).toBe(true);
    const row = getSeoRow(seoId)!;
    expect(row).toMatchObject({ skeleton_status: 'pending', retry_at: null });
    expect(retriesOf(row)).toEqual({ skeleton: 1 });
  });

  it('stops after the set number of tries, then waits for the button', () => {
    for (let i = 0; i < 2; i++) {
      sweepRetries(settings, 0);
      sweepRetries(settings, 15 * MIN);
      run(`UPDATE keyword_seo SET skeleton_status = 'failed' WHERE id = ?`, seoId);
    }
    expect(retriesOf(getSeoRow(seoId)!)).toEqual({ skeleton: 2 });
    expect(sweepRetries(settings, 0)).toBe(false);
    expect(sweepRetries(settings, 100 * MIN)).toBe(false);
    expect(getSeoRow(seoId)).toMatchObject({ skeleton_status: 'failed' });
  });

  it('does nothing when automatic retries are off', () => {
    settings.set('auto_retry_enabled', 'false');
    sweepRetries(settings, 0);
    expect(sweepRetries(settings, 100 * MIN)).toBe(false);
    expect(getSeoRow(seoId)).toMatchObject({ skeleton_status: 'failed', retry_at: null });
  });

  it('forgets a planned try once the step is no longer failed', () => {
    sweepRetries(settings, 0);
    run(`UPDATE keyword_seo SET skeleton_status = 'pending' WHERE id = ?`, seoId);
    sweepRetries(settings, 1);
    expect(getSeoRow(seoId)).toMatchObject({ retry_step: '', retry_at: null });
  });
});
