/**
 * Signed, expiring links to files the platform holds on disk.
 *
 * Buffer and Facebook fetch a reel's video themselves, from a url, at a time
 * they choose -- which for a queued post is hours after the post was created.
 * They arrive with no session cookie, so the file cannot sit behind the
 * password that guards everything else here, and it cannot be handed one of
 * Flow's urls, which are signed by Google and expire in minutes.
 *
 * So the link carries its own proof: an expiry and an HMAC over the file it
 * names. Anyone holding the link can fetch that one video until it expires;
 * nobody can guess a link, edit the id in one, or extend the expiry on one,
 * because all three are covered by the signature.
 *
 * Two decisions worth keeping:
 *
 *   The signing key is derived from the platform's secret rather than being
 *   the secret -- a media link and a session cookie are signed by different
 *   keys, so neither can ever be replayed as the other, whatever a future
 *   refactor does to the formats.
 *
 *   The expiry is in the url and covered by the signature, rather than stored
 *   in a table. There is nothing to clean up, nothing to look up on the hot
 *   path, and a link cannot outlive its stated expiry even if the database is
 *   restored from a backup.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Domain separation. Changing this string invalidates every link already
 * handed out, which is the intended way to revoke the lot at once.
 */
const PURPOSE = 'media-link-v1';

/** What a link may point at: a reel video, or a new-website picture (a pin, an image post). */
export type MediaKind = 'reel' | 'picture';

export type MediaCheck =
  | { ok: true }
  /** Correctly signed, but the moment has passed. Worth saying out loud. */
  | { ok: false; reason: 'expired' }
  /** Forged, truncated, edited, or for a different file. All the same thing. */
  | { ok: false; reason: 'invalid' };

/** A key of this platform's own, used for nothing but media links. */
function mediaKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(PURPOSE).digest();
}

function signature(kind: MediaKind, id: number, expiresAt: number, secret: Buffer): string {
  return createHmac('sha256', mediaKey(secret))
    .update(`${PURPOSE}:${kind}:${id}:${expiresAt}`)
    .digest('base64url');
}

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare something anyway, so timing does not leak the length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Is this link good for this file, right now?
 *
 * Everything is checked against what the caller asked for, not against what
 * the link claims: an attacker controls every byte of the url, so the id and
 * kind come from the route and the signature has to agree with them.
 */
export function checkMediaToken(
  input: { kind: MediaKind; id: number; expiresAt: number; signature: string },
  secret: Buffer,
  now: number = Date.now(),
): MediaCheck {
  if (!Number.isSafeInteger(input.id) || input.id <= 0) return { ok: false, reason: 'invalid' };
  if (!Number.isSafeInteger(input.expiresAt)) return { ok: false, reason: 'invalid' };

  const wanted = signature(input.kind, input.id, input.expiresAt, secret);
  if (!safeEqual(input.signature, wanted)) return { ok: false, reason: 'invalid' };

  // Only after the signature: an unsigned link is never "expired", it is junk,
  // and saying which would tell a guesser that the rest of it was right.
  if (input.expiresAt <= now) return { ok: false, reason: 'expired' };

  return { ok: true };
}

/** How long a new link lasts, clamped to something a queue can actually reach. */
export const MIN_LINK_DAYS = 1;
export const MAX_LINK_DAYS = 60;
export const DEFAULT_LINK_DAYS = 14;

export function linkDays(raw: string | number | undefined): number {
  // A setting that was never filled in reads as '', and `Number('')` is 0,
  // which would clamp to the shortest life there is -- the opposite of what
  // "not set" should mean for the value that decides whether a queued post
  // still has a video to publish.
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_LINK_DAYS;

  const value = Math.round(Number(raw));
  if (!Number.isFinite(value)) return DEFAULT_LINK_DAYS;
  return Math.min(MAX_LINK_DAYS, Math.max(MIN_LINK_DAYS, value));
}

/** The path a signed link points at, relative to the platform's own address. */
export function mediaPath(
  kind: MediaKind,
  id: number,
  expiresAt: number,
  secret: Buffer,
  ext = 'mp4',
): string {
  const sig = signature(kind, id, expiresAt, secret);
  // The extension is last and the signature is base64url, which has no dots,
  // so the two can never be confused for one another. Fetchers that sniff the
  // extension rather than the content type get the answer they want.
  return `/media/${kind}/${id}/${expiresAt}/${sig}.${ext}`;
}

/**
 * The absolute address of one new-website picture (newsite_pictures id), for
 * Buffer to fetch: the pictures live on this platform's disk and are served
 * from here, never uploaded somewhere else first.
 */
export function pictureMediaUrl(
  baseUrl: string,
  pictureId: number,
  ext: string,
  days: number,
  secret: Buffer,
  now: number = Date.now(),
): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('No public address for this platform yet.');
  const expiresAt = now + linkDays(days) * 86_400_000;
  return `${base}${mediaPath('picture', pictureId, expiresAt, secret, ext)}`;
}

/**
 * The absolute address to hand to Buffer.
 *
 * Absolute because the fetcher is not a browser and has no page to be relative
 * to, and https because Buffer will not fetch a video over plain http.
 */
export function reelMediaUrl(
  baseUrl: string,
  reelId: number,
  days: number,
  secret: Buffer,
  now: number = Date.now(),
): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('No public address for this platform yet.');

  const expiresAt = now + linkDays(days) * 86_400_000;
  return `${base}${mediaPath('reel', reelId, expiresAt, secret)}`;
}

/**
 * Is this address one a fetcher on the open internet can actually reach?
 *
 * Checked when it is saved rather than when a reel is published, because the
 * failure it prevents is silent: Buffer accepts the post, cannot fetch
 * localhost, and the reel never appears.
 */
export function publicBaseUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'That is not a url. It should look like https://reels.example.com';
  }

  if (url.protocol !== 'https:') {
    return 'It has to be https — Buffer and Facebook will not fetch a video over plain http.';
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return 'Leave off the path — just the address, like https://reels.example.com';
  }

  const host = url.hostname.toLowerCase();
  const unreachable =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (unreachable) {
    return 'Buffer fetches this from the open internet, so a local address will never work.';
  }

  return null;
}
