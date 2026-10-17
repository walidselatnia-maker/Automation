import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('threads');

/**
 * Threads API client, for posting pictures and videos to a Threads profile.
 *
 * Threads has its own sign-in, apart from Facebook's: a long-lived user token
 * (threads_basic and threads_content_publish) that lasts 60 days and is
 * renewed from itself before it runs out (refresh). Like Instagram, Threads
 * fetches the file from a public address: a container is made from the link,
 * waited on until Threads has finished with it, then published.
 */

const GRAPH = 'https://graph.threads.net/v1.0';

export class ThreadsError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'ThreadsError';
  }
}

export interface ThreadsProfile {
  id: string;
  username: string;
}

export interface ThreadsClientOptions {
  token: string;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

interface GraphError {
  error?: { message?: string; error_user_msg?: string };
}

export class ThreadsClient {
  private readonly token: string;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;

  constructor(options: ThreadsClientOptions) {
    this.token = options.token.trim();
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 60;
  }

  private async read<T>(response: Response, what: string): Promise<T> {
    const text = await response.text();
    let body: (T & GraphError) | undefined;
    try {
      body = text ? (JSON.parse(text) as T & GraphError) : undefined;
    } catch {
      throw new ThreadsError(`${what} returned a non-JSON response`, text.slice(0, 300));
    }
    if (body?.error) throw new ThreadsError(`${what} failed: ${body.error.error_user_msg ?? body.error.message ?? 'unknown error'}`, JSON.stringify(body.error));
    if (!response.ok) throw new ThreadsError(`${what} failed: HTTP ${response.status}`, text.slice(0, 300));
    if (body === undefined) throw new ThreadsError(`${what} returned an empty response`);
    return body;
  }

  private get(path: string, params: Record<string, string>, what: string) {
    const url = new URL(`${GRAPH}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', this.token);
    return fetch(url, { signal: AbortSignal.timeout(30_000) }).then((r) => this.read<Record<string, string>>(r, what));
  }

  private post(path: string, params: Record<string, string>, what: string) {
    const url = new URL(`${GRAPH}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', this.token);
    return fetch(url, { method: 'POST', signal: AbortSignal.timeout(120_000) }).then((r) => this.read<Record<string, string>>(r, what));
  }

  /** The profile the token belongs to. Also proves the token works. */
  async me(): Promise<ThreadsProfile> {
    if (!this.token) throw new ThreadsError('This channel has no Threads token.');
    const body = await this.get('me', { fields: 'id,username' }, 'Reading the Threads profile');
    if (!body.id) throw new ThreadsError('Threads did not say whose token this is');
    return { id: body.id, username: body.username ?? '' };
  }

  /** A fresh 60-day token from this one, while it is still valid. */
  async refresh(): Promise<{ token: string; expiresAt: number }> {
    const url = new URL('https://graph.threads.net/refresh_access_token');
    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', this.token);
    const body = await this.read<{ access_token?: string; expires_in?: number }>(await fetch(url, { signal: AbortSignal.timeout(30_000) }), 'Renewing the Threads token');
    if (!body.access_token) throw new ThreadsError('Threads did not return a new token');
    return { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 60 * 86_400) * 1000 };
  }

  /** Post a picture or a video with its words; returns the post's id and address. */
  async publish(input: { userId: string; kind: 'image' | 'video'; mediaUrl: string; text: string }): Promise<{ mediaId: string; permalink: string }> {
    const what = input.kind === 'video' ? 'the Threads video' : 'the Threads post';
    const made = await this.post(
      `${input.userId}/threads`,
      input.kind === 'video'
        ? { media_type: 'VIDEO', video_url: input.mediaUrl, text: input.text }
        : { media_type: 'IMAGE', image_url: input.mediaUrl, text: input.text },
      `Preparing ${what}`,
    );
    if (!made.id) throw new ThreadsError('Threads did not return a container id');

    for (let attempt = 1; ; attempt++) {
      const state = await this.get(made.id, { fields: 'status,error_message' }, `Checking ${what}`);
      const status = (state.status ?? '').toUpperCase();
      if (status === 'FINISHED' || status === 'PUBLISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new ThreadsError(`Threads refused ${what}: ${state.error_message || status}`);
      if (attempt >= this.maxAttempts) {
        throw new ThreadsError(`Threads was still working on ${what} after ${Math.round((this.maxAttempts * this.pollIntervalMs) / 1000)}s. Try again later.`);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }

    const published = await this.post(`${input.userId}/threads_publish`, { creation_id: made.id }, `Publishing ${what}`);
    if (!published.id) throw new ThreadsError('Threads did not return a post id');
    let permalink = '';
    try {
      permalink = (await this.get(published.id, { fields: 'permalink' }, 'Reading the post address')).permalink ?? '';
    } catch (err) {
      log.warn(`threads ${published.id}: published, but its address could not be read: ${errorMessage(err)}`);
    }
    return { mediaId: published.id, permalink };
  }
}
