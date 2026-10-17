import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('facebook');

/**
 * Facebook Graph API client, for publishing Reels to Pages.
 *
 * Authentication is a Business Manager **system user** token. Unlike a user
 * token it has no 60-day clock and survives a password change, because it
 * belongs to the business rather than to a person — which is what makes
 * unattended publishing possible without a refresh job nobody remembers to
 * check. One client per token; a page publishes with the token it was found
 * under, so pages from several apps sit side by side.
 *
 * Page tokens are minted per publish rather than stored. They are derivable
 * from the system token in one call, and deriving them means a page that gains
 * or loses permission takes effect immediately instead of at the next time
 * somebody re-pastes a credential.
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export class FacebookError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'FacebookError';
  }
}

export interface FacebookPage {
  id: string;
  name: string;
}

/** An Instagram professional account, reached through the Facebook page it is linked to. */
export interface InstagramAccount {
  pageId: string;
  pageName: string;
  igUserId: string;
  username: string;
}

export interface PublishedReel {
  videoId: string;
  permalink: string;
}

export interface FacebookClientOptions {
  systemUserToken: string;
  /**
   * How long to wait for Facebook to finish processing an uploaded video.
   *
   * Publishing is not the end of it: Facebook accepts the upload, returns a
   * video id, and only then transcodes — and a rejected video reports its
   * rejection here, minutes later. Treating the upload as success is how a
   * failure gets recorded as a publish.
   */
  pollIntervalMs?: number;
  maxAttempts?: number;
}

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_user_msg?: string };
}

export class FacebookClient {
  private readonly token: string;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;

  constructor(options: FacebookClientOptions) {
    this.token = options.systemUserToken.trim();
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 60;
  }

  get configured(): boolean {
    return this.token !== '';
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new FacebookError(
        'This page has no Facebook token. Add one under Settings → Facebook.',
      );
    }
  }

  /**
   * Read a Graph response, turning its error envelope into a thrown error.
   *
   * Graph answers 200 with an `error` object often enough that checking the
   * status alone lets failures through as success.
   */
  private async read<T>(response: Response, what: string): Promise<T> {
    const text = await response.text();

    let body: (T & GraphError) | undefined;
    try {
      body = text ? (JSON.parse(text) as T & GraphError) : undefined;
    } catch {
      throw new FacebookError(`${what} returned a non-JSON response`, text.slice(0, 300));
    }

    if (body?.error) {
      const message = body.error.error_user_msg ?? body.error.message ?? 'unknown error';
      throw new FacebookError(`${what} failed: ${message}`, JSON.stringify(body.error));
    }

    if (!response.ok) {
      throw new FacebookError(`${what} failed: HTTP ${response.status}`, text.slice(0, 300));
    }

    if (body === undefined) {
      throw new FacebookError(`${what} returned an empty response`);
    }

    return body;
  }

  /** Every Page the system user can see. Used to verify the token. */
  async listPages(): Promise<FacebookPage[]> {
    this.assertConfigured();

    const url = new URL(`${GRAPH}/me/accounts`);
    url.searchParams.set('fields', 'id,name');
    url.searchParams.set('limit', '200');
    url.searchParams.set('access_token', this.token);

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await this.read<{ data?: FacebookPage[] }>(response, 'Listing pages');
    return body.data ?? [];
  }

  /**
   * A page access token, derived from the system user token.
   *
   * Not cached: the call is cheap next to uploading a video, and a stale page
   * token is an authorisation failure at the worst possible moment — after the
   * video has been generated and paid for.
   */
  async pageToken(pageId: string): Promise<string> {
    this.assertConfigured();

    const url = new URL(`${GRAPH}/${pageId}`);
    url.searchParams.set('fields', 'access_token');
    url.searchParams.set('access_token', this.token);

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await this.read<{ access_token?: string }>(
      response,
      `Fetching a page token for ${pageId}`,
    );

    if (!body.access_token) {
      throw new FacebookError(
        `Page ${pageId} returned no access token. The system user probably has no ` +
          'role on that page, or is missing pages_manage_posts.',
      );
    }

    return body.access_token;
  }

  /**
   * Publish a Reel to a Page.
   *
   * Four steps, not three: start reserves a video id and an upload URL, the
   * bytes go to that URL, finish publishes it, and then Facebook is polled
   * until it says the video is actually ready. Skipping the fourth reports
   * rejected videos as published.
   */
  async publishReel(input: {
    pageId: string;
    video: Buffer;
    description: string;
  }): Promise<PublishedReel> {
    const token = await this.pageToken(input.pageId);

    const { videoId, uploadUrl } = await this.startUpload(input.pageId, token);
    log.debug(`reel upload ${videoId} started for page ${input.pageId}`);

    await this.uploadBytes(uploadUrl, token, input.video);
    log.debug(`reel ${videoId}: ${input.video.length} bytes uploaded`);

    await this.finishUpload(input.pageId, token, videoId, input.description);
    log.info(`reel ${videoId} submitted, waiting for Facebook to finish processing`);

    await this.waitUntilReady(videoId, token);

    return {
      videoId,
      permalink: `https://www.facebook.com/reel/${videoId}`,
    };
  }

  /**
   * Leave a comment on a published reel, as the Page.
   *
   * This is where the article link goes. Not the caption: a link in the
   * description is the thing Facebook's ranking reads as an exit and shows
   * to fewer people, and it is also what makes a post look like an ad. The
   * first comment carries it fine and still gets tapped.
   *
   * Needs pages_manage_engagement on the token, which a token minted for
   * publishing alone may lack. That surfaces as a Graph error here rather
   * than a silent absence, so the caller can say so.
   */
  async commentOnReel(input: {
    pageId: string;
    videoId: string;
    message: string;
  }): Promise<{ commentId: string }> {
    const token = await this.pageToken(input.pageId);

    const response = await fetch(`${GRAPH}/${input.videoId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: input.message, access_token: token }),
      signal: AbortSignal.timeout(60_000),
    });

    const body = await this.read<{ id?: string }>(response, 'Commenting on the reel');
    if (!body.id) throw new FacebookError('Facebook did not return a comment id');

    return { commentId: body.id };
  }

  /**
   * Publish an image post to a Page: the picture's bytes and the post text.
   * Returns the post id, which the link comment is then added to.
   */
  async publishPhoto(input: {
    pageId: string;
    image: Buffer;
    contentType: string;
    message: string;
  }): Promise<{ postId: string }> {
    const token = await this.pageToken(input.pageId);
    const form = new FormData();
    form.set('source', new Blob([new Uint8Array(input.image)], { type: input.contentType }), 'picture');
    form.set('caption', input.message);
    form.set('published', 'true');
    form.set('access_token', token);

    const response = await fetch(`${GRAPH}/${input.pageId}/photos`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const body = await this.read<{ id?: string; post_id?: string }>(response, 'Publishing the image post');
    const postId = body.post_id ?? body.id;
    if (!postId) throw new FacebookError('Facebook did not return a post id');
    return { postId };
  }

  /** Add a comment to any post on a Page (an image post, or a reel by its video id). */
  async commentOnPost(input: { pageId: string; postId: string; message: string }): Promise<{ commentId: string }> {
    return this.commentOnReel({ pageId: input.pageId, videoId: input.postId, message: input.message });
  }

  private async startUpload(
    pageId: string,
    pageToken: string,
  ): Promise<{ videoId: string; uploadUrl: string }> {
    const response = await fetch(`${GRAPH}/${pageId}/video_reels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_phase: 'start', access_token: pageToken }),
      signal: AbortSignal.timeout(60_000),
    });

    const body = await this.read<{ video_id?: string; upload_url?: string }>(
      response,
      'Starting the reel upload',
    );

    if (!body.video_id || !body.upload_url) {
      throw new FacebookError('Facebook did not return a video id and upload URL');
    }

    return { videoId: body.video_id, uploadUrl: body.upload_url };
  }

  /**
   * The bytes themselves.
   *
   * Note this does not go to the Graph host and does not take an access_token
   * parameter: the upload URL is its own endpoint and wants the page token in
   * an `Authorization: OAuth` header, which is the one place in this API where
   * that is true.
   */
  private async uploadBytes(uploadUrl: string, pageToken: string, video: Buffer): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${pageToken}`,
        offset: '0',
        file_size: String(video.length),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(video),
      signal: AbortSignal.timeout(600_000),
    });

    await this.read<{ success?: boolean }>(response, 'Uploading the reel');
  }

  private async finishUpload(
    pageId: string,
    pageToken: string,
    videoId: string,
    description: string,
  ): Promise<void> {
    const url = new URL(`${GRAPH}/${pageId}/video_reels`);
    url.searchParams.set('upload_phase', 'finish');
    url.searchParams.set('video_id', videoId);
    url.searchParams.set('video_state', 'PUBLISHED');
    url.searchParams.set('description', description);
    url.searchParams.set('access_token', pageToken);

    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    });

    await this.read<{ success?: boolean }>(response, 'Publishing the reel');
  }

  /**
   * Wait for Facebook to finish processing, and fail if it refuses the video.
   *
   * `video_status` is the field that tells the truth. `ready` means published;
   * `error` means the upload succeeded and the video did not.
   */
  private async waitUntilReady(videoId: string, pageToken: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));

      const url = new URL(`${GRAPH}/${videoId}`);
      url.searchParams.set('fields', 'status');
      url.searchParams.set('access_token', pageToken);

      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const body = await this.read<{
        status?: { video_status?: string; processing_phase?: { status?: string } };
      }>(response, `Checking reel ${videoId}`);

      const state = (body.status?.video_status ?? '').toLowerCase();

      if (state === 'ready') {
        log.debug(`reel ${videoId} ready after ${attempt} poll(s)`);
        return;
      }

      if (state === 'error') {
        throw new FacebookError(
          `Facebook rejected reel ${videoId} during processing`,
          JSON.stringify(body.status),
        );
      }
    }

    const waited = Math.round((this.maxAttempts * this.pollIntervalMs) / 1000);
    throw new FacebookError(
      `Reel ${videoId} was still processing after ${waited}s. It may yet publish — ` +
        'check the page before uploading it again.',
    );
  }

  /**
   * The Instagram professional accounts linked to the pages this token sees.
   * Instagram's publishing API reaches an account only through its page.
   */
  async listInstagramAccounts(): Promise<InstagramAccount[]> {
    this.assertConfigured();

    const url = new URL(`${GRAPH}/me/accounts`);
    url.searchParams.set('fields', 'id,name,instagram_business_account{id,username}');
    url.searchParams.set('limit', '200');
    url.searchParams.set('access_token', this.token);

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await this.read<{ data?: (FacebookPage & { instagram_business_account?: { id?: string; username?: string } })[] }>(
      response,
      'Listing Instagram accounts',
    );
    return (body.data ?? [])
      .filter((p) => p.instagram_business_account?.id)
      .map((p) => ({
        pageId: p.id,
        pageName: p.name,
        igUserId: p.instagram_business_account!.id!,
        username: p.instagram_business_account!.username ?? '',
      }));
  }

  /**
   * Publish a picture or a reel on an Instagram account.
   *
   * Instagram fetches the file itself from a public address, so the caller
   * hands a link, not bytes. Three steps: a container is made from the link,
   * Instagram is asked until it has finished with it (a video takes a while,
   * and a refused one says so here), then the container is published. The
   * post's address is read last, so the dashboard can link to it.
   */
  async publishInstagram(input: {
    pageId: string;
    igUserId: string;
    kind: 'image' | 'reel';
    mediaUrl: string;
    caption: string;
  }): Promise<{ mediaId: string; permalink: string }> {
    const token = await this.pageToken(input.pageId);
    const what = input.kind === 'reel' ? 'the Instagram reel' : 'the Instagram post';

    const params: Record<string, string> =
      input.kind === 'reel'
        ? { media_type: 'REELS', video_url: input.mediaUrl, share_to_feed: 'true' }
        : { image_url: input.mediaUrl };
    const made = await this.read<{ id?: string }>(
      await fetch(`${GRAPH}/${input.igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, caption: input.caption, access_token: token }),
        signal: AbortSignal.timeout(120_000),
      }),
      `Preparing ${what}`,
    );
    if (!made.id) throw new FacebookError('Instagram did not return a container id');

    await this.waitForContainer(made.id, token, what);

    const published = await this.read<{ id?: string }>(
      await fetch(`${GRAPH}/${input.igUserId}/media_publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creation_id: made.id, access_token: token }),
        signal: AbortSignal.timeout(120_000),
      }),
      `Publishing ${what}`,
    );
    if (!published.id) throw new FacebookError('Instagram did not return a post id');

    let permalink = '';
    try {
      const url = new URL(`${GRAPH}/${published.id}`);
      url.searchParams.set('fields', 'permalink');
      url.searchParams.set('access_token', token);
      permalink = (await this.read<{ permalink?: string }>(await fetch(url, { signal: AbortSignal.timeout(30_000) }), 'Reading the post address')).permalink ?? '';
    } catch (err) {
      log.warn(`instagram ${published.id}: published, but its address could not be read: ${errorMessage(err)}`);
    }
    return { mediaId: published.id, permalink };
  }

  /** Wait until Instagram has finished with a container, and fail if it refused the file. */
  private async waitForContainer(containerId: string, token: string, what: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const url = new URL(`${GRAPH}/${containerId}`);
      url.searchParams.set('fields', 'status_code,status');
      url.searchParams.set('access_token', token);
      const body = await this.read<{ status_code?: string; status?: string }>(
        await fetch(url, { signal: AbortSignal.timeout(30_000) }),
        `Checking ${what}`,
      );
      const code = (body.status_code ?? '').toUpperCase();
      if (code === 'FINISHED' || code === 'PUBLISHED') return;
      if (code === 'ERROR' || code === 'EXPIRED') {
        throw new FacebookError(`Instagram refused ${what}: ${body.status || code}`, JSON.stringify(body));
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    const waited = Math.round((this.maxAttempts * this.pollIntervalMs) / 1000);
    throw new FacebookError(`Instagram was still working on ${what} after ${waited}s. Try again later.`);
  }

  /** Prove the token works, without publishing anything. */
  async healthCheck(): Promise<{ ok: boolean; pages?: number; error?: string }> {
    try {
      const pages = await this.listPages();
      return { ok: true, pages: pages.length };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
