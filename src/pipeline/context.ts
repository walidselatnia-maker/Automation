import type { Settings } from '../settings.js';
import { BufferClient } from '../integrations/buffer.js';
import { ImageClient } from '../integrations/images.js';
import { SiteApiClient } from '../integrations/site-api.js';
import { TelegramClient } from '../integrations/telegram.js';
import { chat, type ChatResult } from '../llm/client.js';
import { loadPrompt, PROMPT_MODELS } from './prompts.js';
import { siteSecrets, type SiteRow, type KeywordRow } from '../db/repos.js';

/**
 * Everything a pipeline step is allowed to touch.
 *
 * Steps receive this rather than importing clients directly, which keeps them
 * individually testable with fakes and makes their dependencies explicit.
 */
export class PipelineContext {
  readonly site: SiteRow;
  readonly keyword: KeywordRow;
  readonly runId: number;
  readonly settings: Settings;
  readonly encryptionKey: Buffer;
  readonly allowResume: boolean;

  readonly siteApi: SiteApiClient;
  readonly images: ImageClient;
  readonly buffer: BufferClient;
  readonly telegram: TelegramClient;

  constructor(init: {
    runId: number;
    site: SiteRow;
    keyword: KeywordRow;
    settings: Settings;
    encryptionKey: Buffer;
    allowResume?: boolean;
  }) {
    this.runId = init.runId;
    this.site = init.site;
    this.keyword = init.keyword;
    this.settings = init.settings;
    this.encryptionKey = init.encryptionKey;
    this.allowResume = init.allowResume ?? true;

    // Credentials are per site: each domain has its own publishing token and
    // its own Buffer account.
    const secrets = siteSecrets(init.site, init.encryptionKey);
    this.siteApi = new SiteApiClient(init.site.domain, secrets.apiToken);

    this.images = new ImageClient({
      baseUrl: init.settings.get('image_base_url'),
      apiKey: init.settings.get('image_api_key'),
      pollIntervalMs: init.settings.getNumber('image_poll_interval_seconds') * 1000,
      maxAttempts: init.settings.getNumber('image_poll_max_attempts'),
    });

    this.buffer = new BufferClient(secrets.bufferToken);

    this.telegram = new TelegramClient(
      init.settings.get('telegram_bot_token'),
      init.settings.get('telegram_chat_id'),
    );
  }

  /**
   * Run a named prompt through the LLM pool.
   *
   * `promptName` matches the extracted prompt files. The model and format come
   * from PROMPT_MODELS so the call matches what the prompt was authored for.
   */
  async prompt(
    promptName: string,
    variables: Record<string, unknown>,
    overrides: { model?: string; format?: 'json' | null } = {},
  ): Promise<ChatResult> {
    const spec = PROMPT_MODELS[promptName];
    const { system, user } = loadPrompt(promptName, variables);

    const messages = system.trim()
      ? ([
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: user },
        ])
      : [{ role: 'user' as const, content: user }];

    return chat(
      {
        model: overrides.model ?? spec?.model ?? 'gemma4:31b',
        messages,
        format: overrides.format !== undefined ? overrides.format : (spec?.format ?? null),
      },
      this.encryptionKey,
      this.settings.get('llm_base_url'),
    );
  }
}
