import { all, get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import type { Fetch } from './platform.js';

const log = createLogger('google-accounts');

/**
 * The Google accounts Flow jobs run on, in order.
 *
 * Each account is signed in once, in the image service's Chrome, next to the
 * others (Google's own multi-account sign-in), and keeps its session there.
 * A job uses the first working account; when Google answers that it is
 * limited, flagged or signed out, that account is marked and the same job
 * goes straight to the next one.
 */

export type AccountStatus = 'working' | 'limited' | 'signed_out' | 'blocked';

export interface GoogleAccount {
  id: number;
  email: string;
  /** Its Flow project address; blank means the websites' own projects, as before accounts. */
  flow_project: string;
  position: number;
  status: AccountStatus;
  credits: string;
  last_used_at: string | null;
  last_error: string;
  /** When a limited or blocked account is tried again (ms). */
  retry_at: number;
}

/** How long a limited account rests before jobs try it again. */
export const GOOGLE_ACCOUNT_COOLDOWN_MS = 30 * 60_000;

/**
 * How long an account Google flagged for unusual activity rests. Longer than a
 * limit: submitting into that verdict is how accounts end up blocked outright
 * (crisng95/flowkit#67), and the image service holds every job for an hour
 * after one anyway.
 */
export const GOOGLE_ACCOUNT_BLOCKED_COOLDOWN_MS = 60 * 60_000;

export const STATUS_LABEL: Record<AccountStatus, string> = {
  working: 'Working',
  limited: 'Limited',
  signed_out: 'Signed out',
  blocked: 'Blocked',
};

export const NO_WORKING_ACCOUNT = 'No working Google account. Platform settings.';

export function listGoogleAccounts(): GoogleAccount[] {
  return all<GoogleAccount>('SELECT * FROM google_accounts ORDER BY position, id');
}

export function getGoogleAccount(id: number): GoogleAccount | undefined {
  return get<GoogleAccount>('SELECT * FROM google_accounts WHERE id = ?', id);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROJECT = /^https:\/\/(flow\.google\.com|labs\.google)\/.*project\/[0-9a-fA-F-]{36}/;

/** What is wrong with an account's fields, by field; empty when they are fine. */
export function checkAccountFields(email: string, project: string, exceptId = 0): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!EMAIL.test(email)) errors.email = 'Enter the Google email address.';
  else if (get('SELECT 1 FROM google_accounts WHERE lower(email) = lower(?) AND id <> ?', email, exceptId)) errors.email = 'This account is already in the list.';
  if (project && !PROJECT.test(project)) errors.flow_project = 'Paste the project address from Flow, like https://flow.google.com/u/1/project/…';
  return errors;
}

export function addGoogleAccount(email: string, project: string): number {
  const last = get<{ p: number | null }>('SELECT MAX(position) AS p FROM google_accounts');
  return run('INSERT INTO google_accounts (email, flow_project, position) VALUES (?, ?, ?)', email.trim(), project.trim(), (last?.p ?? 0) + 1).lastInsertRowid;
}

export function changeGoogleAccount(id: number, email: string, project: string): void {
  run('UPDATE google_accounts SET email = ?, flow_project = ? WHERE id = ?', email.trim(), project.trim(), id);
}

export function removeGoogleAccount(id: number): void {
  run('DELETE FROM google_accounts WHERE id = ?', id);
}

/** Swap an account with its neighbour above (-1) or below (+1). */
export function moveGoogleAccount(id: number, direction: -1 | 1): void {
  const list = listGoogleAccounts();
  const at = list.findIndex((a) => a.id === id);
  const other = list[at + direction];
  if (at < 0 || !other) return;
  const order = list.map((a) => a.id);
  [order[at], order[at + direction]] = [order[at + direction]!, order[at]!];
  order.forEach((accountId, i) => run('UPDATE google_accounts SET position = ? WHERE id = ?', i + 1, accountId));
}

/**
 * Which account trouble an error from Flow names, if any.
 *
 * Read from the text the image service passes on: Google's own codes where
 * it gives them, and the service's words where it rewrote them.
 */
export function accountTrouble(message: string): Exclude<AccountStatus, 'working'> | null {
  if (/SESSION_EXPIRED|UNAUTHENTICATED|signed this browser out|sign in again|\b401\b/i.test(message)) return 'signed_out';
  if (/UNUSUAL_ACTIVITY|unusual activity/i.test(message)) return 'blocked';
  if (/USER_QUOTA_REACHED|no video credits left|RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b|recaptcha evaluation failed/i.test(message)) return 'limited';
  return null;
}

const outOfCredits = (message: string): boolean => /USER_QUOTA_REACHED|no video credits left/i.test(message);

function markTrouble(account: GoogleAccount, trouble: Exclude<AccountStatus, 'working'>, message: string, now: number): void {
  // A signed-out account waits for Sign in; the others rest and are tried again.
  const retryAt = trouble === 'signed_out' ? 0
    : now + (trouble === 'blocked' ? GOOGLE_ACCOUNT_BLOCKED_COOLDOWN_MS : GOOGLE_ACCOUNT_COOLDOWN_MS);
  run(
    `UPDATE google_accounts SET status = ?, retry_at = ?, last_error = ?, credits = CASE WHEN ? THEN '0' ELSE credits END WHERE id = ?`,
    trouble, retryAt, message.slice(0, 300), outOfCredits(message) ? 1 : 0, account.id,
  );
  log.warn(`Google account ${account.email || '#' + account.position} is ${STATUS_LABEL[trouble].toLowerCase()}: ${message.slice(0, 200)}`);
}

export const NEEDS_PROJECT = 'Needs its own Flow project address (Change).';

/**
 * True for an account Flow cannot be pointed at. Without its own project
 * address (flow.google.com/u/N/project/…) a job goes into the websites' own
 * projects, which belong to one account only: the first account without an
 * address is that one; a later one would only repeat it, so it is skipped.
 */
export function needsProject(account: GoogleAccount, accounts: GoogleAccount[]): boolean {
  return !account.flow_project && accounts.find((a) => !a.flow_project)?.id !== account.id;
}

/** The accounts a job may use now, in order: working ones, and rested ones whose time is up. */
export function usableAccounts(now = Date.now()): GoogleAccount[] {
  const accounts = listGoogleAccounts();
  return accounts.filter(
    (a) => !needsProject(a, accounts) && (a.status === 'working' || ((a.status === 'limited' || a.status === 'blocked') && a.retry_at <= now)),
  );
}

/** True when there are accounts and not one of them can take a job. */
export function noWorkingAccount(now = Date.now()): boolean {
  return listGoogleAccounts().length > 0 && usableAccounts(now).length === 0;
}

/**
 * Run one Flow job on the first working account, moving on to the next one
 * when an account is limited, flagged or signed out.
 *
 * `job` is given the Flow project to use: the account's own, or the one the
 * caller would have used anyway when the account has none. An error that is
 * not about the account ends it as before; when every account was tried, the
 * last account's own error is the one thrown, so callers see what Google said.
 */
export async function withGoogleAccount<T>(fallbackProject: string, job: (projectId: string) => Promise<T>, now: () => number = Date.now): Promise<T> {
  if (listGoogleAccounts().length === 0) return job(fallbackProject);
  const tried = new Set<number>();
  let lastError: unknown = null;
  for (;;) {
    const account = usableAccounts(now()).find((a) => !tried.has(a.id));
    if (!account) {
      if (lastError) throw lastError;
      throw new Error(NO_WORKING_ACCOUNT);
    }
    tried.add(account.id);
    try {
      const result = await job(account.flow_project || fallbackProject);
      run(
        `UPDATE google_accounts SET status = 'working', retry_at = 0, last_used_at = datetime('now'), credits = CASE WHEN credits = '0' THEN '' ELSE credits END WHERE id = ?`,
        account.id,
      );
      return result;
    } catch (err) {
      const message = errorMessage(err);
      run(`UPDATE google_accounts SET last_used_at = datetime('now') WHERE id = ?`, account.id);
      const trouble = accountTrouble(message);
      if (!trouble) {
        run('UPDATE google_accounts SET last_error = ? WHERE id = ?', message.slice(0, 300), account.id);
        throw err;
      }
      markTrouble(account, trouble, message, now());
      // Unusual activity is not moved past. Every account here runs in the
      // same Chrome on the same connection, which may be what Google judged,
      // and trying the next one straight away is one more submit into that
      // verdict. The image service holds all jobs for an hour after it.
      if (trouble === 'blocked') throw err;
      lastError = err;
    }
  }
}

/**
 * Sign in: the image service's Chrome opens Google's sign-in page with the
 * email filled in, for the person to finish on the Browser page. The account
 * is tried again from the next job.
 */
export async function startSignIn(settings: Settings, account: GoogleAccount, fetchImpl: Fetch = fetch): Promise<string | null> {
  run(`UPDATE google_accounts SET status = 'working', retry_at = 0 WHERE id = ? AND status = 'signed_out'`, account.id);
  const base = settings.get('image_base_url').replace(/\/+$/, '');
  if (!base) return 'No image service address is configured in the deployment.';
  try {
    const response = await fetchImpl(`${base}/flow/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': settings.get('image_api_key') },
      body: JSON.stringify({ email: account.email }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return `The image service answered HTTP ${response.status}.`;
    return null;
  } catch (err) {
    return `The image service is not answering: ${errorMessage(err)}`;
  }
}
