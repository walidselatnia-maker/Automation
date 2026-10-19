/**
 * Google autocomplete, as a check on what people really search.
 *
 * The suggest endpoint needs no key and answers `[query, [suggestion, ...]]`
 * for client=firefox. It is unofficial, so every failure -- blocked, offline,
 * a changed shape -- comes back as an empty list rather than an error; the
 * guide then says its keywords are unchecked guesses instead of stopping.
 */

const ENDPOINT = 'https://suggestqueries.google.com/complete/search';

/** Each seed is asked alone and followed by each of these. */
export const SUGGEST_MODIFIERS = ['', 'how', 'best', 'easy', 'with', 'without', 'for', 'can you'];

export function parseSuggestResponse(body: unknown): string[] {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return [];
  return (body[1] as unknown[])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SuggestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The interface language Google answers for (en, fr, es…). */
  hl?: string;
}

export async function suggest(query: string, options: SuggestOptions = {}): Promise<string[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${ENDPOINT}?client=firefox&hl=${encodeURIComponent(options.hl || 'en')}&q=${encodeURIComponent(query)}`;
  try {
    const response = await doFetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
    if (!response.ok) return [];
    return parseSuggestResponse(await response.json());
  } catch {
    return [];
  }
}

export interface ExpandOptions extends SuggestOptions {
  /** Hard cap on requests for one expansion. */
  maxRequests?: number;
  /** Pause between requests, so a step run does not look like a flood. */
  delayMs?: number;
  /** Overall time limit; past it no new request is sent and what we have is returned. */
  deadlineMs?: number;
}

export async function expandSeeds(seeds: string[], options: ExpandOptions = {}): Promise<string[]> {
  const maxRequests = options.maxRequests ?? 100;
  const delayMs = options.delayMs ?? 200;
  // A slow or throttled endpoint must not hold the guide's reply for minutes.
  const deadline = Date.now() + (options.deadlineMs ?? 30_000);

  const queries: string[] = [];
  for (const raw of seeds) {
    const seed = raw.trim();
    if (!seed) continue;
    // The modifiers are English words: other languages ask the seed alone.
    for (const modifier of options.hl && options.hl !== 'en' ? [''] : SUGGEST_MODIFIERS) queries.push(modifier ? `${seed} ${modifier}` : seed);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const [i, query] of queries.slice(0, maxRequests).entries()) {
    if (i > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (Date.now() >= deadline) break;
    for (const s of await suggest(query, options)) {
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
