import { all, run } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { requeueArticle, requeueImages, requeueRecipe, requeueSeo, requeueSkeleton, type SeoRow } from './seo.js';

/**
 * Automatic retries for the AI steps (SEO, recipe, skeleton, article, image
 * prompts), from the platform's retry settings: "Retry failed runs
 * automatically", how many times, and the wait in between.
 *
 * Each step already gets three rounds with its problems sent back to the AI.
 * When it still fails (or the AI could not be reached), it is tried again
 * after the wait, from where it stopped, up to the set number of times per
 * step; then it stays failed and waits for its "again" button.
 */

const log = createLogger('newsite-retries');

const STEPS = [
  { name: 'seo', status: 'status', requeue: requeueSeo },
  { name: 'recipe', status: 'recipe_status', requeue: requeueRecipe },
  { name: 'skeleton', status: 'skeleton_status', requeue: requeueSkeleton },
  { name: 'article', status: 'article_status', requeue: requeueArticle },
  { name: 'images', status: 'images_status', requeue: requeueImages },
] as const;

export type StepName = (typeof STEPS)[number]['name'];

type RetryRow = SeoRow & { retries_json: string; retry_step: string; retry_at: number | null };

const failedStep = (row: RetryRow) => STEPS.find((s) => (row as unknown as Record<string, string>)[s.status] === 'failed');

/** Automatic tries a keyword's step has had so far. */
export const retriesOf = (row: { retries_json?: string }): Partial<Record<StepName, number>> => {
  try {
    return JSON.parse(row.retries_json || '{}') as Partial<Record<StepName, number>>;
  } catch {
    return {};
  }
};

/**
 * Look at every failed step: schedule its next automatic try, or run the
 * ones that are due. Returns true when something went back in the queue (the
 * writer should then be started).
 */
export function sweepRetries(settings: Settings, now = Date.now()): boolean {
  // A step that is no longer failed (it passed, or was pressed "again") has
  // no pending try.
  run(
    `UPDATE keyword_seo SET retry_step = '', retry_at = NULL
      WHERE retry_at IS NOT NULL AND 'failed' NOT IN (status, recipe_status, skeleton_status, article_status, images_status)`,
  );
  if (!settings.getBool('auto_retry_enabled')) return false;
  const max = Math.max(0, settings.getNumber('auto_retry_max'));
  const delay = Math.max(0, settings.getNumber('auto_retry_delay_minutes')) * 60_000;

  let requeued = false;
  const rows = all<RetryRow>(
    `SELECT * FROM keyword_seo WHERE 'failed' IN (status, recipe_status, skeleton_status, article_status, images_status)`,
  );
  for (const row of rows) {
    const step = failedStep(row);
    if (!step) continue;
    const tries = retriesOf(row);
    if ((tries[step.name] ?? 0) >= max) continue;
    if (row.retry_step !== step.name || row.retry_at === null) {
      run('UPDATE keyword_seo SET retry_step = ?, retry_at = ? WHERE id = ?', step.name, now + delay, row.id);
      continue;
    }
    if (row.retry_at > now) continue;
    tries[step.name] = (tries[step.name] ?? 0) + 1;
    run(`UPDATE keyword_seo SET retries_json = ?, retry_step = '', retry_at = NULL WHERE id = ?`, JSON.stringify(tries), row.id);
    step.requeue(row.id);
    log.info(`Trying the ${step.name} of "${row.keyword}" again automatically (try ${tries[step.name]} of ${max}).`);
    requeued = true;
  }
  return requeued;
}

/** When the next automatic try is due, for showing on a failed card. */
export const nextRetryAt = (row: { retry_at?: number | null }): number | null => row.retry_at ?? null;
