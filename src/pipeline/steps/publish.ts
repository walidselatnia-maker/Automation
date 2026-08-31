import type { Step } from '../engine.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { parseJson } from '../json.js';
import type { PostedRecipe } from '../../integrations/site-api.js';
import type { SeoData } from './content.js';

const log = createLogger('publish');

/** Stages 10-13: Pinterest description, board selection, Buffer, notification. */

export interface PinContext {
  seo: SeoData;
  posted: PostedRecipe;
  pinImageUrl: string;
  cta: string;
}

export const generatePinDescription: Step<PinContext, string> = {
  name: 'generate-pin-description',
  title: 'Write Pinterest description',
  async run(ctx, input) {
    const result = await ctx.prompt('pin-description', {
      seo: input.seo,
      cta: input.cta,
      site: { domain: ctx.site.domain },
      spy: {
        title: ctx.keyword.spy_title,
        description: ctx.keyword.spy_description,
        annotation: ctx.keyword.annotation,
      },
    });

    const text = result.content.trim();
    if (!text) throw new Error('Pin description came back empty');

    return { value: text, endpoint: result.endpoint, model: result.model };
  },
};

export interface BufferTarget {
  channelId: string;
  boardServiceId: string;
  boardName: string;
}

/**
 * Resolve which Buffer channel and Pinterest board to post to.
 *
 * The site's configured channel id is preferred; the model only picks the
 * board, which is what it was doing in the original.
 */
export const resolveBufferTarget: Step<SeoData, BufferTarget> = {
  name: 'resolve-buffer-target',
  title: 'Select Buffer channel and board',
  async run(ctx, seo) {
    const orgId = await ctx.buffer.getOrganizationId();
    const channels = await ctx.buffer.getChannels(orgId);

    if (channels.length === 0) {
      throw new Error('Buffer returned no channels for this organization');
    }

    // The Buffer token is this site's own, so its channel list belongs to this
    // site. Match the Pinterest username when there is more than one.
    const byPinUsername = ctx.site.pin_username.trim().toLowerCase();
    const channel =
      (byPinUsername
        ? channels.find((c) => c.name.toLowerCase() === byPinUsername)
        : undefined) ?? channels[0]!;

    if (channels.length > 1 && !byPinUsername) {
      log.warn(
        `Buffer token for ${ctx.site.domain} exposes ${channels.length} channels and no ` +
          `Pinterest username is set; using "${channel.name}".`,
      );
    }

    if (channel.boards.length === 0) {
      throw new Error(`Buffer channel "${channel.name}" has no Pinterest boards`);
    }

    const result = await ctx.prompt('pick-board', {
      seo,
      boardsJson: JSON.stringify({ boards: channel.boards }),
    });

    let boardServiceId = '';
    let boardName = '';

    try {
      const picked = parseJson<{ id?: string; name?: string; serviceId?: string }>(
        result.content,
        'Board selection',
      );
      boardServiceId = picked.serviceId ?? picked.id ?? '';
      boardName = picked.name ?? '';
    } catch (err) {
      log.warn('Board selection returned unparseable JSON, falling back', errorMessage(err));
    }

    // Trust the board list over the model: only accept an id that exists.
    const matched =
      channel.boards.find((b) => b.serviceId === boardServiceId) ??
      channel.boards.find((b) => b.name.toLowerCase() === boardName.toLowerCase()) ??
      channel.boards[0]!;

    return {
      value: {
        channelId: channel.id,
        boardServiceId: matched.serviceId,
        boardName: matched.name,
      },
      endpoint: result.endpoint,
      model: result.model,
    };
  },
};

export const publishToBuffer: Step<
  { pin: PinContext; description: string; target: BufferTarget },
  { postId: string } | { skipped: true }
> = {
  name: 'publish-to-buffer',
  title: 'Schedule Pinterest pin',
  async run(ctx, input) {
    if (!ctx.settings.getBool('buffer_enabled')) {
      log.info('Buffer publishing is disabled in settings; skipping');
      return { skipped: true as const };
    }

    const host = ctx.site.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const href = String(input.pin.posted.href ?? '');

    // The pool may move to another of this site's Buffer accounts partway
    // through — a full queue is not a reason to lose a finished article — so
    // the board it actually posted to is whatever comes back, not what was
    // resolved earlier.
    const result = await ctx.buffer.createPost(
      {
        text: input.description,
        channelId: input.target.channelId,
        imageUrl: `https://${host}${input.pin.pinImageUrl}`,
        altText: String(input.pin.posted.featuredText ?? input.pin.seo.title),
        title: String(input.pin.posted.title ?? input.pin.seo.title),
        linkUrl: `https://${host}${href}`,
        boardServiceId: input.target.boardServiceId,
      },
      input.target.boardName,
    );

    log.info(
      `scheduled Pinterest pin ${result.postId} on board "${result.destination.boardName}" ` +
        `via Buffer account "${result.account}"`,
    );
    return { postId: result.postId };
  },
};

/**
 * Notify. Deliberately never throws: a delivered article whose notification
 * failed is still a delivered article, and failing the run here would
 * misreport success as failure.
 */
export const notify: Step<
  { seo: SeoData; posted: PostedRecipe; pinImageUrl: string },
  { sent: boolean }
> = {
  name: 'notify',
  title: 'Send notification',
  async run(ctx, input) {
    if (!ctx.settings.getBool('telegram_enabled')) return { sent: false };

    const host = ctx.site.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const url = `https://${host}${String(input.posted.href ?? '')}`;

    const caption =
      `<b>Published</b>\n` +
      `${escapeHtml(input.seo.title)}\n\n` +
      `Site: ${escapeHtml(ctx.site.domain)}\n` +
      `Keyword: ${escapeHtml(ctx.keyword.seed_keyword)}\n` +
      `${url}`;

    const sent = input.pinImageUrl
      ? await ctx.telegram.sendPhoto(`https://${host}${input.pinImageUrl}`, caption)
      : await ctx.telegram.sendMessage(caption);

    return { sent };
  },
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
