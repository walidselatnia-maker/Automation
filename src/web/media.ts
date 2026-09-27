/**
 * The one door into this platform that a password does not guard.
 *
 * Buffer fetches a reel's video itself, from a url, when the queued post goes
 * out -- with no cookie, from Buffer's servers, possibly days later. Every
 * other path here answers such a request with the login page, so without this
 * route the video has to be copied to some other host first and fetched from
 * there, which is a round trip for bytes this platform already has on disk.
 *
 * What makes it safe is that the link proves itself. It carries an expiry and
 * an HMAC over the reel it names, signed with a key derived for this purpose
 * and nothing else, so it cannot be guessed, edited or extended. See
 * media-links.ts for the signing; this file is only the door.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { checkMediaToken } from '../core/media-links.js';
import { getReel } from '../db/repos.js';
import { createLogger } from '../lib/logger.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

const log = createLogger('media');

/**
 * A signature is 43 base64url characters. Anything longer is not a near miss
 * to be compared in constant time, it is someone throwing bytes at the door.
 */
const MAX_SIGNATURE = 100;

export interface MediaOptions {
  /** The platform secret the link signatures are derived from. */
  secret: Buffer;
  /** Where finished reel videos are written. */
  clipsDir: string;
}

/**
 * Is this a request the signature can speak for?
 *
 * Read by the auth hook, which runs before routing and so has to decide from
 * the url alone. Kept here beside the routes it exempts, so the two can never
 * drift into exempting different things.
 */
export function isSignedMediaRequest(method: string, path: string): boolean {
  // Only reads. A signed link says "you may fetch this file", and nothing
  // else -- a POST to the same path must still meet the password.
  if (method !== 'GET' && method !== 'HEAD') return false;
  return path === '/media' || path.startsWith('/media/');
}

/**
 * Not found, whatever was actually wrong.
 *
 * A forged link and a link to a reel that never existed get the same answer,
 * so the door cannot be used to find out which reel ids are real.
 */
const notFound = (reply: FastifyReply): FastifyReply =>
  reply.code(404).type('text/plain; charset=utf-8').send('Not found');

export function registerMedia(app: FastifyInstance, options: MediaOptions): void {
  app.get<{ Params: { id: string; expires: string; signature: string } }>(
    '/media/reel/:id/:expires/:signature.mp4',
    async (request, reply) => {
      const { id: rawId, expires: rawExpires, signature } = request.params;

      // Parsed strictly. `Number('12abc')` is NaN, but `parseInt` would answer
      // 12, and an id that is not exactly what was signed must not resolve to
      // a file at all.
      if (!/^\d+$/.test(rawId) || !/^\d+$/.test(rawExpires)) return notFound(reply);
      if (!signature || signature.length > MAX_SIGNATURE) return notFound(reply);

      const id = Number(rawId);
      const check = checkMediaToken(
        { kind: 'reel', id, expiresAt: Number(rawExpires), signature },
        options.secret,
      );

      if (!check.ok) {
        if (check.reason === 'expired') {
          // Said out loud, and only for a link that was genuinely ours: this
          // is the one failure worth seeing in the log, because it means a
          // queued post outlived its video and the reel will never appear.
          log.warn(
            `reel ${id}: a media link expired before it was fetched — ` +
              'the Buffer queue is running longer than the link lasts',
          );
          return reply.code(410).type('text/plain; charset=utf-8').send('Gone');
        }
        return notFound(reply);
      }

      // The signature is good, so the file may still be missing: a reel can be
      // deleted, and a clips directory can be wiped between deploys.
      const reel = getReel(id);
      if (!reel) return notFound(reply);

      // `id` is a validated integer, so there is no path to traverse out of
      // the clips directory here, whatever the rest of the url said.
      const file = join(options.clipsDir, `${id}.mp4`);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        log.warn(`reel ${id}: a valid media link, but no video on disk at ${file}`);
        return notFound(reply);
      }

      log.info(
        `reel ${id}: serving the video to ${request.ip} ` +
          `(${String(request.headers['user-agent'] ?? 'no user-agent').slice(0, 80)})`,
      );

      reply
        .type('video/mp4')
        // Nothing in between should keep a copy of a file reached by a token,
        // and nothing should index it.
        .header('cache-control', 'private, no-store')
        .header('x-robots-tag', 'noindex, nofollow, noarchive')
        .header('content-disposition', `inline; filename="reel-${id}.mp4"`)
        // Said whether or not this request asked for a range, because it is
        // how a fetcher decides whether it may ask for one at all.
        .header('accept-ranges', 'bytes');

      const range = rangeOf(request.headers.range, info.size);

      if (range === 'unsatisfiable') {
        return reply
          .code(416)
          .header('content-range', `bytes */${info.size}`)
          .type('text/plain; charset=utf-8')
          .send('Range not satisfiable');
      }

      if (range) {
        // Facebook's video fetcher pulls a file in pieces, and a server that
        // answers a range request with the whole file from byte zero hands it
        // a video that is wrong everywhere after the first piece.
        return reply
          .code(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
          .header('content-length', range.end - range.start + 1)
          .send(createReadStream(file, { start: range.start, end: range.end }));
      }

      return reply
        // What lets a fetcher know the video arrived whole rather than
        // stopping early and queueing a truncated one.
        .header('content-length', info.size)
        .send(createReadStream(file));
    },
  );
}

/**
 * The single byte range this request asked for, if it asked for one.
 *
 * Deliberately narrow: one range, bytes only. A multi-range request is
 * answered with the whole file, which is what the spec allows and what every
 * fetcher that matters here copes with -- assembling a multipart response is
 * a lot of code to serve a case that never arrives.
 */
export function rangeOf(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match as unknown as [string, string, string];
  if (!rawStart && !rawEnd) return null;
  if (size === 0) return 'unsatisfiable';

  let start: number;
  let end: number;

  if (!rawStart) {
    // "bytes=-500": the last 500 bytes, and never before the start of the
    // file however many were asked for.
    const wanted = Number(rawEnd);
    if (wanted === 0) return 'unsatisfiable';
    start = Math.max(0, size - wanted);
    end = size - 1;
  } else {
    start = Number(rawStart);
    // An open-ended range, and an end past the file, both mean "to the end".
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'unsatisfiable';
  if (start > end || start >= size) return 'unsatisfiable';

  return { start, end };
}
