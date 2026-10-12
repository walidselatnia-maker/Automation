import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { checkSection, cleanMarkdown, isSoftProblem, readingGrade, wordRange } from '../src/newsite/article.js';
import { markdownToHtml } from '../src/newsite/markdown.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { kickSeoWriter, listPlanSeo, queuePlanSeo, requeueArticle } from '../src/newsite/seo.js';
import type { SkeletonSection } from '../src/newsite/skeleton.js';

const KEY = randomBytes(32);

/** A paragraph of plain, simple sentences, n words long. */
const plain = (n: number, extra = ''): string => {
  const base = 'You mix the dough by hand and it stays soft. The cookies bake fast and smell warm. ';
  const words = (extra + ' ' + base.repeat(Math.ceil(n / 17))).trim().split(/\s+/).slice(0, n);
  return words.join(' ').replace(/[^.]$/, (c) => c + '.');
};

const SECTION: SkeletonSection = {
  h2: 'Why These Pumpkin Cookies Stay Soft',
  covers: 'c',
  keyPoints: ['a', 'b'],
  words: 150,
  h3: [],
};

const ctx = { section: SECTION, first: false, focusKeyword: 'pumpkin chocolate chip cookies', keyword: 'pumpkin chocolate chip cookies' };

describe('AI#3 section checks', () => {
  it('passes a section with the right heading, length and plain words', () => {
    expect(checkSection(`## ${SECTION.h2}\n\n${plain(150)}`, ctx)).toEqual([]);
  });

  it('holds the exact headings from the skeleton', () => {
    expect(checkSection(`## Another Heading\n\n${plain(150)}`, ctx).join(' ')).toMatch(/Start with exactly/);
    expect(checkSection(`# Title\n## ${SECTION.h2}\n\n${plain(150)}`, ctx).join(' ')).toMatch(/H1/);
    expect(checkSection(`## ${SECTION.h2}\n\n${plain(70)}\n\n## Extra\n\n${plain(70)}`, ctx).join(' ')).toMatch(/only this one H2/);
    const withH3 = { ...SECTION, h3: [{ h3: 'Blot the pumpkin', keyPoints: [], words: 80 }, { h3: 'Chill the dough', keyPoints: [], words: 80 }] };
    const wrongOrder = `## ${SECTION.h2}\n\n${plain(20)}\n\n### Chill the dough\n\n${plain(70)}\n\n### Blot the pumpkin\n\n${plain(70)}`;
    expect(checkSection(wrongOrder, { ...ctx, section: withH3 }).join(' ')).toMatch(/exactly these H3 headings, in this order/);
  });

  it('keeps the length near the target', () => {
    const [min, max] = wordRange(150);
    expect(checkSection(`## ${SECTION.h2}\n\n${plain(min - 20)}`, ctx).join(' ')).toMatch(/words; write/);
    expect(checkSection(`## ${SECTION.h2}\n\n${plain(max + 30)}`, ctx).join(' ')).toMatch(/words; write/);
  });

  it('refuses generic AI phrases', () => {
    const slop = `## ${SECTION.h2}\n\n${plain(140, "Let's dive in. In this article you will see the secret.")}`;
    const problems = checkSection(slop, ctx).join(' ');
    expect(problems).toMatch(/dive in/);
    expect(problems).toMatch(/In this article/i);
  });

  it('asks for plain language', () => {
    const hard = `## ${SECTION.h2}\n\n` + 'Incorporating substantially characteristic gastronomical considerations, professional confectionery practitioners systematically recommend extraordinarily meticulous temperature regulation throughout preparation. '.repeat(10);
    expect(readingGrade(hard)).toBeGreaterThan(12);
    expect(checkSection(hard, ctx).join(' ')).toMatch(/too hard to read/);
  });

  it('needs the focus keyword in the opening of the first section', () => {
    expect(checkSection(`## ${SECTION.h2}\n\n${plain(150)}`, { ...ctx, first: true }).join(' ')).toMatch(/first 100 words/);
    expect(checkSection(`## ${SECTION.h2}\n\n${plain(150, 'These pumpkin chocolate chip cookies are soft.')}`, { ...ctx, first: true })).toEqual([]);
  });

  it('keeps a recipe page to its recipe', () => {
    const allowedText = '250 g flour\n2 eggs\n200 g pumpkin puree\nBake at 175 °C for 12 minutes.';
    const ok = `## ${SECTION.h2}\n\n${plain(140, 'Add the pumpkin and eggs to the flour, then bake at 175 °C.')}`;
    expect(checkSection(ok, { ...ctx, allowedText })).toEqual([]);
    const invented = `## ${SECTION.h2}\n\n${plain(140, 'Add walnuts and a splash of maple syrup, then bake at 190 °C.')}`;
    const problems = checkSection(invented, { ...ctx, allowedText }).join(' ');
    expect(problems).toMatch(/not in the recipe.*walnut/);
    expect(problems).toMatch(/syrup/);
    expect(problems).toMatch(/temperature "190 °C"/);
  });

  it('tells soft problems from hard ones', () => {
    expect(isSoftProblem('The section has 30 words; write 105 to 250.')).toBe(true);
    expect(isSoftProblem('The writing is too hard to read (about grade 9); use shorter sentences and simpler words.')).toBe(true);
    expect(isSoftProblem('These ingredients are not in the recipe; do not mention them: chocolate.')).toBe(false);
  });

  it('takes the section out of a code fence', () => {
    expect(cleanMarkdown('```markdown\n## A\n\ntext\n```')).toBe('## A\n\ntext');
  });
});

describe('Markdown for reading', () => {
  it('renders headings, paragraphs, lists and bold, and escapes everything else', () => {
    const htmlOut = markdownToHtml('## Steps\n\nMix **well** now.\n\n- one\n- two\n\n1. first\n2. second\n\n<script>alert(1)</script>');
    expect(htmlOut).toContain('<h2>Steps</h2>');
    expect(htmlOut).toContain('<p>Mix <strong>well</strong> now.</p>');
    expect(htmlOut).toContain('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
    expect(htmlOut).toContain('<ol>\n<li>first</li>');
    expect(htmlOut).not.toContain('<script>');
    expect(htmlOut).toContain('&lt;script&gt;');
  });
});

describe('AI#3 follows the skeleton', () => {
  let planId: number;
  const sections: SkeletonSection[] = [
    { h2: 'Why Pumpkin Chocolate Chip Cookies Stay Soft', covers: 'c', keyPoints: ['a', 'b'], words: 100, h3: [] },
    { h2: 'Questions Bakers Ask', covers: 'c', keyPoints: ['a', 'b'], words: 100, h3: [] },
  ];

  beforeEach(() => {
    openDatabase(':memory:');
    const websiteId = createNewWebsite(
      {
        name: 'Site', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Gardening', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    planId = saveKeywordPlan(websiteId, 'pumpkin chocolate chip cookies', [], 'article');
    queuePlanSeo(planId, 'pumpkin chocolate chip cookies', [], 'article');
    // SEO and skeleton already done: the article is next.
    run(
      `UPDATE keyword_seo SET status = 'done', title = 'T', focus_keyword = 'pumpkin chocolate chip cookies',
         skeleton_status = 'done', skeleton_json = ?, article_status = 'pending' WHERE plan_id = ?`,
      JSON.stringify({ h1: 'T', sections }),
      planId,
    );
  });

  afterEach(() => closeDatabase());

  it('writes one section per request and puts the article together', async () => {
    const asked: Record<string, unknown>[] = [];
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (name, vars) => {
        if (name !== 'article-section') return '{}';
        asked.push(vars);
        const sec = JSON.parse(String(vars.sectionJson)) as SkeletonSection;
        const lead = sec.h2.startsWith('Why') ? 'These pumpkin chocolate chip cookies stay soft.' : '';
        return '```markdown\n## ' + sec.h2 + '\n\n' + plain(100, lead) + '\n```';
      },
    });
    expect(asked).toHaveLength(2);
    expect(String(asked[0]!.position)).toMatch(/FIRST/);
    expect(String(asked[1]!.previousEnding)).not.toBe('(this is the first section)');
    const [row] = listPlanSeo(planId);
    expect(row).toMatchObject({ article_status: 'done' });
    expect(row!.article_md).toMatch(/^## Why Pumpkin[\s\S]*\n\n## Questions Bakers Ask/);
    expect(row!.article_words).toBeGreaterThan(150);
  });

  it('corrects a section that keeps a mistake, then keeps its best and notes what is left', async () => {
    let calls = 0;
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (name) => {
        if (name !== 'article-section') throw new Error('later steps are not part of this test');
        calls += 1;
        return '## Wrong\n\ntoo short';
      },
    });
    expect(calls).toBe(20); // 10 rounds for each of the 2 sections
    const [row] = listPlanSeo(planId);
    expect(row).toMatchObject({ article_status: 'done' });
    expect(row!.article_problems).toMatch(/Kept after 10 rounds[\s\S]*Section "Why Pumpkin Chocolate Chip Cookies Stay Soft"/);
  });

  it('stops only when the AI cannot be reached, and says which section', async () => {
    await kickSeoWriter({ suggest: async () => [], ask: async () => { throw new Error('no endpoint'); } });
    const [row] = listPlanSeo(planId);
    expect(row).toMatchObject({ article_status: 'failed' });
    expect(row!.article_problems).toMatch(/Section "Why Pumpkin Chocolate Chip Cookies Stay Soft":\nThe AI could not be reached/);
  });

  it('keeps the best attempt when only soft problems are left', async () => {
    // Always a little short: a soft problem, so the article still goes on.
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (_name, vars) => {
        const sec = JSON.parse(String(vars.sectionJson)) as SkeletonSection;
        return `## ${sec.h2}\n\n${plain(50, 'These pumpkin chocolate chip cookies stay soft.')}`;
      },
    });
    expect(listPlanSeo(planId)[0]).toMatchObject({ article_status: 'done' });
  });

  it('carries on from the failed section, keeping the ones before it', async () => {
    let failSecond = true;
    const asked: string[] = [];
    const ask = async (_name: string, vars: Record<string, unknown>) => {
      const sec = JSON.parse(String(vars.sectionJson)) as SkeletonSection;
      asked.push(sec.h2);
      if (sec.h2.startsWith('Questions') && failSecond) throw new Error('the AI went away');
      return `## ${sec.h2}\n\n${plain(100, 'These pumpkin chocolate chip cookies stay soft.')}`;
    };
    await kickSeoWriter({ suggest: async () => [], ask });
    const failed = listPlanSeo(planId)[0]!;
    expect(failed.article_status).toBe('failed');
    expect(failed.article_md).toMatch(/^## Why Pumpkin/);

    failSecond = false;
    asked.length = 0;
    requeueArticle(failed.id);
    await kickSeoWriter({ suggest: async () => [], ask });
    expect(asked).toEqual(['Questions Bakers Ask']);
    expect(listPlanSeo(planId)[0]).toMatchObject({ article_status: 'done' });
  });

  it('can be written again', async () => {
    await kickSeoWriter({ suggest: async () => [], ask: async () => '## Wrong' });
    requeueArticle(listPlanSeo(planId)[0]!.id);
    expect(listPlanSeo(planId)[0]).toMatchObject({ article_status: 'pending', article_problems: '' });
  });
});
