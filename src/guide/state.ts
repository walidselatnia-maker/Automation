import { all, get, run } from '../db/index.js';
import {
  isStepKey,
  nextStep,
  prevStep,
  stepDef,
  stepIndex,
  STEPS,
  validateResult,
  type IdentityResult,
  type KeywordsResult,
  type PillarsResult,
  type StepKey,
  type Validation,
} from './steps.js';

/**
 * Where each site is in the guide, what it has decided, and the chat that got
 * it there. Plain reads and writes; the rules about what a valid result is
 * live in steps.ts.
 */

export interface Cursor {
  siteId: number;
  step: StepKey;
  round: number;
}

/** The site's place in the guide, made on first use. */
export function getCursor(siteId: number): Cursor {
  run('INSERT OR IGNORE INTO guide_sites (site_id) VALUES (?)', siteId);
  const row = get<{ current_step: string; round: number }>(
    'SELECT current_step, round FROM guide_sites WHERE site_id = ?',
    siteId,
  )!;
  return {
    siteId,
    step: isStepKey(row.current_step) ? row.current_step : 'identity',
    round: row.round,
  };
}

function setCursor(siteId: number, step: StepKey, round: number): void {
  run('UPDATE guide_sites SET current_step = ?, round = ? WHERE site_id = ?', step, round, siteId);
}

/** The round a step's rows are stored under: 0 for site-wide steps. */
export const scopeOf = (step: StepKey, round: number): number =>
  stepDef(step).perRound ? round : 0;

export function getResult<T>(siteId: number, step: StepKey, round: number): T | null {
  const row = get<{ result_json: string }>(
    'SELECT result_json FROM guide_steps WHERE site_id = ? AND round = ? AND step_key = ?',
    siteId,
    scopeOf(step, round),
    step,
  );
  if (!row) return null;
  try {
    return JSON.parse(row.result_json) as T | null;
  } catch {
    return null;
  }
}

export function getStatus(siteId: number, step: StepKey, round: number): 'open' | 'done' {
  const row = get<{ status: string }>(
    'SELECT status FROM guide_steps WHERE site_id = ? AND round = ? AND step_key = ?',
    siteId,
    scopeOf(step, round),
    step,
  );
  return row?.status === 'done' ? 'done' : 'open';
}

/** Save a result if it is valid. An invalid one leaves the old result alone. */
export function saveResult(siteId: number, step: StepKey, round: number, value: unknown): Validation {
  const checked = validateResult(step, value);
  if (!checked.ok) return checked;
  run(
    `INSERT INTO guide_steps (site_id, round, step_key, result_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (site_id, round, step_key)
       DO UPDATE SET result_json = excluded.result_json, updated_at = datetime('now')`,
    siteId,
    scopeOf(step, round),
    step,
    JSON.stringify(checked.value),
  );
  return checked;
}

/** Finish the current step and move to the next. Refused without a result. */
export function markDone(
  siteId: number,
): { ok: true; next: StepKey | null } | { ok: false; problem: string } {
  const c = getCursor(siteId);
  if (getResult(siteId, c.step, c.round) === null) {
    return { ok: false, problem: 'Save a result for this step first.' };
  }
  run(
    `UPDATE guide_steps SET status = 'done', updated_at = datetime('now')
     WHERE site_id = ? AND round = ? AND step_key = ?`,
    siteId,
    scopeOf(c.step, c.round),
    c.step,
  );
  const next = nextStep(c.step);
  if (next) setCursor(siteId, next, c.round);
  return { ok: true, next };
}

export function goBack(siteId: number): void {
  const c = getCursor(siteId);
  const prev = prevStep(c.step);
  if (prev) setCursor(siteId, prev, c.round);
}

function firstOpenStep(siteId: number, round: number): StepKey {
  for (const s of STEPS) if (getStatus(siteId, s.key, round) !== 'done') return s.key;
  return STEPS[STEPS.length - 1]!.key;
}

/** A step can be opened when it is done, current, or the first one not done. */
export function canOpen(siteId: number, step: StepKey): boolean {
  const c = getCursor(siteId);
  return (
    step === c.step ||
    getStatus(siteId, step, c.round) === 'done' ||
    firstOpenStep(siteId, c.round) === step
  );
}

export function goTo(siteId: number, step: StepKey): boolean {
  if (!canOpen(siteId, step)) return false;
  setCursor(siteId, step, getCursor(siteId).round);
  return true;
}

export const isRoundFinished = (siteId: number): boolean =>
  getStatus(siteId, 'import', getCursor(siteId).round) === 'done';

/** Steps 4–6 again, for the next pillar. Only once this round is imported. */
export function startNextPillar(siteId: number): boolean {
  if (!isRoundFinished(siteId)) return false;
  setCursor(siteId, 'keywords', getCursor(siteId).round + 1);
  return true;
}

/* -- Chat ------------------------------------------------------------------ */

export interface GuideMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export function addMessage(
  siteId: number,
  step: StepKey,
  round: number,
  role: 'user' | 'assistant',
  content: string,
  payload: Record<string, unknown> = {},
): void {
  run(
    `INSERT INTO guide_messages (site_id, round, step_key, role, content, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    siteId,
    scopeOf(step, round),
    step,
    role,
    content,
    JSON.stringify(payload),
  );
}

export function listMessages(siteId: number, step: StepKey, round: number): GuideMessage[] {
  return all<{
    id: number;
    role: 'user' | 'assistant';
    content: string;
    payload: string;
    created_at: string;
  }>(
    `SELECT id, role, content, payload, created_at FROM guide_messages
     WHERE site_id = ? AND round = ? AND step_key = ? ORDER BY id`,
    siteId,
    scopeOf(step, round),
    step,
  ).map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      // A broken payload loses its chips, not the message.
    }
    return { ...row, payload };
  });
}

/* -- What later steps read ------------------------------------------------- */

export function siteContext(
  siteId: number,
  round: number,
): { identity: string; pillars: string[]; currentPillar: string } {
  return {
    identity: getResult<IdentityResult>(siteId, 'identity', round)?.identity ?? '',
    pillars: getResult<PillarsResult>(siteId, 'pillars', round)?.pillars ?? [],
    currentPillar: getResult<KeywordsResult>(siteId, 'keywords', round)?.pillar ?? '',
  };
}

export const existingKeywordsForSite = (siteId: number): string[] =>
  all<{ seed_keyword: string }>(
    `SELECT k.seed_keyword FROM keywords k
     JOIN keyword_sites ks ON ks.keyword_id = k.id
     WHERE ks.site_id = ? ORDER BY k.id`,
    siteId,
  ).map((r) => r.seed_keyword);

export interface SiteProgress {
  started: boolean;
  step: StepKey;
  index: number;
  total: number;
  round: number;
  finished: boolean;
}

/** For the site list. Reading it does not start the guide for a site. */
export function progressFor(siteId: number): SiteProgress {
  const started = get('SELECT 1 AS x FROM guide_sites WHERE site_id = ?', siteId) !== undefined;
  if (!started) {
    return { started, step: 'identity', index: 1, total: STEPS.length, round: 1, finished: false };
  }
  const c = getCursor(siteId);
  return {
    started,
    step: c.step,
    index: stepIndex(c.step) + 1,
    total: STEPS.length,
    round: c.round,
    finished: isRoundFinished(siteId),
  };
}
