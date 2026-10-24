import { all, get, run } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Fetch } from './client.js';

/**
 * The search API keys Content Research reads Google with (research.ts).
 *
 * Keys are added in bulk, one per line, and kept in that order. They are
 * tried in order, never rotated: the first key that works answers; a key
 * that fails (an error, a rate limit, no credit left) is marked failed with
 * why, and the next one is tried at once. A failed key is skipped until
 * RETRY_MS has passed, then tried again in its place, so one that recovers
 * (new credit, a new month) is used again. When every key failed, the
 * Dashboard says so.
 *
 * Each provider (Serper first, SerpAPI too) answers the same two questions:
 * Google's autocomplete for a query, and its results page (top results,
 * People Also Ask, related searches). Another provider is one more entry in
 * PROVIDERS.
 */

const log = createLogger('newsite-search-keys');

/** How long a failed key is left alone before it is tried again. */
export const RETRY_MS = 60 * 60_000;

export interface SearchPage {
  results: { title: string; url: string }[];
  questions: string[];
  related: string[];
}

export interface Locale {
  /** Google's country and language codes, like "us" and "en". */
  gl?: string;
  hl?: string;
}

export interface SearchProvider {
  key: string;
  label: string;
  autocomplete: (query: string, apiKey: string, locale: Locale, fetchImpl: Fetch) => Promise<string[]>;
  search: (query: string, apiKey: string, locale: Locale, fetchImpl: Fetch) => Promise<SearchPage>;
}

/** A provider's answer that was not a good one: why, in words for the key's status. */
export class SearchKeyError extends Error {}

const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** What a bad answer means, in words: a wrong key, no credit, a rate limit, or the service's own message. */
async function answerError(provider: string, response: Response): Promise<SearchKeyError> {
  const body = await response.text().catch(() => '');
  let message = body.slice(0, 200);
  try {
    const o = JSON.parse(body) as { message?: unknown; error?: unknown };
    message = text(o.message) || text(o.error) || message;
  } catch {
    /* plain text */
  }
  const why =
    response.status === 401 || response.status === 403
      ? 'The key is not accepted'
      : response.status === 429
        ? 'Rate limit reached'
        : response.status === 402 || /credit|quota|limit|plan/i.test(message)
          ? 'No credit left'
          : `${provider} answered ${response.status}`;
  return new SearchKeyError(message ? `${why}: ${message}` : why);
}

async function call(provider: string, fetchImpl: Fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new SearchKeyError(`${provider} could not be reached: ${errorMessage(err)}`);
  }
  if (!response.ok) throw await answerError(provider, response);
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') throw new SearchKeyError(`${provider} gave an answer that could not be read.`);
  if (text(data.error)) throw new SearchKeyError(text(data.error));
  return data;
}

const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

const serper: SearchProvider = {
  key: 'serper',
  label: 'Serper.dev',
  autocomplete: async (query, apiKey, locale, fetchImpl) => {
    const data = await call('Serper', fetchImpl, 'https://google.serper.dev/autocomplete', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: locale.gl ?? 'us', hl: locale.hl ?? 'en' }),
    });
    return list(data.suggestions).map((s) => text(s.value)).filter(Boolean);
  },
  search: async (query, apiKey, locale, fetchImpl) => {
    const data = await call('Serper', fetchImpl, 'https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: locale.gl ?? 'us', hl: locale.hl ?? 'en', num: 10 }),
    });
    return {
      results: list(data.organic).map((r) => ({ title: text(r.title), url: text(r.link) })).filter((r) => r.title),
      questions: list(data.peopleAlsoAsk).map((q) => text(q.question)).filter(Boolean),
      related: list(data.relatedSearches).map((r) => text(r.query)).filter(Boolean),
    };
  },
};

const serpapi: SearchProvider = {
  key: 'serpapi',
  label: 'SerpAPI',
  autocomplete: async (query, apiKey, locale, fetchImpl) => {
    const q = new URLSearchParams({ engine: 'google_autocomplete', q: query, gl: locale.gl ?? 'us', hl: locale.hl ?? 'en', api_key: apiKey });
    const data = await call('SerpAPI', fetchImpl, `https://serpapi.com/search.json?${q}`, { method: 'GET' });
    return list(data.suggestions).map((s) => text(s.value)).filter(Boolean);
  },
  search: async (query, apiKey, locale, fetchImpl) => {
    const q = new URLSearchParams({ engine: 'google', q: query, gl: locale.gl ?? 'us', hl: locale.hl ?? 'en', api_key: apiKey });
    const data = await call('SerpAPI', fetchImpl, `https://serpapi.com/search.json?${q}`, { method: 'GET' });
    return {
      results: list(data.organic_results).map((r) => ({ title: text(r.title), url: text(r.link) })).filter((r) => r.title),
      questions: list(data.related_questions).map((q2) => text(q2.question)).filter(Boolean),
      related: list(data.related_searches).map((r) => text(r.query)).filter(Boolean),
    };
  },
};

export const PROVIDERS: SearchProvider[] = [serper, serpapi];
const providerOf = (key: string): SearchProvider | undefined => PROVIDERS.find((p) => p.key === key);

/* -- The keys -------------------------------------------------------------- */

export interface SearchKeyRow {
  id: number;
  provider: string;
  key_enc: string;
  position: number;
  /** '' = not tried yet, 'working' or 'failed'. */
  status: '' | 'working' | 'failed';
  error: string;
  /** When it was last tried (ms), and when it last failed (ms). */
  checked_at: number;
  failed_at: number;
}

export const listSearchKeys = (): SearchKeyRow[] => all<SearchKeyRow>('SELECT * FROM newsite_search_keys ORDER BY position, id');

/** The end of a key, enough to tell keys apart without showing them. */
export const keyHint = (row: SearchKeyRow, encryptionKey: Buffer): string => {
  try {
    const k = decrypt(row.key_enc, encryptionKey);
    return k.length > 8 ? `…${k.slice(-4)}` : '…';
  } catch {
    return '…';
  }
};

/** One line of the bulk list: "key", or "provider: key" for a provider other than Serper. */
export function parseKeyLine(line: string): { provider: string; key: string } | null {
  const t = line.trim();
  if (!t) return null;
  const m = /^([a-z]+)\s*[:=]\s*(\S+)$/i.exec(t);
  if (m && providerOf(m[1]!.toLowerCase())) return { provider: m[1]!.toLowerCase(), key: m[2]! };
  return /^\S{8,200}$/.test(t) ? { provider: 'serper', key: t } : null;
}

/**
 * Add keys from the bulk box, after the ones there are. A key already in the
 * list is not added twice. Returns how many were added and the lines that
 * are not keys.
 */
export function addSearchKeys(text: string, encryptionKey: Buffer): { added: number; bad: string[] } {
  const have = new Set(listSearchKeys().map((r) => `${r.provider}:${(() => {
    try {
      return decrypt(r.key_enc, encryptionKey);
    } catch {
      return '';
    }
  })()}`));
  let position = (get<{ n: number | null }>('SELECT MAX(position) AS n FROM newsite_search_keys')?.n ?? 0) + 1;
  let added = 0;
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseKeyLine(line);
    if (!parsed) {
      bad.push(line.trim().slice(0, 40));
      continue;
    }
    const id = `${parsed.provider}:${parsed.key}`;
    if (have.has(id)) continue;
    have.add(id);
    run('INSERT INTO newsite_search_keys (provider, key_enc, position) VALUES (?, ?, ?)', parsed.provider, encrypt(parsed.key, encryptionKey), position++);
    added++;
  }
  return { added, bad };
}

export const deleteSearchKey = (id: number): void => {
  run('DELETE FROM newsite_search_keys WHERE id = ?', id);
};

/** Move a key one place up or down the order. */
export function moveSearchKey(id: number, up: boolean): void {
  const keys = listSearchKeys();
  const i = keys.findIndex((k) => k.id === id);
  const j = up ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  keys.forEach((k, n) => run('UPDATE newsite_search_keys SET position = ? WHERE id = ?', n + 1, k.id));
}

/** True when there are keys and every one of them failed: research cannot search. */
export function allSearchKeysFailed(): boolean {
  const keys = listSearchKeys();
  return keys.length > 0 && keys.every((k) => k.status === 'failed');
}

/* -- Asking with them ------------------------------------------------------- */

export interface SearchDeps {
  encryptionKey: Buffer;
  fetchImpl?: Fetch;
  now?: () => number;
}

export type SearchKind = 'autocomplete' | 'search';

/**
 * One question to Google, through the first key that answers. Throws when no
 * key could answer (none added, or every one failed), with each key's reason.
 */
export async function askSearch<K extends SearchKind>(
  kind: K,
  query: string,
  locale: Locale,
  deps: SearchDeps,
): Promise<{ answer: K extends 'autocomplete' ? string[] : SearchPage; keyId: number; provider: string }> {
  const now = deps.now ?? Date.now;
  const keys = listSearchKeys();
  if (!keys.length) throw new SearchKeyError('No search key yet. Add one under Platform settings → Search keys.');
  const reasons: string[] = [];
  const due = keys.filter((k) => k.status !== 'failed' || now() - k.failed_at >= RETRY_MS);
  for (const k of due) {
    const provider = providerOf(k.provider);
    if (!provider) continue;
    let apiKey: string;
    try {
      apiKey = decrypt(k.key_enc, deps.encryptionKey);
    } catch {
      run(`UPDATE newsite_search_keys SET status = 'failed', error = ?, checked_at = ?, failed_at = ? WHERE id = ?`, 'The key could not be read: add it again.', now(), now(), k.id);
      continue;
    }
    try {
      const answer = await provider[kind](query, apiKey, locale, deps.fetchImpl ?? fetch);
      run(`UPDATE newsite_search_keys SET status = 'working', error = '', checked_at = ? WHERE id = ?`, now(), k.id);
      return { answer: answer as K extends 'autocomplete' ? string[] : SearchPage, keyId: k.id, provider: provider.key };
    } catch (err) {
      const why = errorMessage(err).slice(0, 300);
      log.warn(`Search key ${k.id} (${provider.label}) failed: ${why}`);
      run(`UPDATE newsite_search_keys SET status = 'failed', error = ?, checked_at = ?, failed_at = ? WHERE id = ?`, why, now(), now(), k.id);
      reasons.push(`${provider.label} key ${k.position}: ${why}`);
    }
  }
  const resting = keys.length - due.length;
  throw new SearchKeyError(
    `No search key could answer.${reasons.length ? ` ${reasons.join(' · ')}` : ''}${resting ? ` ${resting} failed key${resting === 1 ? ' is' : 's are'} tried again later.` : ''}`,
  );
}

/** Try every key now with a small question, to see which ones work. */
export async function checkSearchKeys(deps: SearchDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  for (const k of listSearchKeys()) {
    const provider = providerOf(k.provider);
    if (!provider) continue;
    try {
      await provider.autocomplete('weather', decrypt(k.key_enc, deps.encryptionKey), {}, deps.fetchImpl ?? fetch);
      run(`UPDATE newsite_search_keys SET status = 'working', error = '', checked_at = ? WHERE id = ?`, now(), k.id);
    } catch (err) {
      run(`UPDATE newsite_search_keys SET status = 'failed', error = ?, checked_at = ?, failed_at = ? WHERE id = ?`, errorMessage(err).slice(0, 300), now(), now(), k.id);
    }
  }
}
