import { html, raw, type Html } from '../web/views/layout.js';
import type { KeywordPlan, NewWebsiteRow } from './repo.js';
import { DESCRIPTION, TITLE, type SeoRow } from './seo.js';
import { articleTypeFor, parseSkeleton, totalWords, type Skeleton } from './skeleton.js';
import { parseRecipe } from './recipe.js';
import { markdownToHtml } from './markdown.js';
import { parseImageSet } from './images.js';
import { isStepSlot, type PictureRow } from './pictures.js';
import { notReadyReason } from './publish.js';
import { WIZARD_CSS } from './view.js';
import { channelTakes, postLinkOf, type ChannelRow } from './channels.js';
import type { SocialPostRow } from './social.js';
import type { ImportCheck, PlanStats } from './keyword-import.js';
import { MAX_SUBS } from './keywords.js';

const INTENT_LABEL: Record<string, string> = {
  diet: 'Diet',
  method: 'Method',
  format: 'Format',
  flavor: 'Flavor',
  ingredient: 'Ingredient',
  time: 'Time',
  info: 'Know-how',
  yours: 'Added by you',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (createdAt: string): string => {
  const [y, m, d] = createdAt.slice(0, 10).split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : createdAt;
};

export const CSS = `
.kw-site { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; color: var(--soft); font-size: 14px; }
.kw-site select { height: 38px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); }
.kw-site strong { color: var(--ink); }
#kw-find label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
.kw-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; }
.kw-row input { height: 44px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); }
.kw-row input:hover { border-color: var(--soft); }
.kw-row input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
.kw-row .ns-btn { height: 44px; }
.kw-hint { color: var(--faint); font-size: 13px; margin-top: 8px; }
.kw-error { color: var(--bad); font-size: 14px; font-weight: 600; margin-top: 12px; }
.kw-error:empty { display: none; }
.kw-status { color: var(--soft); font-size: 14px; margin-top: 12px; }
.kw-status:empty { display: none; }

.kw-result { margin-top: 32px; }
.kw-result[hidden] { display: none; }
.kw-result-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 4px; }
.kw-result-head h2 { font-size: 22px; }
.kw-count { color: var(--soft); font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.kw-source { color: var(--soft); font-size: 14px; margin: 0 0 16px; }
.kw-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.kw-item { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: start; padding: 16px 0; border-bottom: 1px solid var(--line); }
.kw-item b { font-weight: 600; font-size: 16px; }
.kw-intent { margin-left: 10px; vertical-align: 1px; display: inline-block; padding: 2px 8px; border-radius: 5px; background: var(--raised); border: 1px solid var(--line); color: var(--soft); font: 600 13px/1.5 var(--body); white-space: nowrap; }
.kw-why { color: var(--soft); font-size: 14px; margin-top: 4px; }
.kw-page { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.kw-page-chip { height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--idle-line); background: var(--idle);
  color: var(--idle-ink); font: 600 13px var(--body); cursor: pointer; }
.kw-page-chip.recipe { border-color: var(--idle-line); color: var(--idle-ink); background: var(--idle); }
.kw-page-chip:hover { background: var(--idle-hover); }
.kw-page-why { color: var(--faint); font-size: 13px; }
.kw-pillar-page { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: -4px 0 16px; padding: 12px 14px; background: var(--raised); border-radius: var(--r-ctl); }
.kw-pillar-page[hidden] { display: none; }
.kw-pillar-page .kw-page { margin-top: 0; }
.kw-pillar-label { font-weight: 600; font-size: 14px; }
.kw-remove { height: 32px; padding: 0 12px; font-size: 13px; }
.kw-remove:hover { color: var(--ink); }
.kw-empty { color: var(--soft); padding: 16px 0; border-bottom: 1px solid var(--line); }
.kw-add { margin-top: 20px; }
.kw-add label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
.kw-dropped { margin-top: 24px; }
.kw-dropped summary { cursor: pointer; color: var(--soft); font-weight: 600; font-size: 14px; padding: 4px 0; }
.kw-dropped summary:hover { color: var(--ink); }
.kw-dropped ul { list-style: none; margin: 8px 0 0; padding: 0; }
.kw-dropped li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 14px; }
.kw-dropped li span:last-child { color: var(--soft); }
.kw-save { display: flex; justify-content: flex-end; align-items: center; gap: 16px; margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); }

.kw-plans { margin-top: 56px; }
.kw-plans > h2 { font-size: 20px; margin-bottom: 16px; }
.kw-plan { padding: 20px 0; border-top: 1px solid var(--line); }
.kw-plan-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.kw-plan h3 { font-size: 18px; }
.kw-plan-meta { color: var(--soft); font-size: 14px; margin-top: 2px; }
.kw-plan form { margin: 0; }
.kw-none { color: var(--soft); }
.kw-plain { margin: 12px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.kw-plain li { display: grid; grid-template-columns: 110px 1fr; gap: 12px; font-size: 15px; }
.kw-plain li span { color: var(--soft); font-size: 13px; padding-top: 1px; }
.kw-seo-list { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 12px; }
.kw-seo { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 18px 20px; box-shadow: var(--shadow); }
.kw-seo-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.kw-seo-head b { font-weight: 600; }
.kw-seo-role { min-width: 0; display: inline-block; padding: 2px 8px; border-radius: 5px; background: var(--raised); border: 1px solid var(--line); color: var(--soft); font: 600 13px/1.5 var(--body); white-space: nowrap; }
.kw-seo-status { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; font: 600 13px/1 var(--body); white-space: nowrap; background: var(--raised); color: var(--soft); border: 1px solid var(--line); }
.kw-seo-status.done { background: var(--good-tint); color: var(--good); border-color: transparent; }
.kw-seo-status.failed { background: var(--bad-tint); color: var(--bad); border-color: transparent; }
.kw-seo-status.writing { background: var(--idle); color: var(--idle-ink); border-color: transparent; }
.kw-serp { margin: 14px 0 0; padding: 14px 16px; border-left: 3px solid var(--line-strong); background: var(--raised); }
.kw-serp-title { color: #1a0dab; font-size: 18px; line-height: 1.3; }
:root.dark .kw-serp-title { color: #8ab4f8; }
.kw-serp-desc { color: var(--soft); font-size: 14px; margin-top: 4px; }
.kw-seo-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 32px; margin: 14px 0 0; }
.kw-seo-facts div { display: grid; grid-template-columns: 120px 1fr; gap: 12px; }
.kw-seo-facts div.wide { grid-column: 1 / -1; }
.kw-seo-facts dt { color: var(--faint); font-size: 13px; }
.kw-seo-facts dd { margin: 0; font-size: 14px; }
.kw-seo-facts dd.off { color: var(--bad); font-weight: 600; }
.kw-kept { margin-top: 12px; color: var(--soft); font-size: 13px; display: grid; gap: 2px; border-left: 3px solid var(--line-strong); padding-left: 10px; }
.kw-seo-problems { margin-top: 12px; padding: 10px 14px; border-radius: var(--r-ctl); border-left: 4px solid var(--bad); background: var(--bad-tint); color: var(--ink); font-size: 14px; display: grid; gap: 4px; }
.kw-seo-retry { margin: 0 0 14px; display: flex; justify-content: flex-start; flex-wrap: wrap; }
.kw-skel { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
.kw-skel summary { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; font-weight: 600; color: var(--ink); }
.kw-skel summary .ns-num { font-weight: 400; color: var(--soft); }
.kw-skel-h1 { margin: 14px 0 8px; font: 600 15px var(--display); }
.kw-skel-list { margin: 0; padding-left: 20px; display: grid; gap: 12px; }
.kw-skel-h2 { display: flex; justify-content: space-between; gap: 16px; font-size: 14px; }
.kw-skel-h2 .ns-num { color: var(--faint); font-size: 13px; white-space: nowrap; }
.kw-skel-covers { color: var(--soft); font-size: 13px; margin-top: 2px; }
.kw-skel ul { margin: 4px 0 0; padding-left: 18px; color: var(--soft); font-size: 13px; }
.kw-skel-h3s { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 6px; }
.kw-recipe { border-top: 1px solid var(--line); padding-top: 14px; }
.kw-recipe-facts { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 0 0 16px; }
.kw-recipe-facts dt { color: var(--faint); font-size: 13px; }
.kw-recipe-facts dd { margin: 2px 0 0; font-weight: 600; font-size: 14px; }
.kw-recipe-facts dd.cap { text-transform: capitalize; }
.kw-recipe-cols { display: grid; grid-template-columns: 2fr 3fr; gap: 28px; }
.kw-recipe h4 { font: 600 15px var(--display); margin: 0 0 8px; }
.kw-recipe-group { font-size: 13px; font-weight: 600; color: var(--soft); margin: 12px 0 4px; }
.kw-recipe ul, .kw-recipe ol { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 14px; }
.kw-recipe-foot { margin-top: 16px; color: var(--soft); font-size: 13px; }
.kw-recipe-notes { margin-top: 8px; font-size: 14px; color: var(--soft); }
.kw-recipe-notes b { color: var(--ink); margin-right: 6px; }
.kw-img-theme { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 20px; margin: 0 0 18px;
  padding: 14px 16px; background: var(--raised); border-radius: var(--r-ctl); }
.kw-img-theme dt { color: var(--faint); font-size: 13px; }
.kw-img-theme dd { margin: 2px 0 0; font-size: 14px; }
.kw-img-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 0; border-top: 1px solid var(--line); }
.kw-img-list li { padding: 14px 0; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: minmax(0, 1fr) 176px; gap: 20px; align-items: start; }
.kw-pic { display: block; border-radius: var(--r-ctl); overflow: hidden; background: var(--raised); border: 1px solid var(--line); }
.kw-pic img { width: 100%; height: auto; display: block; }
.kw-pic-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 8px; text-align: center;
  color: var(--soft); font-size: 13px; aspect-ratio: auto; min-height: 99px; }
.kw-pic-empty.making { color: var(--idle-ink); background: var(--idle); }
.kw-pic-empty.failed { color: var(--bad); border-color: var(--bad); }
.kw-pic-empty small { color: var(--faint); font-size: 12px; line-height: 1.4; max-height: 8.4em; overflow-y: auto; overflow-wrap: anywhere; max-width: 100%; }
.kw-pic-empty .ns-btn { height: 30px; padding: 0 10px; font-size: 12px; }
.kw-pic-empty form { margin: 4px 0 0; }
.kw-failed-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 0 0 16px; padding: 10px 16px; border: 1px solid var(--bad); border-left-width: 4px; border-radius: var(--r-ctl); background: var(--bad-tint); color: var(--ink); }
.kw-pic-actions { gap: 8px; align-items: center; }
.kw-pic-actions form { margin: 0; }
.kw-img-slot { text-transform: capitalize; display: inline-block; padding: 2px 8px; border-radius: 5px; background: var(--raised); border: 1px solid var(--line); color: var(--soft); font: 600 13px/1.5 var(--body); white-space: nowrap; }
.kw-img-prompt { margin: 6px 0 8px; font-size: 14px; line-height: 1.6; max-width: 72ch; }
.kw-img-alt { color: var(--soft); font-size: 13px; }
.kw-img-alt b { color: var(--ink); margin-right: 6px; }
.kw-article { border-top: 1px solid var(--line); padding-top: 18px; max-width: 68ch; overflow-wrap: anywhere; font-size: 16px; line-height: 1.7; }
.kw-article h1 { font-size: 26px; line-height: 1.2; margin: 0 0 16px; }
.kw-article h2 { font-size: 21px; margin: 28px 0 10px; }
.kw-article h3 { font-size: 17px; margin: 20px 0 8px; }
.kw-article p { margin: 0 0 14px; }
.kw-article ul, .kw-article ol { margin: 0 0 14px; padding-left: 22px; display: grid; gap: 4px; }
/* Steps: the wizard card, wider for lists. */
.wz.kw-wz { max-width: none; }
.kw-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 14px; font-size: 14px; color: var(--soft); }
.kw-crumbs a { color: var(--soft); text-decoration: none; font-weight: 500; }
.kw-crumbs a:hover { color: var(--accent-text); text-decoration: underline; }
.kw-crumbs span { color: var(--faint); }
.kw-crumbs b { color: var(--ink); font-weight: 600; }
.kw-steps { display: grid; gap: 4px; margin-top: 20px; }
.kw-step { display: flex; flex-direction: column; gap: 8px; padding: 6px 3px 8px; margin: -6px 0; border-radius: var(--r-ctl);
  font-size: 12.5px; font-weight: 500; color: var(--idle-ink); text-decoration: none; min-width: 0; }
.kw-step i { display: block; height: 6px; border-radius: 3px; background: var(--idle-line); }
.kw-step.done i, .kw-step.on i { background: var(--accent); }
.kw-step.on { color: var(--accent-text); font-weight: 700; }
.kw-step span { overflow-wrap: normal; word-break: normal; hyphens: none; line-height: 1.35; }
a.kw-step:hover { background: var(--idle); }
a.kw-step:hover span { text-decoration: underline; }
.kw-foot-top { border-top: 0; border-bottom: 1px solid var(--line); background: var(--raised); }
.kw-foot-top form { margin: 0; }

/* Saved plans under step 1: a compact list, each opening its steps. */
.kw-waiting { margin: 14px 0 0; padding: 10px 14px; border-radius: var(--r-ctl); background: var(--idle); color: var(--idle-ink); font-size: 14px; }
.kw-share-channels { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 20px; font-size: 14px; color: var(--soft); }
.kw-share-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.kw-share-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.kw-share-actions form { margin: 0; }
.kw-share-actions:empty { display: none; }
.kw-share-list { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 0; border-top: 1px solid var(--line); }
.kw-share-post { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 16px; align-items: start; padding: 14px 0; border-bottom: 1px solid var(--line); }
.kw-share-pic { display: block; aspect-ratio: 3 / 4; border-radius: var(--r-ctl); overflow: hidden; border: 1px solid var(--line); background: var(--raised); }
.kw-share-pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.kw-share-pic.empty { display: flex; align-items: center; justify-content: center; text-align: center; padding: 8px; font-size: 13px; color: var(--faint); }
.kw-share-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.kw-share-words { margin: 10px 0 0; display: grid; gap: 6px; }
.kw-share-words div { display: grid; grid-template-columns: 110px 1fr; gap: 12px; }
.kw-share-words dt { color: var(--faint); font-size: 13px; }
.kw-share-words dd { margin: 0; font-size: 14px; }
.kw-share-rules { font-size: 14px; color: var(--soft); margin: -12px 0 16px; }
.kw-share-post b { font-weight: 600; font-size: 14px; }
.kw-share-meta { color: var(--faint); font-size: 13px; margin-top: 2px; }
.kw-share-post .kw-seo-status { margin-left: 0; }
.kw-saved { max-width: 980px; margin: 40px auto 0; }
.kw-saved > h2 { font-size: 20px; margin-bottom: 12px; }
.kw-saved-row { display: grid; grid-template-columns: 1fr auto auto; gap: 16px; align-items: center; padding: 16px 0; border-top: 1px solid var(--line); }
.kw-saved-row a.kw-open { text-decoration: none; }
.kw-saved-row a.kw-open b { font: 600 17px var(--display); }
.kw-saved-row a.kw-open:hover b { color: var(--accent-text); }
.kw-saved-meta { color: var(--faint); font-size: 14px; margin-top: 2px; }

/* Keyword cards that open and close. */
.acc-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.acc { border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); box-shadow: var(--shadow); }
.acc.open { border-color: var(--line-strong); }
.acc-head { width: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 16px 18px; background: none; border: 0;
  color: var(--ink); font: inherit; text-align: left; cursor: pointer; border-radius: var(--r-card); }
.acc-head:hover { background: var(--raised); }
.acc-head b { font-weight: 600; flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.acc-chev { width: 18px; height: 18px; flex: none; color: var(--soft); transition: transform .25s ease; }
.acc.open .acc-chev { transform: rotate(180deg); }
.acc-panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .28s ease; }
.acc.open .acc-panel { grid-template-rows: 1fr; }
.acc-inner { overflow: hidden; }
.acc-body { padding: 0 18px 18px; }
.acc-head .kw-seo-status { margin-left: 0; }
@media (prefers-reduced-motion: reduce) { .acc-panel, .acc-chev { transition: none; } }

@media (max-width: 640px) {
  .kw-saved-row { grid-template-columns: 1fr; gap: 8px; }
  .kw-recipe-facts { grid-template-columns: repeat(3, 1fr); }
  .kw-recipe-cols { grid-template-columns: 1fr; }
  .kw-img-list li { grid-template-columns: 1fr; gap: 10px; }
  .kw-pic { max-width: 320px; }
  .kw-row { grid-template-columns: 1fr; }
  .kw-share-post { grid-template-columns: 84px minmax(0, 1fr); }
  .kw-share-words div { grid-template-columns: 1fr; gap: 0; }
  .kw-steps { grid-template-columns: repeat(4, 1fr) !important; row-gap: 12px; }
  .kw-dropped li, .kw-plain li, .kw-seo-facts, .kw-seo-facts div { grid-template-columns: 1fr; gap: 2px; }
}
`;

/** The steps of a plan. Recipe websites get the fixed recipe before the skeleton. */
const stepNames = (niche: string): string[] =>
  articleTypeFor(niche) === 'recipe'
    ? ['Keywords', 'SEO', 'Recipe', 'Skeleton', 'Article', 'Images', 'Publish', 'Share']
    : ['Keywords', 'SEO', 'Skeleton', 'Article', 'Images', 'Publish', 'Share'];

const CHEVRON = '<svg class="acc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/* -- Which keywords each step shows ---------------------------------------- */

export type Stage = 'recipe' | 'skeleton' | 'article' | 'images' | 'publish' | 'share';

/**
 * A keyword shows on a step only once the step before it is done for that
 * keyword, so each step lists just what is ready for it.
 */
export function readyFor(stage: Stage, site: NewWebsiteRow, rows: SeoRow[]): SeoRow[] {
  const recipeSite = articleTypeFor(site.niche) === 'recipe';
  const needsRecipe = (r: SeoRow) => recipeSite && r.page !== 'article';
  const ok: Record<Stage, (r: SeoRow) => boolean> = {
    recipe: (r) => r.status === 'done' && needsRecipe(r),
    skeleton: (r) => r.status === 'done' && (!needsRecipe(r) || r.recipe_status === 'done'),
    article: (r) => r.skeleton_status === 'done',
    images: (r) => r.article_status === 'done',
    publish: (r) => r.images_status === 'done',
    share: (r) => r.post_status === 'published' && Boolean(r.post_url),
  };
  return rows.filter(ok[stage]);
}

const WAITING_FOR: Record<Stage, string> = {
  recipe: 'once their SEO metadata is done',
  skeleton: 'once their SEO metadata (and, for recipe pages, their recipe) is done',
  article: 'once their skeleton is done',
  images: 'once their article is done',
  publish: 'once their image prompts are done',
  share: 'once they are published',
};

/** One quiet line for the keywords not ready for this step yet; it also keeps the page watching for them. */
const waitingNote = (stage: Stage, hidden: number, watch: boolean, planId: number): Html =>
  hidden
    ? html`<p class="kw-waiting" ${watch ? raw(`data-watch="${planId}"`) : raw('')}>${hidden === 1 ? '1 more keyword appears' : `${hidden} more keywords appear`} here ${WAITING_FOR[stage]}.</p>`
    : raw('');

/**
 * The wizard card every step shares: header with progress, then the step's
 * buttons (Previous / Next / Make all), then the body. The buttons come first
 * so a long list never has to be scrolled to reach them.
 */
function stepCard(names: string[], step: number, title: string, subtitle: Html | string, body: Html, foot: Html, hrefs: string[] = []): Html {
  const steps = names.map((n, i) => {
    const state = i < step ? 'done' : i === step ? 'on' : 'todo';
    const inner = html`<i></i><span>${i + 1}. ${n}</span>`;
    // Every step is a link straight to it (once there is a plan to go to).
    return hrefs[i] && i !== step
      ? html`<a class="kw-step ${state}" href="${hrefs[i]}">${inner}</a>`
      : html`<span class="kw-step ${state}" ${raw(i === step ? 'aria-current="step"' : '')}>${inner}</span>`;
  });
  return html`
    ${hrefs.length ? html`<nav class="kw-crumbs" aria-label="Where you are"><a href="/new-website/keywords">Keywords &amp; articles</a><span aria-hidden="true">›</span><b>${title}</b></nav>` : raw('')}
    <div class="wz kw-wz">
      <div class="wz-head">
        <h1>${title}</h1>
        <p class="wz-id">${subtitle}</p>
        <nav class="kw-steps" aria-label="Steps" style="grid-template-columns:repeat(${names.length},1fr)">${steps}</nav>
      </div>
      <div class="wz-foot kw-foot-top">${foot}</div>
      <div class="wz-body">${body}</div>
    </div>`;
}

/** Where each step's name leads, for a saved plan. */
const STEP_PATH: Record<string, string> = {
  SEO: 'seo', Recipe: 'recipe', Skeleton: 'skeleton', Article: 'article', Images: 'images', Publish: 'publish', Share: 'share',
};
const stepHrefs = (names: string[], planId: number, websiteId: number): string[] =>
  names.map((n) =>
    n === 'Keywords'
      ? `/new-website/keywords#website-${websiteId}`
      : n === 'Share'
        ? `/new-website/sharing?plan=${planId}#website-${websiteId}`
        : `/new-website/keywords/plan/${planId}/${STEP_PATH[n]}`,
  );

const planHref = (planId: number, step: 'seo' | 'recipe' | 'skeleton' | 'article' | 'images' | 'publish' | 'share'): string => `/new-website/keywords/plan/${planId}/${step}`;

/** How far a plan has got, in one line. */
const progress = (rows: SeoRow[]): string => {
  if (!rows.length) return 'SEO not started';
  const seo = rows.filter((r) => r.status === 'done').length;
  const recipes = rows.filter((r) => r.recipe_status === 'done').length;
  const sk = rows.filter((r) => r.skeleton_status === 'done').length;
  const articles = rows.filter((r) => r.article_status === 'done').length;
  const images = rows.filter((r) => r.images_status === 'done').length;
  const posted = rows.filter((r) => r.post_status === 'published').length;
  return `SEO ${seo}/${rows.length}${recipes ? ` · Recipes ${recipes}/${rows.length}` : ''} · Skeletons ${sk}/${rows.length} · Articles ${articles}/${rows.length} · Images ${images}/${rows.length} · Published ${posted}/${rows.length}`;
};

/** Step 1: pick the website, find sub-keywords, save the plan. Saved plans are listed below. */
export function keywordsPage(
  websites: NewWebsiteRow[],
  current: NewWebsiteRow | undefined,
  plans: KeywordPlan[],
  seo: Map<number, SeoRow[]> = new Map(),
): Html {
  if (!current) {
    return html`<style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
      <div class="nl-empty" style="border:1px dashed var(--line-strong);border-radius:var(--r-card);padding:56px 32px;text-align:center;max-width:820px;margin:0 auto">
        <h2 style="font-size:22px;margin-bottom:8px">Add a website first</h2>
        <p style="color:var(--soft);margin:0 0 24px">Keywords are planned for one website at a time.</p>
        <a class="ns-btn primary" href="/new-website/add">Add website</a>
      </div>`;
  }

  const body = html`
    <div class="wz-field">
      <label for="kw-website">Website</label>
      <select id="kw-website" name="websiteId" onchange="location.href='/new-website/keywords/new?website='+this.value">
        ${websites.map((w) => html`<option value="${w.id}" ${w.id === current.id ? raw('selected') : raw('')}>${w.name} · ${w.domain}</option>`)}
      </select>
    </div>
    <form id="kw-find" autocomplete="off">
      <input type="hidden" name="websiteId" value="${current.id}" />
      <label for="kw-pillar">Main keyword</label>
      <div class="kw-row">
        <input id="kw-pillar" name="pillar" maxlength="80" placeholder="pumpkin chocolate chip cookies" />
        <button class="ns-btn primary" id="kw-go">Find sub-keywords</button>
      </div>
      <div class="kw-hint">The main topic for ${current.niche}. The search reads the website's posts, asks Google, then the AI. It can take a minute.</div>
      <div class="kw-status" id="kw-status" role="status"></div>
      <div class="kw-error" id="kw-error" role="alert"></div>
    </form>

    <div class="kw-result" id="kw-result" hidden>
      <div class="kw-result-head">
        <h2 id="kw-title"></h2>
        <span class="kw-count" id="kw-count"></span>
      </div>
      <p class="kw-source" id="kw-source"></p>
      <div class="kw-pillar-page" id="kw-pillar-page" hidden></div>
      <ul class="kw-list" id="kw-list"></ul>

      <div class="kw-add">
        <label for="kw-own">Add your own</label>
        <div class="kw-row">
          <input id="kw-own" maxlength="100" placeholder="pumpkin chocolate chip cookie bars" />
          <button type="button" class="ns-btn" id="kw-own-add">Add</button>
        </div>
        <div class="kw-error" id="kw-own-error" role="alert"></div>
      </div>

      <details class="kw-dropped" id="kw-dropped" hidden>
        <summary id="kw-dropped-title"></summary>
        <ul id="kw-dropped-list"></ul>
      </details>
      <div class="kw-error" id="kw-save-error" role="alert"></div>
    </div>`;

  const foot = html`
    <a class="ns-btn quiet" href="/new-website/keywords/add">Previous</a>
    <span style="display:flex;gap:10px">
      <a class="ns-btn quiet" href="/new-website/keywords">Cancel</a>
      <button type="button" class="ns-btn primary" id="kw-save" disabled>Save and continue</button>
    </span>`;

  return html`
    ${addWizard(1, 'Add one main keyword', body, foot, '', ONE_STEPS, true)}
    ${raw(script(current.id, articleTypeFor(current.niche) === 'recipe'))}
  `;
}

const STATUS: Record<SeoRow['status'], string> = {
  pending: 'Waiting',
  writing: 'Writing…',
  done: 'Done',
  failed: 'Failed',
};

const fits = (length: number, [min, max]: readonly [number, number]): boolean => length >= min && length <= max;

const SKELETON_STATUS: Record<string, string> = {
  pending: 'Waiting',
  writing: 'Making…',
  done: 'Done',
  failed: 'Failed',
};

/** A card whose head opens and closes its body, with an animation. */
function card(head: Html, body: Html, open = false): Html {
  return html`<li class="acc ${open ? 'open' : ''}">
    <button type="button" class="acc-head" aria-expanded="${open ? 'true' : 'false'}">${head}${raw(CHEVRON)}</button>
    <div class="acc-panel"><div class="acc-inner"><div class="acc-body">${body}</div></div></div>
  </li>`;
}

const roleLabel = (row: SeoRow, intent: string): Html =>
  html`<span class="kw-seo-role">${row.role === 'pillar' ? 'Pillar' : (INTENT_LABEL[intent] ?? 'Sub-keyword')}</span>`;

/** On a failed step: when it tries again by itself, from the platform's retry settings. */
const retryNote = (row: SeoRow): Html => {
  if (!row.retry_at) return raw('');
  const minutes = Math.max(0, Math.round((row.retry_at - Date.now()) / 60_000));
  return html`<p class="kw-none" style="margin:6px 0 0">Tries again by itself ${minutes ? `in about ${minutes} minute${minutes === 1 ? '' : 's'}` : 'within a minute'} (Platform → Automatic retries).</p>`;
};

/**
 * A step that carried on after every round of corrections with something
 * still wrong: not a fail, but worth seeing.
 */
const keptList = (status: string, text: string): Html =>
  status === 'done' && text
    ? html`<div class="kw-kept">${text.split('\n').filter(Boolean).map((p) => html`<div>${p}</div>`)}</div>`
    : raw('');

const problemList = (text: string): Html =>
  html`<div class="kw-seo-problems">${text.split('\n').filter(Boolean).map((p) => html`<div>${p}</div>`)}</div>`;

/** One keyword's AI#1 result: how it will look in Google, and its checks. */
function seoCard(row: SeoRow, intent: string): Html {
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b><span class="kw-seo-status ${row.status}">${STATUS[row.status]}</span>`;
  const shown = row.status === 'done' || (row.status === 'failed' && row.title);
  const body = html`
    ${row.status === 'done' || row.status === 'failed'
      ? html`<form method="post" action="/new-website/keywords/seo/${row.id}/retry" class="kw-seo-retry">
          <button class="ns-btn small">Write again</button>
        </form>`
      : raw('')}
    ${row.role === 'sub'
      ? html`<form method="post" action="/new-website/keywords/${String(row.plan_id)}/sub/delete" class="kw-seo-retry" data-name="${row.keyword}"
          onsubmit="return confirm('Delete ' + this.dataset.name + '?')"><input type="hidden" name="keyword" value="${row.keyword}"><input type="hidden" name="back" value="seo"><button class="ns-btn small danger">Delete</button></form>`
      : raw('')}
    ${shown
      ? html`<div class="kw-serp">
          <div class="kw-serp-title">${row.title}</div>
          <div class="kw-serp-desc">${row.description}</div>
        </div>
        <dl class="kw-seo-facts">
          <div><dt>Title</dt><dd class="ns-num ${fits(row.title.length, TITLE) ? '' : 'off'}">${row.title.length} characters</dd></div>
          <div><dt>Description</dt><dd class="ns-num ${fits(row.description.length, DESCRIPTION) ? '' : 'off'}">${row.description.length} characters</dd></div>
          <div><dt>Focus keyword</dt><dd>${row.focus_keyword}</dd></div>
          <div><dt>E-E-A-T</dt><dd>${row.eeat || '—'}${row.confidence ? ` · ${row.confidence} confidence` : ''}</dd></div>
          <div class="wide"><dt>Image alt text</dt><dd>${row.alt_text}</dd></div>
          ${row.reasoning ? html`<div class="wide"><dt>Why it works</dt><dd>${row.reasoning}</dd></div>` : raw('')}
        </dl>`
      : html`<p class="kw-none" style="margin:4px 0 0">${row.status === 'writing' ? 'The AI is writing this now.' : 'Waiting for its turn.'}</p>`}
    ${row.status === 'failed' ? html`${problemList(row.problems)}${retryNote(row)}` : keptList(row.status, row.problems)}`;
  return card(head, body, row.status === 'failed');
}

/** One keyword's AI#2 outline: headings, word targets and key points. */
function skeletonCard(row: SeoRow, intent: string): Html {
  const k: Skeleton | null = row.skeleton_json ? parseSkeleton(row.skeleton_json) : null;
  const state =
    row.status !== 'done'
      ? 'Needs SEO first'
      : row.recipe_status && row.recipe_status !== 'done'
        ? 'Needs the recipe first'
        : (SKELETON_STATUS[row.skeleton_status] ?? 'Waiting');
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b>${k && row.skeleton_status === 'done'
    ? html`<span class="ns-num kw-count">${k.sections.length} sections · ${totalWords(k)} words</span>`
    : raw('')}<span class="kw-seo-status ${row.skeleton_status}">${state}</span>`;
  const body = html`
    ${row.skeleton_status === 'done' || row.skeleton_status === 'failed'
      ? html`<form method="post" action="/new-website/keywords/skeleton/${row.id}/retry" class="kw-seo-retry">
          <button class="ns-btn small">Make skeleton again</button>
        </form>`
      : raw('')}
    ${k
      ? html`<div class="kw-skel">
          <div class="kw-skel-h1">H1 · ${k.h1}${row.article_type ? html` <span class="kw-count">(${row.article_type})</span>` : raw('')}</div>
          <ol class="kw-skel-list">
            ${k.sections.map(
              (sec) => html`<li>
                <div class="kw-skel-h2"><b>${sec.h2}</b><span class="ns-num">${sec.words ? `${sec.words} words` : ''}</span></div>
                ${sec.covers ? html`<div class="kw-skel-covers">${sec.covers}</div>` : raw('')}
                <ul>${sec.keyPoints.map((pt) => html`<li>${pt}</li>`)}</ul>
                ${sec.h3.length
                  ? html`<ol class="kw-skel-h3s">${sec.h3.map(
                      (h) => html`<li><div class="kw-skel-h2"><span>${h.h3}</span><span class="ns-num">${h.words ? `${h.words} words` : ''}</span></div>
                        ${h.keyPoints.length ? html`<ul>${h.keyPoints.map((pt) => html`<li>${pt}</li>`)}</ul>` : raw('')}</li>`,
                    )}</ol>`
                  : raw('')}
              </li>`,
            )}
          </ol>
        </div>`
      : html`<p class="kw-none" style="margin:4px 0 0">${row.status !== 'done'
          ? 'The skeleton is made once this keyword has its SEO metadata.'
          : row.skeleton_status === 'writing' ? 'The AI is designing this outline now.' : 'Waiting for its turn.'}</p>`}
    ${row.skeleton_status === 'failed' ? html`${problemList(row.skeleton_problems)}${retryNote(row)}` : keptList(row.skeleton_status, row.skeleton_problems)}`;
  return card(head, body, row.skeleton_status === 'failed');
}

const busyRows = (rows: SeoRow[]): boolean =>
  rows.some((r) =>
    [r.status, r.recipe_status, r.skeleton_status, r.article_status, r.images_status].some((st) => st === 'pending' || st === 'writing') ||
    r.post_status === 'publishing',
  );

/** Step 2: the SEO metadata (AI#1) of every keyword in one plan. */
export function seoStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[]): Html {
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const done = rows.filter((r) => r.status === 'done').length;
  const body = html`
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => seoCard(r, intentOf.get(r.keyword) ?? ''))}
        </ul>`
      : html`<form method="post" action="/new-website/keywords/${plan.id}/seo/start">
          <input type="hidden" name="websiteId" value="${site.id}" />
          <p class="kw-none">This plan was saved before SEO metadata was written automatically.</p>
          <button class="ns-btn primary">Write SEO metadata</button>
        </form>`}`;
  const foot = html`
    <a class="ns-btn quiet" href="/new-website/keywords#website-${site.id}">Previous</a>
    ${articleTypeFor(site.niche) === 'recipe'
      ? html`<a class="ns-btn primary" href="${planHref(plan.id, 'recipe')}">Next: recipes</a>`
      : html`<a class="ns-btn primary" href="${planHref(plan.id, 'skeleton')}">Next: skeletons</a>`}`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(stepNames(site.niche), 1, plan.pillar, html`${site.name} · <span class="ns-num">${done} of ${rows.length || plan.items.length + 1} done</span>`, body, foot, stepHrefs(stepNames(site.niche), plan.id, site.id))}
    ${raw(watchScript)}`;
}

/** Step 3: the article skeleton (AI#2) of every keyword in one plan. */
export function skeletonStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[]): Html {
  const all = rows;
  rows = readyFor('skeleton', site, all);
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const done = rows.filter((r) => r.skeleton_status === 'done').length;
  const body = html`
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => skeletonCard(r, intentOf.get(r.keyword) ?? ''))}
        </ul>`
      : all.length ? raw('') : html`<p class="kw-none">Skeletons follow the SEO metadata. Go back one step to start it.</p>`}
    ${waitingNote('skeleton', all.length - rows.length, busyRows(all), plan.id)}`;
  const foot = html`
    <a class="ns-btn quiet" href="${planHref(plan.id, articleTypeFor(site.niche) === 'recipe' ? 'recipe' : 'seo')}">Previous</a>
    <a class="ns-btn primary" href="${planHref(plan.id, 'article')}">Next: articles</a>`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(stepNames(site.niche), stepNames(site.niche).indexOf('Skeleton'), plan.pillar, html`${site.name} · <span class="ns-num">${done} of ${rows.length} done</span>`, body, foot, stepHrefs(stepNames(site.niche), plan.id, site.id))}
    ${raw(watchScript)}`;
}

/** One keyword's fixed recipe: the card the article will follow exactly. */
function recipeCard(row: SeoRow, intent: string): Html {
  const r = row.recipe_json ? parseRecipe(row.recipe_json) : null;
  if (row.page === 'article') {
    return card(
      html`${roleLabel(row, intent)}<b>${row.keyword}</b><span class="kw-seo-status">Article page · no recipe</span>`,
      html`<p class="kw-none" style="margin:4px 0 0">This keyword answers a question rather than cooking a dish, so it is written as an article without a recipe. You chose this on step 1.</p>`,
    );
  }
  const state = row.status !== 'done' ? 'Needs SEO first' : (SKELETON_STATUS[row.recipe_status] ?? 'Waiting');
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b>${r && row.recipe_status === 'done'
    ? html`<span class="ns-num kw-count">${r.ingredients.reduce((n, g) => n + g.items.length, 0)} ingredients · ${r.steps.length} steps</span>`
    : raw('')}<span class="kw-seo-status ${row.recipe_status}">${state}</span>`;
  const body = html`
    ${row.recipe_status === 'done' || row.recipe_status === 'failed' || (row.status === 'done' && !row.recipe_status)
      ? html`<form method="post" action="/new-website/keywords/recipe/${row.id}/retry" class="kw-seo-retry">
          <button class="ns-btn small">${row.recipe_status ? 'Make recipe again' : 'Make recipe'}</button>
        </form>`
      : raw('')}
    ${r
      ? html`<div class="kw-recipe">
          <dl class="kw-recipe-facts">
            <div><dt>Prep</dt><dd class="ns-num">${r.prepMinutes} min</dd></div>
            <div><dt>Cook</dt><dd class="ns-num">${r.cookMinutes} min</dd></div>
            <div><dt>Servings</dt><dd class="ns-num">${r.servings}</dd></div>
            <div><dt>Difficulty</dt><dd class="cap">${r.difficulty || '—'}</dd></div>
            <div><dt>Cuisine</dt><dd>${r.cuisine || '—'}</dd></div>
            <div><dt>Course</dt><dd>${r.course || '—'}</dd></div>
          </dl>
          <div class="kw-recipe-cols">
            <div>
              <h4>Ingredients</h4>
              ${r.ingredients.map((g) => html`${g.title ? html`<div class="kw-recipe-group">${g.title}</div>` : raw('')}
                <ul>${g.items.map((i) => html`<li>${i}</li>`)}</ul>`)}
            </div>
            <div>
              <h4>Steps</h4>
              <ol>${r.steps.map((st) => html`<li>${st.text}</li>`)}</ol>
            </div>
          </div>
          <div class="kw-recipe-foot ns-num">Per serving: ${r.nutrition.calories} kcal · ${r.nutrition.protein} g protein · ${r.nutrition.carbs} g carbs · ${r.nutrition.fat} g fat</div>
          ${r.notes ? html`<div class="kw-recipe-notes"><b>Notes</b> ${r.notes}</div>` : raw('')}
        </div>`
      : html`<p class="kw-none" style="margin:4px 0 0">${row.status !== 'done'
          ? 'The recipe is made once this keyword has its SEO metadata.'
          : row.recipe_status === 'writing' ? 'The AI is writing this recipe now.' : 'Waiting for its turn.'}</p>`}
    ${row.recipe_status === 'failed' ? html`${problemList(row.recipe_problems)}${retryNote(row)}` : keptList(row.recipe_status, row.recipe_problems)}`;
  return card(head, body, row.recipe_status === 'failed');
}

/** Recipe websites only: the fixed recipe of every keyword in one plan. */
export function recipeStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[]): Html {
  const all = rows;
  rows = readyFor('recipe', site, all);
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const done = rows.filter((r) => r.recipe_status === 'done').length;
  const body = html`
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => recipeCard(r, intentOf.get(r.keyword) ?? ''))}
        </ul>`
      : all.length ? raw('') : html`<p class="kw-none">Recipes follow the SEO metadata. Go back one step to start it.</p>`}
    ${waitingNote('recipe', all.length - rows.length, busyRows(all), plan.id)}`;
  const foot = html`
    <a class="ns-btn quiet" href="${planHref(plan.id, 'seo')}">Previous</a>
    <a class="ns-btn primary" href="${planHref(plan.id, 'skeleton')}">Next: skeletons</a>`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(stepNames(site.niche), 2, plan.pillar, html`${site.name} · <span class="ns-num">${done} of ${rows.length} done</span>`, body, foot, stepHrefs(stepNames(site.niche), plan.id, site.id))}
    ${raw(watchScript)}`;
}

/** One keyword's written article (AI#3), shown as it will read. */
function articleCard(row: SeoRow, intent: string): Html {
  const ready = row.skeleton_status === 'done';
  const state = !ready ? 'Needs the skeleton first' : (SKELETON_STATUS[row.article_status] ?? 'Waiting');
  const failed = row.article_status === 'failed';
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b>${row.article_status === 'done'
    ? html`<span class="ns-num kw-count">${row.article_words.toLocaleString('en')} words</span>`
    : raw('')}<span class="kw-seo-status ${row.article_status}">${row.article_status === 'writing' ? 'Writing…' : state}</span>`;
  const body = html`
    ${row.article_status === 'done' || failed
      ? html`<form method="post" action="/new-website/keywords/article/${row.id}/retry" class="kw-seo-retry">
          <button class="ns-btn ${failed ? 'primary' : 'small'}">${failed ? 'Carry on writing' : 'Write article again'}</button>
        </form>`
      : raw('')}
    ${failed
      ? html`${problemList(row.article_problems)}${retryNote(row)}
          <p class="kw-none" style="margin:8px 0 16px">${row.article_md
            ? 'The sections written before the failed one are kept below. Carrying on writes from the failed section.'
            : 'The first section failed, so nothing is kept yet.'}</p>`
      : keptList(row.article_status, row.article_problems)}
    ${row.article_md
      ? html`<article class="kw-article"><h1>${row.title}</h1>${raw(markdownToHtml(row.article_md))}</article>`
      : failed
        ? raw('')
        : html`<p class="kw-none" style="margin:4px 0 0">${!ready
            ? 'The article is written once this keyword has its skeleton.'
            : row.article_status === 'writing' ? 'The AI is writing this article now, one section at a time.' : 'Waiting for its turn.'}</p>`}`;
  return card(head, body, row.article_status === 'failed');
}

/** The written article (AI#3) of every keyword in one plan. */
export function articleStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[]): Html {
  const all = rows;
  rows = readyFor('article', site, all);
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const done = rows.filter((r) => r.article_status === 'done').length;
  const names = stepNames(site.niche);
  const body = html`
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => articleCard(r, intentOf.get(r.keyword) ?? ''))}
        </ul>`
      : all.length ? raw('') : html`<p class="kw-none">Articles follow the skeletons. Go back to start them.</p>`}
    ${waitingNote('article', all.length - rows.length, busyRows(all), plan.id)}`;
  const foot = html`
    <a class="ns-btn quiet" href="${planHref(plan.id, 'skeleton')}">Previous</a>
    <a class="ns-btn primary" href="${planHref(plan.id, 'images')}">Next: images</a>`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(names, names.indexOf('Article'), plan.pillar, html`${site.name} · <span class="ns-num">${done} of ${rows.length} done</span>`, body, foot, stepHrefs(names, plan.id, site.id))}
    ${raw(watchScript)}`;
}

const PICTURE_STATE: Record<PictureRow['status'], string> = {
  queued: 'In the queue',
  making: 'Making…',
  done: 'Made',
  failed: 'Failed',
};

/** The picture made from one prompt, or where it is in the queue. */
function pictureBox(picture: PictureRow | undefined, slot: string): Html {
  if (!picture) {
    return html`<div class="kw-pic kw-pic-empty">${isStepSlot(slot) ? 'Slow queue, after the main pictures' : 'Not made yet'}</div>`;
  }
  if (picture.status === 'queued' && isStepSlot(slot)) return html`<div class="kw-pic kw-pic-empty queued"><span>In the slow queue</span></div>`;
  if (picture.status === 'done') {
    return html`<a class="kw-pic" href="/new-website/pictures/${picture.id}/file" target="_blank" rel="noopener">
      <img src="/new-website/pictures/${picture.id}/file" alt="${picture.alt}" loading="lazy"></a>`;
  }
  return html`<div class="kw-pic kw-pic-empty ${picture.status}">
    <span>${PICTURE_STATE[picture.status]}</span>
    ${picture.status === 'failed'
      ? html`<small title="${picture.error}">${picture.error}</small>
        <form method="post" action="/new-website/pictures/${picture.id}/retry"><button class="ns-btn small kw-pic-retry">Try again</button></form>`
      : raw('')}
  </div>`;
}

/** One keyword's image prompts (AI#4) and the pictures made from them. */
function imagesCard(row: SeoRow, intent: string, pictures: PictureRow[]): Html {
  const ready = row.article_status === 'done';
  const set = row.images_json ? parseImageSet(row.images_json) : null;
  const bySlot = new Map(pictures.map((p) => [p.slot, p]));
  const promptsDone = Boolean(set && row.images_status === 'done');
  // Only pictures made from the prompt as it is now count.
  const current = promptsDone ? set!.images.map((im) => bySlot.get(im.slot)).map((p, i) => (p && p.prompt === set!.images[i]!.prompt ? p : undefined)) : [];
  const made = current.filter((p) => p?.status === 'done').length;
  const main = promptsDone ? set!.images.map((im, i) => ({ slot: im.slot, p: current[i] })).filter((x) => !isStepSlot(x.slot)) : [];
  const mainLeft = main.filter((x) => x.p?.status !== 'done').length;
  const mainBusy = main.some((x) => x.p?.status === 'queued' || x.p?.status === 'making');
  const making = current.some((p) => p?.status === 'making');
  const stepsWaiting = current.some((p, i) => p?.status === 'queued' && isStepSlot(set!.images[i]!.slot));
  const failedPics = current.filter((p) => p?.status === 'failed').length;
  const state = !ready ? 'Needs the article first' : (SKELETON_STATUS[row.images_status] ?? 'Waiting');
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b>${promptsDone
    ? html`<span class="ns-num kw-count">${made} of ${set!.images.length} pictures</span>`
    : raw('')}<span class="kw-seo-status ${row.images_status}">${row.images_status === 'writing' ? 'Writing…' : mainBusy || making ? 'Making pictures…' : stepsWaiting ? 'Steps in the slow queue' : state}</span>`;
  const body = html`
    ${row.images_status === 'done' || row.images_status === 'failed'
      ? html`<div class="kw-seo-retry kw-pic-actions">
          ${promptsDone && mainLeft > 0 && !mainBusy
            ? html`<form method="post" action="/new-website/keywords/pictures/${row.id}/make">
                <button class="ns-btn primary">Make ${mainLeft} main picture${mainLeft === 1 ? '' : 's'}</button>
              </form>`
            : raw('')}
          ${failedPics
            ? html`<form method="post" action="/new-website/keywords/pictures/${row.id}/retry-failed">
                <button class="ns-btn primary">Try ${failedPics} failed picture${failedPics === 1 ? '' : 's'} again</button>
              </form>`
            : raw('')}
          ${row.images_status === 'failed' || !(mainBusy || making)
            ? html`<form method="post" action="/new-website/keywords/images/${row.id}/retry">
                <button class="ns-btn small" ${made ? raw(`onclick="return confirm('New prompts mean the ${made} pictures made so far are made again. Carry on?')"`) : raw('')}>Write image prompts again</button>
              </form>`
            : raw('')}
        </div>`
      : raw('')}
    ${row.images_status === 'failed' ? html`${problemList(row.images_problems)}${retryNote(row)}` : keptList(row.images_status, row.images_problems)}
    ${promptsDone
      ? html`<div class="kw-img">
          <dl class="kw-img-theme">
            <div><dt>Surface</dt><dd>${set!.theme.surface}</dd></div>
            <div><dt>Lighting</dt><dd>${set!.theme.lighting}</dd></div>
            <div><dt>Palette</dt><dd>${set!.theme.palette}</dd></div>
            <div><dt>Style</dt><dd>${set!.theme.style}</dd></div>
            <div><dt>Mood</dt><dd>${set!.theme.mood}</dd></div>
            ${set!.theme.dish ? html`<div><dt>Dish</dt><dd>${set!.theme.dish}</dd></div>` : raw('')}
          </dl>
          <ol class="kw-img-list">
            ${set!.images.map(
              (im, i) => html`<li>
                <div>
                  <div class="kw-img-slot">${im.slot.replace(/-/g, ' ')}</div>
                  <p class="kw-img-prompt">${im.prompt}</p>
                  <div class="kw-img-alt"><b>Alt</b> ${im.alt}</div>
                </div>
                ${pictureBox(current[i], im.slot)}
              </li>`,
            )}
          </ol>
        </div>`
      : row.images_status === 'failed'
        ? raw('')
        : html`<p class="kw-none" style="margin:4px 0 0">${!ready
            ? 'The image prompts are written once this keyword has its article.'
            : row.images_status === 'writing' ? 'The AI is writing the image prompts now.' : 'Waiting for its turn.'}</p>`}`;
  // Opened when something failed, so its Try again buttons are in sight.
  return card(head, body, row.images_status === 'failed' || failedPics > 0);
}

/** The image prompts (AI#4) of every keyword in one plan, and their pictures. */
export function imagesStepPage(
  site: NewWebsiteRow,
  plan: KeywordPlan,
  rows: SeoRow[],
  pictures: PictureRow[] = [],
  nextStepAt = 0,
  now = Date.now(),
  stopped = false,
): Html {
  const all = rows;
  rows = readyFor('images', site, all);
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const names = stepNames(site.niche);
  const recipeSite = articleTypeFor(site.niche) === 'recipe';
  const picturesOf = (id: number) => pictures.filter((p) => p.seo_id === id);
  const busy = busyRows(rows) || pictures.some((p) => p.status === 'queued' || p.status === 'making');
  const made = pictures.filter((p) => p.status === 'done').length;
  const slotsOf = (r: SeoRow) => (r.images_status === 'done' ? (parseImageSet(r.images_json)?.images ?? []) : []);
  const total = rows.reduce((n, r) => n + slotsOf(r).length, 0);
  const mainTotal = rows.reduce((n, r) => n + slotsOf(r).filter((im) => !isStepSlot(im.slot)).length, 0);
  const mainMade = pictures.filter((p) => p.status === 'done' && !isStepSlot(p.slot)).length;
  const stepsWaiting = pictures.filter((p) => p.status === 'queued' && isStepSlot(p.slot)).length;
  // Failed pictures made from each article's prompts as they are now: what "Try again" remakes.
  const failedAll = rows.reduce((n, r) => {
    const prompts = new Map(slotsOf(r).map((im) => [im.slot, im.prompt]));
    return n + picturesOf(r.id).filter((p) => p.status === 'failed' && prompts.get(p.slot) === p.prompt).length;
  }, 0);
  const minutes = Math.max(0, Math.round((nextStepAt - now) / 60_000));
  const body = html`
    ${recipeSite && stepsWaiting
      ? html`<p class="kw-hint ns-num">${stepsWaiting} step picture${stepsWaiting === 1 ? '' : 's'} waiting; the next ${minutes ? `in about ${minutes} minute${minutes === 1 ? '' : 's'}` : 'any moment now'}.</p>`
      : raw('')}
    ${failedAll
      ? html`<div class="kw-failed-bar" role="status"><span><b class="ns-num">${failedAll} picture${failedAll === 1 ? '' : 's'}</b> failed to make.</span>
          <form method="post" action="/new-website/keywords/plan/${plan.id}/pictures/retry-failed" style="margin:0"><button class="ns-btn primary">Try all ${failedAll} again</button></form></div>`
      : raw('')}
    ${rows.length
      ? html`<ul class="acc-list" ${busy ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => imagesCard(r, intentOf.get(r.keyword) ?? '', picturesOf(r.id)))}
        </ul>`
      : all.length ? raw('') : html`<p class="kw-none">Image prompts follow the articles. Go back to start them.</p>`}
    ${waitingNote('images', all.length - rows.length, busyRows(all), plan.id)}`;
  const foot = html`
    <a class="ns-btn quiet" href="${planHref(plan.id, 'article')}">Previous</a>
    ${busy && !stopped
      ? html`<form method="post" action="/new-website/keywords/plan/${plan.id}/pictures/stop" style="margin:0"><button class="ns-btn">Stop</button></form>`
      : raw('')}
    ${busy || stopped
      ? html`<form method="post" action="/new-website/keywords/plan/${plan.id}/pictures/restart" style="margin:0"><button class="ns-btn">${stopped ? 'Start' : 'Restart'}</button></form>`
      : raw('')}
    ${mainTotal > mainMade
      ? html`<form method="post" action="/new-website/keywords/plan/${plan.id}/pictures/make" style="margin:0">
          <button class="ns-btn primary" ${raw(`onclick="return confirm('Send ${mainTotal - mainMade} main pictures to Google Flow, one at a time? Step pictures follow in the slow queue.')"`)}>Make all main pictures</button>
        </form>`
      : html`<a class="ns-btn primary" href="${planHref(plan.id, 'publish')}">Next: publish</a>`}`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(names, names.indexOf('Images'), plan.pillar, html`${site.name} · <span class="ns-num">${made} of ${total} pictures made</span>`, body, foot, stepHrefs(names, plan.id, site.id))}
    ${raw(watchScript)}`;
}

/** One keyword's post on its website: ready or not, posted, and its step pictures so far. */
function publishCard(row: SeoRow, intent: string, pictures: PictureRow[]): Html {
  const reason = notReadyReason(row, pictures);
  const steps = pictures.filter((p) => isStepSlot(p.slot));
  const stepsOn = steps.filter((p) => p.media_id).length;
  const state =
    row.post_status === 'publishing' ? 'Publishing…'
      : row.post_status === 'published' ? (row.post_state === 'draft' ? 'Posted as a draft' : 'Published')
        : row.post_status === 'failed' ? 'Failed'
          : reason ? 'Not ready' : 'Ready';
  const cls = row.post_status === 'published' ? 'done' : row.post_status === 'failed' ? 'failed' : row.post_status === 'publishing' ? 'writing' : '';
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b><span class="kw-seo-status ${cls}">${state}</span>`;
  const body = html`
    ${!reason && row.post_status !== 'publishing'
      ? html`<form method="post" action="/new-website/keywords/publish/${row.id}" class="kw-seo-retry">
          <button class="ns-btn ${row.post_status === 'published' ? 'small' : 'primary'}">${row.post_status === 'published' ? 'Publish again (update the post)' : 'Publish'}</button>
        </form>`
      : raw('')}
    ${row.post_status === 'failed' ? problemList(row.post_error) : reason ? html`<p class="kw-none" style="margin:0">${reason}</p>` : raw('')}
    <dl class="kw-seo-facts">
      <div><dt>Title</dt><dd>${row.title}</dd></div>
      ${row.post_url ? html`<div><dt>On the website</dt><dd><a href="${row.post_url}" target="_blank" rel="noopener">${row.post_url}</a></dd></div>` : raw('')}
      ${row.posted_at ? html`<div><dt>Posted</dt><dd class="ns-num">${row.posted_at} (UTC)</dd></div>` : raw('')}
      ${steps.length
        ? html`<div><dt>Step pictures</dt><dd class="ns-num">${stepsOn} of ${steps.length} on the post${row.post_status === 'published' && stepsOn < steps.length ? ' · the rest are added as the slow queue makes them' : ''}</dd></div>`
        : raw('')}
    </dl>`;
  return card(head, body, row.post_status === 'failed');
}

/** The last step: each keyword's article posted to its website. */
export function publishStepPage(site: NewWebsiteRow, plan: KeywordPlan, rows: SeoRow[], pictures: PictureRow[] = []): Html {
  const all = rows;
  rows = readyFor('publish', site, all);
  const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
  const names = stepNames(site.niche);
  const picturesOf = (id: number) => pictures.filter((p) => p.seo_id === id);
  const posted = rows.filter((r) => r.post_status === 'published').length;
  const ready = rows.filter((r) => r.post_status !== 'published' && r.post_status !== 'publishing' && !notReadyReason(r, picturesOf(r.id))).length;
  const body = html`
    ${rows.length
      ? html`<ul class="acc-list" ${busyRows(rows) ? raw(`data-watch="${plan.id}"`) : raw('')}>
          ${rows.map((r) => publishCard(r, intentOf.get(r.keyword) ?? '', picturesOf(r.id)))}
        </ul>`
      : all.length ? raw('') : html`<p class="kw-none">Nothing to publish yet.</p>`}
    ${waitingNote('publish', all.length - rows.length, busyRows(all), plan.id)}`;
  const foot = html`
    <a class="ns-btn quiet" href="${planHref(plan.id, 'images')}">Previous</a>
    ${ready
      ? html`<form method="post" action="/new-website/keywords/plan/${plan.id}/publish" style="margin:0">
          <button class="ns-btn primary" ${raw(`onclick="return confirm('Publish ${ready} article${ready === 1 ? '' : 's'} to ${site.domain}?')"`)}>Publish all ready (${ready})</button>
        </form>`
      : html`<a class="ns-btn primary" href="${planHref(plan.id, 'share')}">Next: share</a>`}`;
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}</style>
    ${stepCard(names, names.indexOf('Publish'), plan.pillar, html`${site.name} · <span class="ns-num">${posted} of ${rows.length} posted</span>`, body, foot, stepHrefs(names, plan.id, site.id))}
    ${raw(watchScript)}`;
}

/* -- Step: Share ------------------------------------------------------------ */

const SHARE_STATUS: Record<SocialPostRow['status'], string> = {
  pending: 'Writing its words',
  picture: 'Making its picture',
  waiting: 'Waiting for room in Buffer',
  sent: 'Posted',
  failed: 'Failed',
};
const SHARE_CLASS: Record<SocialPostRow['status'], string> = { pending: 'writing', picture: 'writing', waiting: 'writing', sent: 'done', failed: 'failed' };
const PLATFORM_LABEL: Record<string, string> = { pinterest: 'Pinterest', facebook: 'Facebook' };
export const labelOf = (platform: string): string => PLATFORM_LABEL[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
/** A field name as a label: "description" -> "Description", "cta" -> "Cta". */
const fieldLabel = (f: string): string => ({ cta: 'Call to action', alt: 'Alt text', text: 'Post' } as Record<string, string>)[f] ?? (f.charAt(0).toUpperCase() + f.slice(1)).replace(/_/g, ' ');

/** Posts still being made: the page refreshes itself while there are any. */
export const sharingBusy = (posts: SocialPostRow[]): boolean => posts.some((p) => p.status === 'pending' || p.status === 'picture');

/**
 * The links of a shared post: the post itself on its platform once it is
 * out, and the article it shares. A Buffer post has its link only once
 * Buffer has sent it.
 */
export function postLinks(p: { status: string; post_link: string; external_id: string }, channel: ChannelRow | undefined, articleUrl = ''): Html {
  const where = channel ? `${channel.name} (${labelOf(channel.platform)})` : 'its platform';
  const link = postLinkOf(p, channel, 'post');
  const post = link
    ? html`<a class="ns-btn small" href="${link}" target="_blank" rel="noopener">Open the post on ${where} ↗</a>`
    : p.status === 'sent' && channel?.via === 'buffer'
      ? html`<span class="kw-share-meta">The link to the post appears here once Buffer has posted it.</span>`
      : raw('');
  const article = articleUrl ? html`<a class="ns-btn small quiet" href="${articleUrl}" target="_blank" rel="noopener">Open the article ↗</a>` : raw('');
  return link || articleUrl || p.status === 'sent' ? html`<div class="kw-share-links">${post}${article}</div>` : raw('');
}

/** One post on one channel: the words and picture it was made with, where it stands, and what you can do. */
export function sharePostRow(p: SocialPostRow, channel: ChannelRow | undefined, planId: number, picture: PictureRow | undefined, heading = '', articleUrl = ''): Html {
  const where = channel ? `${channel.name} · ${labelOf(channel.platform)} through ${channel.via === 'buffer' ? 'Buffer' : 'the API'}` : 'A removed channel';
  const viaBuffer = channel?.via === 'buffer';
  const status = p.status === 'sent' && viaBuffer ? 'Queued in Buffer' : SHARE_STATUS[p.status];
  const facts = [
    p.board_name ? `board “${p.board_name}”` : '',
    p.template ? `picture template ${p.template}` : '',
    p.status === 'sent' && viaBuffer && p.due_at ? `Buffer posts it ${p.due_at.replace('T', ' ').slice(0, 16)} UTC` : '',
    p.status === 'sent' && !viaBuffer && p.sent_at ? `posted ${p.sent_at} UTC` : '',
    p.status === 'waiting' && p.retry_at ? `tries again ${new Date(p.retry_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '',
  ].filter(Boolean).join(' · ');
  let fields: Record<string, string> = {};
  try {
    fields = JSON.parse(p.fields_json || '{}') as Record<string, string>;
  } catch {
    /* shown without them */
  }
  if (!Object.keys(fields).length && (p.text || p.title)) {
    // Words made before each platform's fields were kept on their own.
    let overlay: Record<string, string> = {};
    try {
      overlay = JSON.parse(p.overlay || '{}') as Record<string, string>;
    } catch {
      /* without it */
    }
    fields = { ...overlay, title: p.title, text: p.text, alt: p.alt };
  }
  const shown = Object.entries(fields).filter(([, v]) => v);
  const pictureBox = picture?.status === 'done'
    ? html`<a class="kw-share-pic" href="/new-website/pictures/${String(picture.id)}/file" target="_blank" rel="noopener"><img src="/new-website/pictures/${String(picture.id)}/file" alt="${p.alt || p.title}" loading="lazy" /></a>`
    : html`<div class="kw-share-pic empty">${picture?.status === 'failed' ? 'Picture failed' : picture ? 'Making its picture…' : 'No picture yet'}</div>`;
  const canRemake = p.status !== 'sent' && p.status !== 'picture';
  return html`<li class="kw-share-post">
    ${pictureBox}
    <div class="kw-share-main">
      <div class="kw-share-top"><b>${heading || where}</b><span class="kw-seo-status ${SHARE_CLASS[p.status]}">${status}</span></div>
      ${facts ? html`<div class="kw-share-meta">${facts}</div>` : raw('')}
      ${shown.length
        ? html`<dl class="kw-share-words">${shown.map(([k, v]) => html`<div><dt>${fieldLabel(k)}</dt><dd>${v}</dd></div>`)}</dl>`
        : html`<p class="kw-share-meta">Its words are being written from the article, by ${channel ? html`<a href="/new-website/channels/${String(channel.id)}">this channel’s rules</a>` : 'its channel’s rules'}.</p>`}
      ${p.error ? html`<div class="${p.status === 'failed' ? 'kw-seo-problems' : 'kw-kept'}">${p.error}</div>` : raw('')}
      ${postLinks(p, channel, articleUrl)}
      <div class="kw-share-actions">
        ${p.status === 'failed'
          ? html`<form method="post" action="/new-website/keywords/share/post/${p.id}/retry"><button class="ns-btn small primary">Try again</button></form>`
          : raw('')}
        ${canRemake && (p.text || p.picture_id)
          ? html`<form method="post" action="/new-website/keywords/share/post/${p.id}/remake"><button class="ns-btn small">Make again</button></form>`
          : raw('')}
      </div>
    </div>
  </li>`;
}

/** Channels this keyword's article should be on but has no post for yet. */
/** The channels an article is not shared on yet; with its category, only those that share that category. */
export const missingChannels = (posts: SocialPostRow[], channels: ChannelRow[], category?: string): ChannelRow[] =>
  channels.filter((c) => (category === undefined || channelTakes(c, category)) && (c.platform !== 'facebook' || c.post_image) && !posts.some((p) => p.channel_id === c.id));

export function shareCard(row: SeoRow, intent: string, posts: SocialPostRow[], channels: ChannelRow[], allChannels: ChannelRow[], planId: number, pictures: PictureRow[]): Html {
  const published = row.post_status === 'published' && Boolean(row.post_url);
  const sent = posts.filter((p) => p.status === 'sent').length;
  const failed = posts.filter((p) => p.status === 'failed').length;
  const missing = published ? missingChannels(posts, channels, row.post_category) : [];
  const state = !published
    ? 'Not published yet'
    : !posts.length
      ? channels.length ? 'Not shared yet' : 'No channel'
      : failed
        ? `${failed} failed`
        : sent === posts.length
          ? `Shared on ${sent}`
          : `Sharing (${sent} of ${posts.length})`;
  const cls = !published || !posts.length ? '' : failed ? 'failed' : sent === posts.length ? 'done' : 'writing';
  const head = html`${roleLabel(row, intent)}<b>${row.keyword}</b><span class="kw-seo-status ${cls}">${state}</span>`;
  const byId = new Map(allChannels.map((c) => [c.id, c]));
  const body = html`
    ${missing.length
      ? html`<form method="post" action="/new-website/keywords/share/${row.id}" class="kw-seo-retry">
          <button class="ns-btn ${posts.length ? 'small' : 'primary'}">${posts.length ? `Share on ${missing.length} more channel${missing.length === 1 ? '' : 's'}` : 'Share now'}</button>
        </form>`
      : raw('')}
    ${!published
      ? html`<p class="kw-none" style="margin:0">Shared once its article is published on the website.</p>`
      : !channels.length && !posts.length
        ? html`<p class="kw-none" style="margin:0">This website shares on no channel yet.</p>`
        : raw('')}
    ${posts.length ? html`<ul class="kw-share-list">${posts.map((p) => sharePostRow(p, byId.get(p.channel_id), planId, pictures.find((x) => x.id === p.picture_id), '', row.post_url))}</ul>` : raw('')}`;
  return card(head, body, failed > 0);
}

/** Opens and closes the cards, and refreshes the page while the AI is still working. */
const watchScript = `<script>
(function () {
  document.querySelectorAll('.acc-head').forEach(function (b) {
    b.addEventListener('click', function () {
      var li = b.closest('.acc');
      var open = li.classList.toggle('open');
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
  var list = document.querySelector('[data-watch]');
  if (!list) return;
  var id = list.getAttribute('data-watch'), seen;
  setInterval(function () {
    fetch('/new-website/keywords/' + id + '/seo').then(function (r) { return r.json(); }).then(function (r) {
      var key = r.rows.map(function (x) { return [x.status, x.recipe_status, x.skeleton_status, x.article_status, x.images_status, x.post_status].join('/'); }).join(',')
        + '|' + (r.pictures || []).map(function (x) { return x.id + x.status; }).join(',')
        + '|' + (r.social || []).map(function (x) { return x.id + x.status; }).join(',');
      if (seen !== undefined && seen !== key) location.reload();
      seen = key;
    }).catch(function () {});
  }, 5000);
})();
</script>`;

const script = (websiteId: number, recipeSite: boolean): string => `<script>
(function () {
  var LABELS = ${JSON.stringify(INTENT_LABEL)};
  var MAX = 6;
  var RECIPE_SITE = ${recipeSite ? 'true' : 'false'};
  var state = { pillar: '', pillarPage: 'recipe', pillarReason: '', items: [], dropped: [] };

  // Recipe page or article page: shown, and switchable, only on recipe websites.
  function pageChip(get, set, reason) {
    var wrap = el('span', 'kw-page');
    var b = el('button', 'kw-page-chip ' + get(), get() === 'recipe' ? 'Recipe page' : 'Article page');
    b.type = 'button';
    b.title = 'Switch between a recipe page (gets a full recipe) and an article page (no recipe)';
    b.onclick = function () { set(get() === 'recipe' ? 'article' : 'recipe'); render(); };
    wrap.appendChild(b);
    if (reason) wrap.appendChild(el('span', 'kw-page-why', reason));
    return wrap;
  }
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function post(url, fields) {
    var p = new URLSearchParams();
    p.set('websiteId', '${websiteId}');
    Object.keys(fields).forEach(function (k) { p.set(k, fields[k]); });
    return fetch(url, { method: 'POST', body: p }).then(function (r) { return r.json(); });
  }

  function render() {
    $('kw-result').hidden = false;
    $('kw-title').textContent = 'Sub-keywords for “' + state.pillar + '”';
    $('kw-count').textContent = state.items.length + ' of ' + MAX;
    var list = $('kw-list'); list.textContent = '';
    if (!state.items.length) list.appendChild(el('li', 'kw-empty', 'None kept. Add your own below, or try a different pillar.'));
    state.items.forEach(function (item, i) {
      var li = el('li', 'kw-item');
      var text = el('div');
      var name = el('b', null, item.keyword);
      text.appendChild(name);
      text.appendChild(el('span', 'kw-intent', LABELS[item.intent] || item.intent));
      if (RECIPE_SITE) {
        text.appendChild(pageChip(function () { return item.page || 'recipe'; }, function (v) { item.page = v; item.pageReason = 'Set by you'; }, item.pageReason));
      }
      if (item.reason) text.appendChild(el('div', 'kw-why', item.reason));
      var rm = el('button', 'ns-btn small', 'Remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + item.keyword);
      rm.onclick = function () { state.items.splice(i, 1); render(); };
      li.appendChild(text); li.appendChild(rm); list.appendChild(li);
    });
    var pp = $('kw-pillar-page');
    pp.hidden = !RECIPE_SITE;
    pp.textContent = '';
    if (RECIPE_SITE) {
      pp.appendChild(el('span', 'kw-pillar-label', 'The pillar “' + state.pillar + '” is'));
      pp.appendChild(pageChip(function () { return state.pillarPage; }, function (v) { state.pillarPage = v; state.pillarReason = 'Set by you'; },
        state.pillarReason || (state.pillarPage === 'recipe' ? 'one dish: its recipe goes near the end' : 'a broad topic: no single recipe')));
    }
    $('kw-own-add').disabled = state.items.length >= MAX;
    $('kw-save').disabled = state.items.length === 0;

    var d = $('kw-dropped');
    d.hidden = !state.dropped.length;
    $('kw-dropped-title').textContent = 'Left out (' + state.dropped.length + ') and why';
    var dl = $('kw-dropped-list'); dl.textContent = '';
    state.dropped.forEach(function (x) {
      var li = el('li'); li.appendChild(el('span', null, x.keyword)); li.appendChild(el('span', null, x.reason)); dl.appendChild(li);
    });
  }

  function busy(button, on, label) {
    button.disabled = on;
    button.classList.toggle('busy', on);
    if (label) button.textContent = label;
  }

  $('kw-find').onsubmit = function (e) {
    e.preventDefault();
    var pillar = $('kw-pillar').value.trim();
    $('kw-error').textContent = '';
    $('kw-status').textContent = 'Reading the website, asking Google, then the AI…';
    busy($('kw-go'), true, 'Searching…');
    post('/new-website/keywords/find', { pillar: pillar }).then(function (r) {
      $('kw-status').textContent = '';
      busy($('kw-go'), false, 'Find sub-keywords');
      if (!r.ok) { $('kw-error').textContent = r.error; $('kw-result').hidden = true; return; }
      state = { pillar: pillar, pillarPage: r.pillarPage || 'recipe', pillarReason: r.pillarPageReason || '', items: r.kept, dropped: r.dropped };
      $('kw-source').textContent = 'Picked from ' + r.searches + ' real Google searches. Remove any you do not want.';
      render();
    }).catch(function () {
      $('kw-status').textContent = '';
      busy($('kw-go'), false, 'Find sub-keywords');
      $('kw-error').textContent = 'The search did not finish. Check your connection and try again.';
    });
  };

  function addOwn() {
    var keyword = $('kw-own').value.trim();
    $('kw-own-error').textContent = '';
    if (!keyword) { $('kw-own-error').textContent = 'Type a keyword.'; return; }
    busy($('kw-own-add'), true, 'Checking…');
    post('/new-website/keywords/check', {
      pillar: state.pillar, keyword: keyword,
      others: JSON.stringify(state.items.map(function (i) { return i.keyword; }))
    }).then(function (r) {
      busy($('kw-own-add'), false, 'Add');
      if (!r.ok) { $('kw-own-error').textContent = r.error; return; }
      state.items.push({ keyword: r.keyword, intent: 'yours', reason: '', page: RECIPE_SITE ? 'recipe' : 'article', pageReason: '' });
      $('kw-own').value = '';
      render();
    }).catch(function () { busy($('kw-own-add'), false, 'Add'); $('kw-own-error').textContent = 'Could not check it. Try again.'; });
  }
  $('kw-own-add').onclick = addOwn;
  $('kw-own').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addOwn(); } });

  $('kw-save').onclick = function () {
    $('kw-save-error').textContent = '';
    busy($('kw-save'), true, 'Saving…');
    post('/new-website/keywords/save', { pillar: state.pillar, pillarPage: state.pillarPage, items: JSON.stringify(state.items) }).then(function (r) {
      if (r.ok) { location.href = r.redirect; return; }
      busy($('kw-save'), false, 'Save and continue');
      $('kw-save-error').textContent = r.error;
    }).catch(function () { busy($('kw-save'), false, 'Save and continue'); $('kw-save-error').textContent = 'Could not save. Try again.'; });
  };
})();
</script>`;

/* -- The Keywords page: a card per website ------------------------------------ */

export const OVERVIEW_CSS = `
.ko-cards { display: grid; gap: 16px; }
.ko-site { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); }
.ko-head { width: 100%; display: flex; align-items: center; gap: 16px; padding: 18px 24px; background: none; border: 0; color: var(--ink);
  font: inherit; text-align: left; cursor: pointer; border-radius: var(--r-card); }
.ko-head:hover .ko-name { text-decoration: underline; }
.ko-title { flex: 1; min-width: 0; }
.ko-name { display: block; font: 700 20px/1.25 var(--display); letter-spacing: -.015em; }
.ko-domain { display: block; margin-top: 2px; color: var(--soft); font: 13px var(--mono); }
.ko-stats { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--soft); font-size: 14px; }
.ko-stats b { color: var(--ink); font-variant-numeric: tabular-nums; }
.ko-chev { width: 20px; height: 20px; flex: none; color: var(--soft); transition: transform .2s ease; }
.ko-site.open .ko-chev { transform: rotate(180deg); }
.ko-body { display: none; border-top: 1px solid var(--line); padding: 4px 24px 18px; overflow-x: auto; }
.ko-site.open .ko-body { display: block; }
.ko-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.ko-table th { text-align: left; font-weight: 600; color: var(--faint); font-size: 13px; padding: 12px 10px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.ko-table td { padding: 12px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.ko-table tr:last-child td { border-bottom: 0; }
/* Every other keyword a shade darker, so each line is easy to follow. */
.ko-table tbody tr:nth-child(even) td { background: var(--raised); }
.ko-recheck { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 14px 0 0; color: var(--soft); font-size: 14px; }
.ko-recheck form { margin: 0; }
.ko-table td.ko-kw a { font-weight: 600; color: var(--ink); text-decoration: none; }
.ko-table td.ko-kw a:hover { color: var(--accent-text); text-decoration: underline; }
.ko-subs { color: var(--soft); max-width: 46ch; }
.ko-sub { display: inline-flex; align-items: center; gap: 2px; margin: 0 8px 2px 0; }
.ko-sub form { display: inline; margin: 0; }
.ko-x { border: 0; background: none; padding: 0 4px; color: var(--faint); font: inherit; line-height: 1; cursor: pointer; border-radius: 4px; }
.ko-x:hover { color: var(--bad); background: var(--bad-tint); }
.ko-from { display: block; color: var(--faint); font-size: 12px; margin-top: 2px; }
.ko-niche { white-space: nowrap; }
.ko-niche small { color: var(--faint); }
.ko-progress { white-space: nowrap; color: var(--soft); }
.ko-progress b { color: var(--ink); font-variant-numeric: tabular-nums; }
.ko-images b.made { color: var(--good); }
.ko-images b.failed { color: var(--bad); }
.ko-table form { margin: 0; }
.ko-none { color: var(--faint); padding: 16px 0 4px; margin: 0; }
.ko-err { color: var(--bad); font-size: 13px; display: block; margin-top: 2px; }
.ko-empty { border: 1px dashed var(--line-strong); border-radius: var(--r-card); padding: 56px 32px; text-align: center; }
.ko-empty h2 { font-size: 22px; margin-bottom: 8px; }
.ko-empty p { color: var(--soft); margin: 0 auto 24px; max-width: 46ch; }
.ch-option { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border: 1px solid var(--idle-line); border-radius: var(--r-ctl); cursor: pointer; background: var(--idle); color: var(--idle-ink); }
.ch-option:hover { background: var(--idle-hover); }
.ch-option input { margin-top: 3px; width: 16px; height: 16px; }
.ch-option b { display: block; font-weight: 600; }
.ch-option span { color: var(--idle-ink); font-size: 13px; }
.ch-option:has(input:checked) { background: var(--accent-tint); border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); color: var(--ink); }
.ch-option:has(input:checked) span { color: var(--soft); }
.ki-format { margin: 0 0 20px; padding: 14px 16px; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-ctl); font-size: 14px; }
.ki-format pre { margin: 8px 0 0; font: 13px/1.6 var(--mono); white-space: pre-wrap; color: var(--ink); }
.ki-format > b { display: block; margin-bottom: 10px; font-size: 15px; }
.ki-table { overflow-x: auto; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--surface); }
.ki-table table { width: 100%; border-collapse: collapse; font-size: 14px; }
.ki-table th, .ki-table td { padding: 9px 12px; text-align: left; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); vertical-align: top; }
.ki-table th:last-child, .ki-table td:last-child { border-right: 0; }
.ki-table tbody tr:last-child td { border-bottom: 0; }
.ki-table th { background: var(--raised); font-weight: 600; white-space: nowrap; }
.ki-table th small { display: block; font-weight: 500; font-size: 12px; color: var(--faint); }
.ki-table em { color: var(--faint); font-style: normal; }
.ki-notes { margin: 12px 0; padding-left: 18px; color: var(--soft); }
.ki-notes li { margin: 4px 0; }
.ki-raw { margin: 0 0 12px; }
.ki-raw summary { cursor: pointer; font-weight: 600; color: var(--idle-ink); }
.ki-file { display: block; margin: 0 0 12px; font: 14px var(--body); }
.ki-paste { width: 100%; min-height: 180px; padding: 12px 14px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--surface);
  color: var(--ink); font: 13px/1.6 var(--mono); resize: vertical; }
.ki-sum { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.ki-table td.ki-line { color: var(--faint); font-variant-numeric: tabular-nums; }
.ki-table tr.bad td { background: var(--bad-tint); }
.ki-problem { display: block; color: var(--bad); font-weight: 600; font-size: 13px; }
.ki-note { display: block; color: var(--faint); font-size: 13px; }
@media (max-width: 720px) { .ko-head { flex-wrap: wrap; } .ko-stats { width: 100%; } }
`;

export interface OverviewSite {
  site: NewWebsiteRow;
  plans: KeywordPlan[];
  /** What Autopilot does next, when it is on. */
  autopilot?: string;
}

export const CHEV = '<svg class="ko-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/** One plan's progress, from its keywords. */
const planProgress = (s: PlanStats | undefined): Html =>
  s
    ? html`SEO <b>${String(s.seoDone)}/${String(s.total)}</b> · Art <b>${String(s.articles)}/${String(s.total)}</b> · Pub <b>${String(s.published)}/${String(s.total)}</b>
        <span class="ko-images">· IMG <b class="made" title="Pictures made">${String(s.imagesMade)}</b>${s.imagesFailed
          ? html` <b class="failed" title="Pictures failed">${String(s.imagesFailed)} failed</b>`
          : raw('')}</span>`
    : html`Waiting to start`;

/** A plan's sub-keywords, each with its own delete button. */
const subList = (p: KeywordPlan): Html =>
  html`${p.items.map(
    (i) => html`<span class="ko-sub">${i.keyword}<form method="post" action="/new-website/keywords/${String(p.id)}/sub/delete" data-name="${i.keyword}"
        onsubmit="return confirm('Delete ' + this.dataset.name + '?')"><input type="hidden" name="keyword" value="${i.keyword}"><button class="ko-x" title="Delete" aria-label="Delete ${i.keyword}">×</button></form></span>`,
  )}`;

/** The Keywords page: one card per website, each opening on a table of its keyword plans. */
export function keywordsOverview(sites: OverviewSite[], stats: Map<number, PlanStats>, skipped: { plan_id: number; keyword: string; skip_reason: string }[] = []): Html {
  const ready = sites.length > 0;
  return html`
    <style>${raw(CSS)}${raw(OVERVIEW_CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Keywords</h1>
        <p class="ns-lede">Your keywords, grouped by website. Each main keyword becomes a set of articles. Open one to follow every article step by step, from writing to publishing, and to fix anything that stopped.</p>
      </div>
      ${ready ? html`<a class="ns-btn primary" href="/new-website/keywords/add">Add keywords</a>` : raw('')}
    </div>
    ${!ready
      ? html`<div class="ko-empty"><h2>Add a website first</h2><p>Keywords are planned for a website, and published there.</p><a class="ns-btn primary" href="/new-website/add">Add website</a></div>`
      : html`<div class="ko-cards">${sites.map(({ site, plans, autopilot }) => {
          const subs = plans.reduce((n, p) => n + p.items.length, 0);
          const published = plans.reduce((n, p) => n + (stats.get(p.id)?.published ?? 0), 0);
          const findingCount = plans.filter((p) => p.subs_status === 'finding').length;
          const short = plans.filter((p) => p.subs_status !== 'finding' && p.items.length < MAX_SUBS).length;
          return html`<article class="ko-site ${sites.length === 1 ? 'open' : ''}" id="website-${String(site.id)}" data-id="${String(site.id)}">
            <button type="button" class="ko-head" aria-expanded="${sites.length === 1 ? 'true' : 'false'}">
              <span class="ko-title"><span class="ko-name">${site.name}</span><span class="ko-domain">${site.domain}</span></span>
              <span class="ko-stats">
                <span><b>${String(plans.length)}</b> main keyword${plans.length === 1 ? '' : 's'}</span>
                <span><b>${String(subs)}</b> sub-keyword${subs === 1 ? '' : 's'}</span>
                <span><b>${String(published)}</b> published</span>
                ${autopilot ? html`<span class="ns-badge ${autopilot.startsWith('No keywords') ? 'bad' : 'ok'}">${autopilot}</span>` : raw('')}
                ${findingCount ? html`<span class="ns-badge busy">Finding sub-keywords for ${String(findingCount)}</span>` : raw('')}
              </span>
              ${raw(CHEV)}
            </button>
            <div class="ko-body">
              ${plans.length
                ? html`<table class="ko-table">
                    <thead><tr><th>Main keyword</th><th>Sub-keywords</th><th>Niche</th><th>Progress</th><th></th></tr></thead>
                    <tbody>${plans.map(
                      (p) => html`<tr>
                        <td class="ko-kw"><a href="${planHref(p.id, 'seo')}">${p.pillar}</a></td>
                        <td class="ko-subs">${p.subs_status === 'finding'
                          ? p.items.length
                            ? html`${subList(p)} <span class="ns-badge busy">Finding more</span>`
                            : html`<span class="ns-badge busy">Being found</span>`
                          : p.items.length
                            ? subList(p)
                            : html`None${p.subs_status === 'failed' ? html`<span class="ko-err">Not found: ${p.subs_error.replace(/[.\s]+$/, '')}. The main keyword goes on alone.</span>` : raw('')}`}
                          ${skipped.filter((k) => k.plan_id === p.id).map((k) => html`<span class="ko-err">Skipped “${k.keyword}”: ${k.skip_reason}</span>`)}</td>
                        <td class="ko-niche">${p.niche ? p.niche : html`${site.niche} <small>(website)</small>`}</td>
                        <td class="ko-progress">${planProgress(stats.get(p.id))}</td>
                        <td><form method="post" action="/new-website/keywords/${String(p.id)}/delete" data-name="${p.pillar}"
                              onsubmit="return confirm('Delete the plan for ' + this.dataset.name + '?')"><button class="ns-btn danger small">Delete</button></form></td>
                      </tr>`,
                    )}</tbody>
                  </table>`
                : html`<p class="ko-none">No keywords for this website yet.</p>`}
              ${short
                ? html`<div class="ko-recheck"><span>${String(short)} main keyword${short === 1 ? ' has' : 's have'} fewer than ${String(MAX_SUBS)} sub-keywords.</span>
                    <form method="post" action="/new-website/keywords/website/${String(site.id)}/recheck-subs"><button class="ns-btn small">Recheck sub-keywords</button></form></div>`
                : raw('')}
            </div>
          </article>`;
        })}</div>`}
    ${raw(OVERVIEW_SCRIPT)}`;
}

/** Opens and closes the website cards; each remembers being open, in this browser. */
const OVERVIEW_SCRIPT = `<script>
(function () {
  document.querySelectorAll('.ko-site').forEach(function (card) {
    var key = 'kw-site-open-' + card.getAttribute('data-id');
    var head = card.querySelector('.ko-head');
    function set(open) { card.classList.toggle('open', open); head.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    var saved = null;
    try { saved = localStorage.getItem(key); } catch (e) {}
    if (saved !== null) set(saved === '1');
    if (location.hash === '#' + card.id) set(true);
    head.addEventListener('click', function () {
      var open = !card.classList.contains('open');
      set(open);
      try { localStorage.setItem(key, open ? '1' : '0'); } catch (e) {}
    });
  });
})();
</script>`;

/* -- Add keywords: one by hand, or a CSV file ---------------------------------- */

const IMPORT_STEPS = ['How', 'The file', 'Check'];
const ONE_STEPS = ['How', 'Website and keyword'];

function addWizard(step: number, title: string, body: Html, foot: Html, error = '', steps = IMPORT_STEPS, wide = step === 2): Html {
  return html`
    <style>${raw(WIZARD_CSS)}${raw(CSS)}${raw(OVERVIEW_CSS)}</style>
    <div class="wz ${wide ? 'kw-wz' : ''}">
      <div class="wz-head">
        <h1>${title}</h1>
        <p class="wz-id">Each main keyword is planned for its website and published there.</p>
        <div class="wz-bar" style="grid-template-columns:repeat(${steps.length},1fr)">${steps.map((_, i) => html`<i class="${i <= step ? 'on' : ''}"></i>`)}</div>
        <div class="wz-stepname">Step ${step + 1} of ${steps.length}: ${steps[step]}</div>
      </div>
      <div class="wz-body">${error ? html`<p class="kw-seo-problems" role="alert" style="margin:0 0 16px">${error}</p>` : raw('')}${body}</div>
      <div class="wz-foot">${foot}</div>
    </div>`;
}

export function addKeywordsStep(): Html {
  return addWizard(
    0,
    'Add keywords',
    html`<form id="ki-form" method="post" action="/new-website/keywords/add">
      <h2>How</h2>
      <p>Add one main keyword and pick its sub-keywords yourself, or bring many main keywords at once in a CSV file.</p>
      <div class="ch-pick" style="display:grid;gap:10px;margin-bottom:20px">
        <label class="ch-option"><input type="radio" name="how" value="one" checked />
          <div><b>One main keyword</b><span>For one website. The platform finds its sub-keywords from Google and you choose which to keep.</span></div></label>
        <label class="ch-option"><input type="radio" name="how" value="csv" />
          <div><b>A CSV file</b><span>Many main keywords, each with its target website. Niche and sub-keywords are optional: the platform keeps yours and finds more like them, up to 6.</span></div></label>
      </div>
    </form>`,
    html`<a class="ns-btn quiet" href="/new-website/keywords">Cancel</a><button class="ns-btn primary" form="ki-form">Next</button>`,
  );
}

export function importFileStep(websites: NewWebsiteRow[], csv = '', error = ''): Html {
  const domains = websites.length ? websites.slice(0, 2).map((w) => w.domain) : ['example.com'];
  const rows: [string, string, string, string][] = [
    ['strawberry cake', domains[0]!, '', ''],
    ['banana bread', domains[1] ?? domains[0]!, 'Baking', 'banana bread muffins; vegan banana bread'],
  ];
  const cell = (v: string) => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const example = ['Main Keyword,Target Website,Niche,Subkeywords', ...rows.map((r) => r.map(cell).join(','))].join('\n');
  return addWizard(
    1,
    'Import keywords',
    html`<form id="ki-form" method="post" action="/new-website/keywords/import/check">
      <h2>The file</h2>
      <p>A CSV file with a first line naming the columns. <b>Main Keyword</b> and <b>Target Website</b> are needed; <b>Niche</b> and <b>Subkeywords</b> are optional. Put several sub-keywords in one cell, separated by <code>;</code>. Yours are always kept; with fewer than 6, the platform adds similar ones from Google until there are 6.</p>
      <div class="ki-format">
        <b>How the file looks in a spreadsheet</b>
        <div class="ki-table"><table>
          <thead><tr><th>Main Keyword<small>needed</small></th><th>Target Website<small>needed</small></th><th>Niche<small>optional</small></th><th>Subkeywords<small>optional</small></th></tr></thead>
          <tbody>${rows.map((r) => html`<tr>${r.map((v) => html`<td>${v ? v : html`<em>empty</em>`}</td>`)}</tr>`)}</tbody>
        </table></div>
        <ul class="ki-notes">
          <li><b>Row 1</b> has only what is needed. The platform finds the sub-keywords itself and uses the website’s own niche.</li>
          <li><b>Row 2</b> gives a niche and two sub-keywords, separated by <code>;</code> in one cell. Both are kept, and the platform adds up to 4 more like them.</li>
          <li><b>Target Website</b> is the address of one of your websites, as shown on the Websites page.</li>
        </ul>
        <details class="ki-raw"><summary>The same, as text in the CSV file</summary><pre>${example}</pre></details>
        <a class="ns-btn small" href="/new-website/keywords/import/template.csv" download="keywords-template.csv">Download the template</a></div>
      <input class="ki-file" type="file" accept=".csv,text/csv,text/plain" id="ki-file" aria-label="CSV file" />
      <label for="ki-csv" class="kw-hint" style="display:block;margin:0 0 6px">Or paste the CSV here:</label>
      <textarea id="ki-csv" name="csv" class="ki-paste" spellcheck="false">${csv}</textarea>
      <script>
        (function () {
          var file = document.getElementById('ki-file'), box = document.getElementById('ki-csv');
          file.addEventListener('change', function () {
            var f = file.files && file.files[0];
            if (!f) return;
            var reader = new FileReader();
            reader.onload = function () { box.value = String(reader.result || ''); };
            reader.readAsText(f);
          });
        })();
      </script>
    </form>`,
    html`<a class="ns-btn quiet" href="/new-website/keywords/add">Previous</a><button class="ns-btn primary" form="ki-form">Next: check</button>`,
    error,
  );
}

/** Every row of the file, checked, before anything is saved. */
export function importCheckStep(check: ImportCheck, draft: string): Html {
  const good = check.rows.filter((r) => !r.errors.length);
  const bad = check.rows.length - good.length;
  const finding = good.filter((r) => !r.subs.length).length;
  return addWizard(
    2,
    'Import keywords',
    html`<h2>Check</h2>
      <p>Every row was checked: the two needed columns, the website is one of yours, no repeats in the file, and nothing the website already has. Nothing is saved yet.</p>
      <div class="ki-sum">
        <span class="ns-badge ok">${String(good.length)} ready</span>
        ${bad ? html`<span class="ns-badge bad">${String(bad)} with problems: not imported</span>` : raw('')}
        ${finding ? html`<span class="ns-badge busy">${String(finding)} without sub-keywords: the platform finds them</span>` : raw('')}
      </div>
      ${bad ? html`<p class="kw-hint" style="margin:0 0 12px">Fix the rows in red in your file and check it again, or import the ready rows now.</p>` : raw('')}
      <div style="overflow-x:auto"><table class="ko-table ki-table">
        <thead><tr><th>Line</th><th>Main keyword</th><th>Website</th><th>Niche</th><th>Sub-keywords</th><th>Check</th></tr></thead>
        <tbody>${check.rows.map(
          (r) => html`<tr class="${r.errors.length ? 'bad' : ''}">
            <td class="ki-line">${String(r.line)}</td>
            <td><b>${r.keyword || '—'}</b></td>
            <td>${r.websiteName ? html`${r.websiteName}<span class="ko-from">${r.domain}</span>` : r.domain || '—'}</td>
            <td>${r.niche || html`<small style="color:var(--faint)">the website’s</small>`}</td>
            <td class="ko-subs">${r.subs.length ? r.subs.join(', ') : html`<small style="color:var(--faint)">found by the platform</small>`}</td>
            <td>${r.errors.length ? r.errors.map((e) => html`<span class="ki-problem">${e}</span>`) : html`<span class="ns-badge ok">Ready</span>`}
              ${r.notes.map((n) => html`<span class="ki-note">${n}</span>`)}</td>
          </tr>`,
        )}</tbody>
      </table></div>
      <form id="ki-form" method="post" action="/new-website/keywords/import/save"><input type="hidden" name="draft" value="${draft}" /></form>`,
    html`<a class="ns-btn quiet" href="/new-website/keywords/import">Previous</a>
      ${good.length
        ? html`<button class="ns-btn primary" form="ki-form">Import ${String(good.length)} keyword${good.length === 1 ? '' : 's'}</button>`
        : html`<button class="ns-btn primary" disabled>Nothing to import</button>`}`,
  );
}
