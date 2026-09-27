/**
 * Publishing a reel through Buffer instead of straight to the page.
 *
 * Two ways out, and they are not variations of one thing. Publishing to Graph
 * uploads the video to the page and it is live; Buffer takes the video and
 * posts it later, on the queue's own schedule, to whichever channel the page
 * names -- which may be that same Facebook page connected to Buffer, or any
 * other channel on the account.
 *
 * Two consequences follow from "later", and both are handled here rather than
 * pretended away:
 *
 *   Buffer fetches the video from a url when the post goes out, so it cannot
 *   be handed bytes and it cannot be handed one of Flow's urls, which are
 *   signed by Google and expire in minutes. It is given a signed link to this
 *   platform instead -- the video is already on disk here, and copying it to
 *   another host first was a round trip for bytes we hold. The link carries
 *   its own expiry and signature; see core/media-links.ts.
 *
 *   Copying it to the reel's own site remains the fallback, for a deployment
 *   with no public address of its own. It costs an upload and leaves the file
 *   on the site forever, which is why it is no longer the default.
 *
 *   There is no first comment to post. Nothing is live yet, so there is
 *   nothing to comment on, and by the time there is, this process is long
 *   gone. The article link goes at the end of the caption instead.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BufferClient, type BufferChannel } from '../integrations/buffer.js';
import { SiteApiClient } from '../integrations/site-api.js';
import { getFbPage, getSite, siteSecrets, type ReelView } from '../db/repos.js';
import { reelMediaUrl } from '../core/media-links.js';
import { createLogger } from '../lib/logger.js';
import type { Settings } from '../settings.js';

const log = createLogger('reel-buffer');

export type ReelPublisher = 'facebook' | 'buffer';

/** Where reels go. Anything unrecognised is Graph, which is the old behaviour. */
export function reelPublisher(settings: Settings): ReelPublisher {
  return settings.get('reel_publisher') === 'buffer' ? 'buffer' : 'facebook';
}

/** The Buffer account the pages post to, or null when none is configured. */
export function reelBufferClient(settings: Settings): BufferClient | null {
  const token = settings.get('reel_buffer_token').trim();
  return token ? new BufferClient(token) : null;
}

/** Every channel on the reel Buffer account, for the page picker. */
export async function reelBufferChannels(settings: Settings): Promise<BufferChannel[]> {
  const client = reelBufferClient(settings);
  if (!client) throw new Error('No Buffer token for reels yet — add one under Setup → Reels.');

  const organizationId = await client.getOrganizationId();
  return client.getChannels(organizationId);
}

/**
 * The caption Buffer is given.
 *
 * The link is appended rather than commented, because a queued post has no
 * comments yet. Off by setting for anyone who would rather the caption stayed
 * clean and add the link themselves.
 */
export function bufferCaption(reel: ReelView, settings: Settings): string {
  const caption = reel.caption.trim();
  if (!settings.getBool('reel_buffer_link_in_text')) return caption;
  if (!reel.post_url) return caption;
  // A link already in the caption is not repeated: the caption is written by a
  // model and nothing stops it putting one there.
  if (caption.includes(reel.post_url)) return caption;
  return caption ? `${caption}\n\n${reel.post_url}` : reel.post_url;
}

export interface BufferReelDeps {
  /** The video bytes, however the reel stored them. */
  readVideo(reel: ReelView): Promise<Buffer>;
  /** Put the video somewhere Buffer can fetch it, and give back the address. */
  hostVideo(reel: ReelView, video: Buffer): Promise<string>;
  client(): BufferClient | null;
}

/**
 * Hand one reel to Buffer. Answers the Buffer post id.
 *
 * Refuses rather than guesses when the page names no channel: posting a
 * page's reel to some other channel because it was the first in the list is
 * how a recipe ends up on the wrong audience's feed.
 */
export async function sendReelToBuffer(
  reel: ReelView,
  settings: Settings,
  deps: BufferReelDeps,
): Promise<{ postId: string; channelId: string }> {
  if (!reel.fb_page_id) throw new Error('This reel has no page, so no Buffer channel either.');

  const page = getFbPage(reel.fb_page_id);
  if (!page) throw new Error('The page for this reel no longer exists.');

  const channelId = page.buffer_channel_id.trim();
  if (!channelId) {
    throw new Error(
      `“${page.name || page.page_id}” has no Buffer channel yet. Pick one under ` +
        'Channels → Facebook.',
    );
  }

  const client = deps.client();
  if (!client) throw new Error('No Buffer token for reels yet — add one under Setup → Reels.');

  const video = await deps.readVideo(reel);
  const videoUrl = await deps.hostVideo(reel, video);

  const postId = await client.createVideoPost({
    text: bufferCaption(reel, settings),
    channelId,
    videoUrl,
  });

  return { postId, channelId };
}

/**
 * The production deps: the reel's own file, served by this platform.
 *
 * `key` is the platform secret, and signs the link. It is the same value the
 * web server verifies with, which is what makes a link made here openable
 * there and nowhere else.
 */
export function bufferReelDeps(
  settings: Settings,
  key: Buffer,
  readVideo: (reel: ReelView) => Promise<Buffer>,
  clipsDir: string,
): BufferReelDeps {
  return {
    readVideo,
    async hostVideo(reel, video) {
      const base = settings.get('public_base_url').trim();
      if (base) {
        await keepOnDisk(clipsDir, reel.id, video);
        const url = reelMediaUrl(base, reel.id, Number(settings.get('reel_media_link_days')), key);
        log.info(`reel ${reel.id}: Buffer will fetch the video from this platform`);
        return url;
      }

      // No public address for this platform, so Buffer has nowhere here to
      // fetch from and the video goes to the site the old way.
      if (!reel.site_id) {
        throw new Error(
          'This reel has no site, and this platform has no public address, so ' +
            'there is nowhere Buffer could fetch the video from. Set the public ' +
            'address under Setup → Reels.',
        );
      }
      return hostOnSite(reel.site_id, video, key);
    },
    client: () => reelBufferClient(settings),
  };
}

/**
 * Make sure the video is where the media route will look for it.
 *
 * Usually it already is -- this is the same file the assembler wrote. It is
 * not when the reel's video came from a url rather than from here, and the
 * link would then point at a file that does not exist.
 */
async function keepOnDisk(clipsDir: string, reelId: number, video: Buffer): Promise<void> {
  const file = join(clipsDir, `${reelId}.mp4`);
  const existing = await stat(file).catch(() => null);
  if (existing?.isFile() && existing.size === video.byteLength) return;

  await mkdir(clipsDir, { recursive: true });
  await writeFile(file, video);
}

/** The fallback: a copy on the reel's own site, at an address that never expires. */
async function hostOnSite(siteId: number, video: Buffer, key: Buffer): Promise<string> {
  const site = getSite(siteId);
  if (!site) throw new Error('The site this reel belongs to no longer exists.');

  const api = new SiteApiClient(site.domain, siteSecrets(site, key).apiToken);
  // The upload endpoint takes any file; the content type is what makes it a
  // video rather than a picture.
  const uploaded = await api.uploadImage(video, `reel-${Date.now()}.mp4`, 'video/mp4', 'reels');
  return api.absoluteUrl(uploaded.url);
}
