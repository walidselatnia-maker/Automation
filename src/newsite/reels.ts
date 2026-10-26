import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { ImageClient } from '../integrations/images.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { pictureMediaUrl } from '../core/media-links.js';
import { promptsDirectory } from '../pipeline/prompts.js';
import type { Settings } from '../settings.js';
import { PLATFORMS, REEL_PLATFORMS, channelTakes, takesReels, websiteChannels } from './channels.js';
import { withGoogleAccount } from './google-accounts.js';
import { flowProjectFor, isMainSlot, isStepSlot, listPictures } from './pictures.js';
import { getKeywordPlan, getNewWebsite, type NewWebsiteRow } from './repo.js';
import { getSeoRow, type SeoRow } from './seo.js';
import { parseRecipe } from './recipe.js';
import { correctUntilRight } from './rounds.js';

/**
 * The reel of a published article: ONE 10-second vertical video, made once in
 * Google Flow from one prompt and the article's own pictures, then shared on
 * every channel that takes reels (reel-shares.ts). It is never made again
 * just because another platform wants it. The AI writes the prompt from the
 * article by the reel rules (prompts/reel-rules/reel.md, or as changed on the
 * dashboard): the finished result and the hook line in the first two seconds,
 * then the stages of making it, then the closing line. One prompt, one video:
 * no storyboard, no editing.
 *
 * Reels made before this were made one per platform; they stay as they are,
 * each one reel item that can be shared anywhere.
 */

const log = createLogger('newsite-reels');

export { REEL_PLATFORMS };

/** A reel made for every platform (older reels carry the one platform they were made for). */
export const ALL_PLATFORMS = 'all';

/** Flow takes at most this many photos in one request. */
const MAX_REFERENCES = 3;
const FAILED = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);

export interface ReelRow {
  id: number;
  seo_id: number;
  platform: string;
  prompt: string;
  status: 'pending' | 'making' | 'done' | 'failed';
  job_id: string;
  file: string;
  error: string;
  hook: string;
  closing: string;
  created_at: string;
  done_at: string | null;
}

export const reelDir = (dataDir = resolveDataDir()): string => join(dataDir, 'newsite-reels');
export const getReel = (id: number): ReelRow | undefined => get<ReelRow>('SELECT * FROM newsite_reels WHERE id = ?', id);
export const listPlanReels = (planId: number): ReelRow[] =>
  all<ReelRow>(
    `SELECT r.* FROM newsite_reels r JOIN keyword_seo s ON s.id = r.seo_id WHERE s.plan_id = ? ORDER BY s.position, r.id`,
    planId,
  );

/** The platforms an article's website shares on that take reels, for people ("Facebook and Pinterest"). */
function reelPlatformsLabel(websiteId: number): string {
  const own = new Set(websiteChannels(websiteId).filter((c) => c.post_reel).map((c) => c.platform));
  const names = REEL_PLATFORMS.filter((p) => own.has(p)).map((p) => PLATFORMS.find((x) => x.key === p)?.label ?? p);
  if (!names.length) return 'short-video platforms';
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Queue the article's one reel, unless it has one already. By itself (once
 * published) only when its website sends reels to one of its channels; `always`
 * is the Reels page's Make reel button. Returns 1 when one was queued.
 */
export function createReels(seoId: number, always = false): number {
  const row = getSeoRow(seoId);
  const plan = row ? getKeywordPlan(row.plan_id) : undefined;
  if (!row || !plan || row.post_status !== 'published') return 0;
  if (!always && !websiteChannels(plan.website_id).some((c) => c.post_reel && takesReels(c.platform) && channelTakes(c, row.post_category))) return 0;
  if (get('SELECT id FROM newsite_reels WHERE seo_id = ? LIMIT 1', seoId)) return 0;
  return Number(run(`INSERT OR IGNORE INTO newsite_reels (seo_id, platform) VALUES (?, ?)`, seoId, ALL_PLATFORMS).changes ?? 0);
}

/** Make a reel again from its prompt file (a failed one, or one you want redone). */
export function remakeReel(id: number): boolean {
  const reel = getReel(id);
  if (!reel || reel.status === 'making') return false;
  run(`UPDATE newsite_reels SET status = 'pending', job_id = '', error = '', prompt = '' WHERE id = ?`, id);
  return true;
}

export interface ReelDeps {
  settings: Settings;
  encryptionKey: Buffer;
  dataDir?: string;
  /** Flow, through the old dashboard's image service. Tests pass their own. */
  flow?: {
    submitVideo(input: { prompt: string; referenceUrls: string[]; projectId?: string }): Promise<string>;
    poll(jobId: string): Promise<{ status?: string; image_url?: string; error?: string }>;
  };
  download?: (url: string) => Promise<Buffer>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The AI that writes the video prompt. */
  ask?: (name: string, vars: Record<string, unknown>) => Promise<string>;
  /** A reel's video is made: it is shared on its channels. Unset, the listener set by onReelMade runs. */
  onDone?: (reelId: number) => void;
}

const flowOf = (settings: Settings) =>
  new ImageClient({
    baseUrl: settings.get('image_base_url'),
    apiKey: settings.get('image_api_key'),
    pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
    maxAttempts: settings.getNumber('image_poll_max_attempts'),
  });

const defaultDownload = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`the video could not be downloaded (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * The photos the video is made from: the finished result first (the hook
 * shows it), then up to two of the article's step pictures, in order (the
 * stages). Each with what it shows, for the prompt writer.
 */
function references(seoId: number, deps: ReelDeps): { urls: string[]; described: string } {
  const base = deps.settings.get('public_base_url').trim();
  if (!base) {
    throw new Error('This platform has no public address yet, so Flow cannot fetch the article pictures. Open the dashboard once at its https address, or set it in Platform settings → Images.');
  }
  const ready = listPictures(seoId).filter((p) => p.status === 'done' && p.file);
  const main = ready.filter((p) => isMainSlot(p.slot));
  const steps = ready.filter((p) => isStepSlot(p.slot)).sort((a, b) => a.position - b.position);
  if (!main.length) throw new Error('The article has no pictures to make the reel from.');
  const finished = main.find((p) => p.slot === 'feature') ?? main[0]!;
  const stepPicks = steps.length > 2 ? [steps[0]!, steps[Math.floor(steps.length / 2)]!] : steps;
  const picked = [finished, ...stepPicks, ...main.filter((p) => p !== finished)].slice(0, MAX_REFERENCES);
  const days = Number(deps.settings.get('reel_media_link_days')) || 7;
  return {
    urls: picked.map((p) => pictureMediaUrl(base, p.id, (p.file.split('.').pop() ?? 'png').toLowerCase(), days, deps.encryptionKey, (deps.now ?? Date.now)())),
    described: picked
      .map((p, i) => `${i + 1}. ${p === finished ? 'The finished result' : isStepSlot(p.slot) ? 'A step of making it' : 'Another view of the result'}: ${p.alt || p.prompt.slice(0, 200)}`)
      .join('\n'),
  };
}

/** Whoever shares a reel once it is made (the Sharing routes set it). */
let madeListener: ((reelId: number) => void) | null = null;
export const onReelMade = (listener: ((reelId: number) => void) | null): void => {
  madeListener = listener;
};

/** The one set of reel rules: its file. */
export const defaultReelRules = (): string => {
  try {
    return readFileSync(join(promptsDirectory(), 'reel-rules', 'reel.md'), 'utf8');
  } catch {
    return '';
  }
};
/** Where rules changed on the dashboard are kept. */
export const REEL_RULES_KEY = 'newsite_reel_rules';
/** The reel rules: as changed on the dashboard, or its file. */
export const reelRules = (settings: Settings): string => (settings.get(REEL_RULES_KEY).trim() ? settings.get(REEL_RULES_KEY) : defaultReelRules());

/** The placeholder reel rules and reel captions may use for the website's address. */
export const DOMAIN_PLACEHOLDER = '{domain}';
/** Text with {domain} filled in with the website's address. */
export const withDomain = (text: string, domain: string): string => text.split(DOMAIN_PLACEHOLDER).join(domain);

export interface ReelScript {
  hook_line: string;
  closing_line: string;
  prompt: string;
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
/** The longest a line may be, as the rules say it ("at most 9 words"). */
const ruleMax = (rules: string, what: string, fallback: number): number =>
  Number(new RegExp(`${what}[^\\n]*?at most (\\d+) words`, 'i').exec(rules)?.[1]) || fallback;

/** What is checked before anything is spent on Flow. The website's own address (its {domain}) is the one web address allowed. */
export function checkReelScript(s: ReelScript, rules: string, domain = ''): string[] {
  const problems: string[] = [];
  const hookMax = ruleMax(rules, 'hook line', 10);
  if (!s.hook_line) problems.push('The hook_line is empty.');
  else if (words(s.hook_line) > hookMax) problems.push(`The hook_line has ${words(s.hook_line)} words; at most ${hookMax}.`);
  const closing = /closing line, word for word: "([^"]+)"/i.exec(rules)?.[1];
  if (closing && s.closing_line !== closing) problems.push(`The closing_line must be exactly: "${closing}".`);
  if (s.hook_line && !s.prompt.includes(s.hook_line)) problems.push('The prompt must contain the hook_line word for word, in double quotes, in the 0-2s shot.');
  if (s.closing_line && !s.prompt.includes(s.closing_line)) problems.push('The prompt must contain the closing_line word for word, in double quotes, in the last shot.');
  const marks = rules.match(/^- (\d+-\d+s):/gm)?.map((m) => m.slice(2, -1)) ?? [];
  const missing = marks.filter((m) => !s.prompt.includes(`${m}:`));
  if (missing.length) problems.push(`The prompt must have a line for each time mark of the rules; missing: ${missing.join(', ')}.`);
  if (/slow[- ]?motion|slowly|cinematic|masterpiece|\b8k\b|hyper-detailed/i.test(s.prompt.replace(/never[^.]*\./gi, ''))) {
    problems.push('The prompt uses a banned word (slow motion, slowly, cinematic, masterpiece, 8k, hyper-detailed).');
  }
  const bare = domain ? s.prompt.split(domain).join('') : s.prompt;
  if (/https?:\/\/|www\.|\.com\b/i.test(bare)) problems.push('The prompt must have no link or web address.');
  if (s.prompt.length < 400) problems.push(`The prompt is ${s.prompt.length} characters; write every shot fully (at least 400).`);
  if (s.prompt.length > 4000) problems.push(`The prompt is ${s.prompt.length} characters; at most 4000.`);
  return problems;
}

/** The article's steps and main things: from its recipe when it has one, else its headings. */
function articleParts(row: SeoRow): { steps: string; things: string } {
  const recipe = row.recipe_json ? parseRecipe(row.recipe_json) : null;
  if (recipe?.steps.length) {
    return {
      steps: recipe.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n'),
      things: recipe.ingredients.flatMap((g) => g.items).map((i) => `- ${i}`).join('\n') || '- (none listed)',
    };
  }
  const headings = row.article_md.split('\n').filter((l) => /^#{2,3}\s/.test(l)).map((l, i) => `${i + 1}. ${l.replace(/^#+\s*/, '')}`);
  return { steps: headings.join('\n') || '- (no steps)', things: '- (see the steps)' };
}

/** The AI writes the one video prompt from the article, by the reel rules. */
async function writeScript(reel: ReelRow, row: SeoRow, site: NewWebsiteRow, described: string, deps: ReelDeps): Promise<ReelScript> {
  const rules = withDomain(reelRules(deps.settings), site.domain);
  if (!rules.trim()) throw new Error('There are no reel rules (prompts/reel-rules/reel.md).');
  if (!deps.ask) throw new Error('No AI to write the reel prompt.');
  const ask = deps.ask;
  const label = reelPlatformsLabel(site.id);
  const parts = articleParts(row);
  const out = await correctUntilRight<ReelScript>({
    ask: (corrections) =>
      ask('newsite-reel-prompt', {
        language: site.language,
        label,
        reelRules: rules,
        title: row.title || row.keyword,
        keyword: row.keyword,
        niche: site.niche,
        nicheContext: site.niche_context || '(none)',
        steps: parts.steps,
        things: parts.things,
        articleOutline: row.article_md.split('\n').filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '- ')).join('\n') || '- (no headings)',
        references: described,
        problemsJson: corrections,
      }),
    parse: (raw) => {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      try {
        const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
        return { hook_line: s('hook_line').replace(/\s+/g, ' '), closing_line: s('closing_line').replace(/\s+/g, ' '), prompt: s('prompt') };
      } catch {
        return null;
      }
    },
    check: (s) => checkReelScript(s, rules, site.domain),
  });
  if (out.technical || !out.answer) throw new Error(`The reel prompt could not be written: ${out.problems.join(' ')}`);
  return out.answer;
}

/** Make one reel: its prompt, then Flow, then wait for the video and keep it. */
async function make(reel: ReelRow, deps: ReelDeps): Promise<void> {
  const row = getSeoRow(reel.seo_id);
  const plan = row ? getKeywordPlan(row.plan_id) : undefined;
  const site = plan ? getNewWebsite(plan.website_id) : undefined;
  if (!row || !site) throw new Error('Its article is gone.');
  const refs = references(reel.seo_id, deps);
  const script = await writeScript(reel, row, site, refs.described, deps);
  const prompt = script.prompt;
  run(`UPDATE newsite_reels SET prompt = ?, hook = ?, closing = ? WHERE id = ?`, prompt, script.hook_line, script.closing_line, reel.id);
  const flow = deps.flow ?? flowOf(deps.settings);
  const project = flowProjectFor(site.project_id, site.domain, deps.settings);
  // On the first working Google account; a limited, flagged or signed-out one hands the reel to the next.
  await withGoogleAccount(project.projectId, (projectId) => submitAndWait(reel, prompt, refs.urls, projectId, flow, deps), deps.now);
}

/** One video job on Flow, waited for and kept. */
async function submitAndWait(
  reel: ReelRow,
  prompt: string,
  referenceUrls: string[],
  projectId: string,
  flow: NonNullable<ReelDeps['flow']> | ImageClient,
  deps: ReelDeps,
): Promise<void> {
  const jobId = await flow.submitVideo({ prompt, referenceUrls, projectId });
  run(`UPDATE newsite_reels SET status = 'making', job_id = ?, error = '' WHERE id = ?`, jobId, reel.id);
  log.info(`reel ${reel.id}: video job ${jobId} from ${referenceUrls.length} picture(s)`);

  // A video takes minutes: ask every 15 seconds, for up to 20 minutes.
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < 80; i++) {
    await sleep(15_000);
    const job = await flow.poll(jobId);
    const status = (job.status ?? '').toUpperCase();
    if (status === 'COMPLETED' && job.image_url) {
      const data = await (deps.download ?? defaultDownload)(job.image_url);
      const dir = reelDir(deps.dataDir);
      mkdirSync(dir, { recursive: true });
      const file = `reel-${reel.id}.mp4`;
      writeFileSync(join(dir, file), data);
      run(`UPDATE newsite_reels SET status = 'done', file = ?, error = '', done_at = datetime('now') WHERE id = ?`, file, reel.id);
      log.info(`reel ${reel.id}: video made`);
      (deps.onDone ?? madeListener)?.(reel.id);
      return;
    }
    if (FAILED.has(status)) throw new Error(`Flow could not make the video: ${job.error ?? status}`);
  }
  throw new Error('Flow took more than 20 minutes to make the video.');
}

let running: Promise<void> | null = null;

/** Make every waiting reel, one at a time. Calling it while it runs does nothing extra. */
/** After Google answers UNUSUAL_ACTIVITY, how long reels wait before the next one goes to Flow. */
export const FLOW_PAUSE_KEY = 'newsite_reels_paused_until';
export const FLOW_PAUSE_MS = 60 * 60_000;

export function kickReels(deps: ReelDeps): Promise<void> {
  if (running) return running;
  running = (async () => {
    // Let `running` be set before anything below can finish and clear it.
    await Promise.resolve();
    try {
      for (;;) {
        // Google flagged the account: nothing goes to Flow until the pause is over.
        const pausedUntil = Number(deps.settings.get(FLOW_PAUSE_KEY)) || 0;
        const now = (deps.now ?? Date.now)();
        if (pausedUntil > now) {
          log.warn(`reels paused until ${new Date(pausedUntil).toISOString()} after Google flagged unusual activity`);
          const wake = setTimeout(() => void kickReels(deps), pausedUntil - now + 1000);
          wake.unref?.();
          return;
        }
        const next = get<ReelRow>(`SELECT * FROM newsite_reels WHERE status = 'pending' ORDER BY id LIMIT 1`);
        if (!next) return;
        try {
          await make(next, deps);
        } catch (err) {
          const message = errorMessage(err);
          if (/UNUSUAL_ACTIVITY|unusual activity/i.test(message)) {
            // Never retried at once: retries are what makes Google's flag worse.
            // Kept in the settings, so a restart does not end the pause.
            deps.settings.set(FLOW_PAUSE_KEY, String(now + FLOW_PAUSE_MS));
            run(
              `UPDATE newsite_reels SET status = 'failed', error = ? WHERE id = ?`,
              `${message} Google flagged unusual activity on the account, so reels are paused for ${FLOW_PAUSE_MS / 60_000} minutes. Try again after that, one reel at a time.`,
              next.id,
            );
          } else {
            run(`UPDATE newsite_reels SET status = 'failed', error = ? WHERE id = ?`, message, next.id);
          }
          log.warn(`reel ${next.id} failed: ${message}`);
        }
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

/** A restart leaves a reel half made: it starts again. */
export function resetInterruptedReels(): void {
  run(`UPDATE newsite_reels SET status = 'pending', job_id = '' WHERE status = 'making'`);
}
