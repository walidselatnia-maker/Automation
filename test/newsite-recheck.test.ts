import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { createNewWebsite, getNewWebsite, listKeywordPlans, saveKeywordPlan, setPlanImport } from '../src/newsite/repo.js';
import { recheckSubs, planStats } from '../src/newsite/keyword-import.js';
import { keywordsOverview } from '../src/newsite/keywords-view.js';

const KEY = randomBytes(32);
const sub = (keyword: string) => ({ keyword, intent: 'yours', reason: '', page: 'article' as const });

describe('Recheck sub-keywords', () => {
  let siteId: number;
  beforeEach(() => {
    openDatabase(':memory:');
    siteId = createNewWebsite(
      {
        name: 'Garden', domain: 'g.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Home gardening', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 0, intervalMinutes: 240,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
  });
  afterEach(() => closeDatabase());

  const status = (id: number) => get<{ subs_status: string }>('SELECT subs_status FROM keyword_plans WHERE id = ?', id)!.subs_status;

  it('sends back to the finder only the main keywords with fewer than six sub-keywords, and only when pressed', () => {
    const short = saveKeywordPlan(siteId, 'roses', [sub('pruning roses'), sub('feeding roses')], 'article');
    const failed = saveKeywordPlan(siteId, 'basil', [], 'article');
    setPlanImport(failed, { subsStatus: 'failed', subsError: 'No searches.' });
    const full = saveKeywordPlan(siteId, 'tomatoes', ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => sub(`${k} tomatoes`)), 'article');

    const page = String(keywordsOverview([{ site: getNewWebsite(siteId)!, plans: listKeywordPlans(siteId), autopilot: '' }], planStats()));
    expect(page).toContain('2 main keywords have fewer than 6 sub-keywords.');
    expect(page).toContain(`/new-website/keywords/website/${siteId}/recheck-subs`);
    // Nothing changes until the button is pressed.
    expect([status(short), status(failed), status(full)]).toEqual(['', 'failed', '']);

    expect(recheckSubs(siteId)).toBe(2);
    expect([status(short), status(failed), status(full)]).toEqual(['finding', 'finding', '']);
    // Pressed again while they are being found: nothing is sent twice.
    expect(recheckSubs(siteId)).toBe(0);
  });

  it('shows under Progress, in short, how many pictures are made and failed', () => {
    const plan = saveKeywordPlan(siteId, 'roses', [sub('pruning roses')], 'article');
    queuePlanSeo(plan, 'roses', [sub('pruning roses')], 'article');
    const [a, b] = listPlanSeo(plan).map((r) => r.id) as [number, number];
    const set = (slots: string[]) =>
      JSON.stringify({ theme: {}, images: slots.map((slot) => ({ slot, prompt: `p ${slot}`, alt: 'alt' })) });
    run(`UPDATE keyword_seo SET images_status = 'done', images_json = ? WHERE id = ?`, set(['feature', 'overhead', 'step-1']), a);
    run(`UPDATE keyword_seo SET images_status = 'done', images_json = ? WHERE id = ?`, set(['feature', 'overhead']), b);
    const pic = (seo: number, slot: string, status: string, prompt = `p ${slot}`) =>
      run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status) VALUES (?, ?, 0, ?, 'alt', ?)`, seo, slot, prompt, status);
    pic(a, 'feature', 'done');
    pic(a, 'overhead', 'failed');
    pic(b, 'feature', 'done');
    pic(b, 'overhead', 'done', 'an older prompt'); // made from a prompt since rewritten: not counted
    pic(b, 'pin-1', 'done'); // a social picture: not one of the article's
    expect(planStats().get(plan)).toMatchObject({ images: 5, imagesMade: 2, imagesFailed: 1 });
    const page = String(keywordsOverview([{ site: getNewWebsite(siteId)!, plans: listKeywordPlans(siteId), autopilot: '' }], planStats()));
    const text = page.replace(/\s+/g, ' ');
    expect(text).toContain('Art <b>0/2</b> · Pub <b>0/2</b>');
    expect(text).toContain('· IMG <b class="made" title="Pictures made">2</b> <b class="failed" title="Pictures failed">1 failed</b>');
    expect(text).not.toContain('not made yet');
  });

  it('shades every other keyword line of the table', () => {
    for (const k of ['roses', 'basil', 'tomatoes']) saveKeywordPlan(siteId, k, [], 'article');
    const page = String(keywordsOverview([{ site: getNewWebsite(siteId)!, plans: listKeywordPlans(siteId), autopilot: '' }], planStats()));
    expect(page).toContain('.ko-table tbody tr:nth-child(even) td { background: var(--raised); }');
  });
});
