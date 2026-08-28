import { createLogger, errorMessage } from '../lib/logger.js';

/**
 * Turn a page URL into a keyword candidate.
 *
 * The CSV importer assumes you already have a spreadsheet of keywords. Getting
 * to that spreadsheet is the part nobody had tooling for: you find a page worth
 * competing with, and then retype its title, its description and its URL into
 * three columns by hand.
 *
 * So this reads the page and fills those columns in. Deliberately no model in
 * the loop — the fields wanted are the ones the page already declares about
 * itself in its own metadata, and a model asked to extract them would be
 * slower, cost tokens, and occasionally invent one.
 *
 * Nothing is written to the database here. Fetching returns candidates, the UI
 * shows them, and a second submission saves the ones that were kept.
 */

const log = createLogger('url-import');

export interface Candidate {
  url: string;
  seedKeyword: string;
  title: string;
  description: string;
  imageUrl: string;
  /** Populated instead of the rest when this URL could not be read. */
  error?: string;
}

/** No page needs more than this to state what it is about. */
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;

/**
 * Hostnames that must never be fetched.
 *
 * This endpoint takes a URL from a form and asks the server to open it, which
 * is the shape of a request-forgery hole: on this host, "the server" sits on a
 * Docker network with an image service holding a live Google session, and the
 * VPS's own metadata endpoints are a hop away. Only public hosts, only http
 * and https.
 *
 * A literal-address check, not a DNS resolution check — a name that resolves
 * to a private address still gets through this, and closing that properly
 * means resolving first and pinning the socket to the address checked. For a
 * single-operator tool where the only person who can reach the form is the
 * person who owns the server, the literal check is the proportionate half.
 */
const BLOCKED_HOST = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?fc00:/i,
  /^\[?fd/i,
  /^\[?fe80:/i,
  /\.internal$/i,
  /\.local$/i,
];

export function rejectUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'That is not a URL.';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http and https addresses can be read.';
  }
  if (BLOCKED_HOST.some((pattern) => pattern.test(url.hostname))) {
    return 'That address is on a private network, which this will not fetch.';
  }
  return null;
}

/** Read one meta tag, tolerating attribute order and quoting style. */
function meta(html: string, key: string): string {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${key}["'][^>]*\\scontent\\s*=\\s*["']([^"']*)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*\\s(?:property|name)\\s*=\\s*["']${key}["']`,
      'i',
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]).trim();
  }
  return '';
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/**
 * A page title reduced to something usable as a seed keyword.
 *
 * Site names, separators and the marketing adjectives every recipe title
 * carries are stripped, which is the difference between "Easy Baked Chicken
 * Breast Recipe | Best Food Blog" and "Baked Chicken Breast".
 */
export function seedFromTitle(title: string): string {
  const beforeSeparator = title.split(/\s+[|–—·]\s+/)[0] ?? title;

  return beforeSeparator
    .replace(/\((?:[^)]*)\)/g, ' ')
    .replace(/\b(recipe|recipes|easy|quick|simple|best|the|perfect|homemade|ultimate)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Fall back to the raw title rather than returning nothing: an aggressive
    // strip that empties the field is worse than a title that needs an edit.
    || title.trim();
}

export function extractCandidate(url: string, html: string): Candidate {
  const head = html.slice(0, 200_000);

  const title =
    meta(head, 'og:title') ||
    meta(head, 'twitter:title') ||
    decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '')).trim();

  const description =
    meta(head, 'og:description') ||
    meta(head, 'description') ||
    meta(head, 'twitter:description');

  const imageUrl = meta(head, 'og:image') || meta(head, 'twitter:image');

  return {
    url,
    seedKeyword: seedFromTitle(title),
    title,
    description,
    imageUrl: absolute(imageUrl, url),
  };
}

function absolute(candidate: string, base: string): string {
  if (!candidate) return '';
  try {
    return new URL(candidate, base).toString();
  } catch {
    return '';
  }
}

async function fetchOne(url: string): Promise<Candidate> {
  const rejection = rejectUrl(url);
  if (rejection) return blank(url, rejection);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Some publishers serve a stub to anything without a browser-shaped
        // Accept header, and a stub has no metadata to read.
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0 (compatible; ArticlePlatform/1.0)',
      },
    });

    if (!response.ok) return blank(url, `The page answered HTTP ${response.status}.`);

    const type = response.headers.get('content-type') ?? '';
    if (!/html/i.test(type)) return blank(url, `That is ${type || 'not a web page'}, not HTML.`);

    // Read at most MAX_BYTES rather than trusting content-length, which a
    // server is free to lie about or omit.
    const buffer = await readCapped(response);
    const candidate = extractCandidate(response.url || url, buffer);

    if (!candidate.title) return blank(url, 'The page has no title to read.');
    return candidate;
  } catch (err) {
    return blank(url, errorMessage(err));
  }
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return await response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BYTES) break;
    }
  } finally {
    // The response is abandoned mid-stream on the size cap; releasing the
    // reader is what lets the socket be torn down rather than left hanging.
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.min(chunk.length, total - offset)), offset);
    offset += chunk.length;
    if (offset >= total) break;
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(joined);
}

const blank = (url: string, error: string): Candidate => ({
  url,
  seedKeyword: '',
  title: '',
  description: '',
  imageUrl: '',
  error,
});

/** One URL per line; comments, blank lines and duplicates are dropped. */
export function parseUrlList(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  // Line by line first, so a `#` comment takes its whole line with it rather
  // than only the word it is attached to.
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    for (const token of line.split(/[\s,]+/)) {
      const url = token.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

/** How many pages one submission may read. */
export const MAX_URLS = 20;

export async function fetchCandidates(urls: string[]): Promise<Candidate[]> {
  const capped = urls.slice(0, MAX_URLS);
  log.info(`reading ${capped.length} page(s) for keyword candidates`);

  // Sequential on purpose. This is a person pasting a handful of links, and
  // twenty parallel fetches from one IP is the pattern that gets a server
  // blocked by the sites you are trying to read.
  const candidates: Candidate[] = [];
  for (const url of capped) candidates.push(await fetchOne(url));

  return candidates;
}
