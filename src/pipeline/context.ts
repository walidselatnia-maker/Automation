import type { Settings } from '../settings.js';
import { BufferPool } from '../integrations/buffer-pool.js';
import { ImageClient } from '../integrations/images.js';
import { resolveProjectId, type ResolvedProjectId } from '../core/project-id.js';
import { SiteApiClient } from '../integrations/site-api.js';
import { TelegramClient } from '../integrations/telegram.js';
import type { ChatResult } from '../llm/client.js';
import { askPrompt } from '../llm/ask.js';
import {
  clearSharedImages,
  getSharedImages,
  saveSharedImages,
  siteSecrets,
  type SharedImageUrls,
  type SiteRow,
  type KeywordRow,
} from '../db/repos.js';

/**
 * Where a keyword's already-generated article images are recorded.
 *
 * Behind an interface for the same reason the API clients are: a step should
 * be testable without a database standing behind it.
 */
export interface SharedImageStore {
  get(keywordId: number): SharedImageUrls | undefined;
  save(keywordId: number, sourceSiteId: number, urls: SharedImageUrls): void;
  clear(keywordId: number): void;
}

const databaseImageStore: SharedImageStore = {
  get: getSharedImages,
  save: saveSharedImages,
  clear: clearSharedImages,
};

/**
 * Everything a pipeline step is allowed to touch.
 *
 * Steps receive this rather than importing clients directly, which keeps them
 * individually testable with fakes and makes their dependencies explicit.
 */
export interface StepUsage {
  tokensIn: number;
  tokensOut: number;
  images: number;
}

export class PipelineContext {
  readonly site: SiteRow;
  readonly keyword: KeywordRow;
  readonly runId: number;
  readonly settings: Settings;
  readonly encryptionKey: Buffer;
  readonly allowResume: boolean;

  /**
   * A dry run executes everything and stops before publishing.
   *
   * The point is prompt work: the only way to see what a prompt change does
   * used to be to publish it to a live site.
   */
  readonly mode: 'live' | 'dry';

  /**
   * This run has already been through the gate.
   *
   * Set when a held run is resumed. Without it, resuming an approved article
   * on a site with auto-publish off hits holdReason again — the site setting
   * has not changed — and the article is held a second time, so approval never
   * publishes anything.
   */
  readonly approved: boolean;

  /** Whether this keyword-site link reuses images rather than generating them. */
  readonly shareImages: boolean;
  readonly sharedImages: SharedImageStore;

  /** Which Flow project this run generates into, and how that was decided. */
  readonly projectId: ResolvedProjectId;

  readonly siteApi: SiteApiClient;
  readonly images: ImageClient;

  /**
   * The pause between one image generation and the next, in milliseconds.
   *
   * Kept on the run rather than inside ImageClient because the client only
   * sees one request at a time; the thing being spaced is the sequence of
   * them across steps, and the pin graphic minutes later is part of it.
   * `lastImageGeneratedAt` is when the previous one came back, so the wait is
   * only what remains of the gap -- time spent writing the article counts.
   */
  readonly imageGapMs: number;
  lastImageGeneratedAt: number | null = null;
  now: () => number = () => Date.now();
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  readonly buffer: BufferPool;
  readonly telegram: TelegramClient;

  constructor(init: {
    runId: number;
    site: SiteRow;
    keyword: KeywordRow;
    settings: Settings;
    encryptionKey: Buffer;
    allowResume?: boolean;
    shareImages?: boolean;
    sharedImages?: SharedImageStore;
    mode?: 'live' | 'dry';
    approved?: boolean;
  }) {
    this.runId = init.runId;
    this.site = init.site;
    this.keyword = init.keyword;
    this.settings = init.settings;
    this.encryptionKey = init.encryptionKey;
    this.allowResume = init.allowResume ?? true;
    this.mode = init.mode ?? 'live';
    this.approved = init.approved ?? false;
    this.shareImages = init.shareImages ?? false;
    this.sharedImages = init.sharedImages ?? databaseImageStore;

    // Credentials are per site: each domain has its own publishing token and
    // its own Buffer account.
    const secrets = siteSecrets(init.site, init.encryptionKey);
    this.siteApi = new SiteApiClient(init.site.domain, secrets.apiToken);

    // Resolved here, once per run, so every image in an article goes into the
    // same project and the run log can say which one and why.
    this.projectId = resolveProjectId(
      init.site.project_id,
      init.settings.get('flow_project_id'),
      init.site.domain,
    );

    this.imageGapMs = Math.max(0, init.settings.getNumber('image_gap_seconds')) * 1000;

    this.images = new ImageClient({
      baseUrl: init.settings.get('image_base_url'),
      apiKey: init.settings.get('image_api_key'),
      pollIntervalMs: init.settings.getNumber('image_poll_interval_seconds') * 1000,
      maxAttempts: init.settings.getNumber('image_poll_max_attempts'),
      projectId: this.projectId.projectId,
      imageModel: init.settings.get('image_model'),
    });

    // A pool rather than a client: when one account's queue fills, the run
    // moves to this site's next account instead of failing at the last step.
    // A site with one account behaves exactly as it did before.
    this.buffer = new BufferPool(
      { id: init.site.id, domain: init.site.domain, pinUsername: init.site.pin_username },
      init.encryptionKey,
      secrets.bufferToken,
    );

    this.telegram = new TelegramClient(
      init.settings.get('telegram_bot_token'),
      init.settings.get('telegram_chat_id'),
    );
  }

  /* -- What the current step has cost so far --------------------------- */

  /**
   * Tokens and images spent since the engine last reset this.
   *
   * Accumulated on the context rather than returned from each call because a
   * step makes several — generate-article alone makes three, sometimes six
   * with the fallbacks — and threading a running total back out through every
   * helper would put accounting into code that should only be about articles.
   */
  private usage: StepUsage = { tokensIn: 0, tokensOut: 0, images: 0 };

  resetUsage(): void {
    this.usage = { tokensIn: 0, tokensOut: 0, images: 0 };
  }

  /** Read the accumulated usage and start a fresh count. */
  takeUsage(): StepUsage {
    const spent = this.usage;
    this.resetUsage();
    return spent;
  }

  /** Record images generated by this step, for the run's usage summary. */
  countImages(n: number): void {
    this.usage.images += Math.max(0, n);
  }

  /**
   * Run a named prompt through the LLM pool.
   *
   * `promptName` matches the extracted prompt files. The format comes from
   * PROMPT_MODELS so the call matches what the prompt was authored for; the
   * model comes from modelFor, which is that default unless overridden.
   */
  async prompt(
    promptName: string,
    variables: Record<string, unknown>,
    overrides: { model?: string; format?: 'json' | null } = {},
  ): Promise<ChatResult> {
    const result = await askPrompt(this.settings, this.encryptionKey, promptName, variables, overrides);

    this.usage.tokensIn += result.tokensIn;
    this.usage.tokensOut += result.tokensOut;

    return result;
  }
}
