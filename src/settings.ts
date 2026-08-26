import { getSetting, setSetting } from './db/repos.js';

/**
 * Every operator-tunable value lives here and is edited in the web UI.
 * The .env file holds only ENCRYPTION_KEY.
 */

export interface SettingSpec {
  key: string;
  label: string;
  group: 'general' | 'llm' | 'images' | 'buffer' | 'telegram' | 'schedule';
  secret: boolean;
  default: string;
  help?: string;
  type?: 'text' | 'number' | 'password' | 'textarea';
}

export const SETTING_SPECS: SettingSpec[] = [
  // -- General -------------------------------------------------------------
  {
    key: 'timezone',
    label: 'Timezone',
    group: 'general',
    secret: false,
    default: 'Africa/Algiers',
    help: 'Determines when the publishing day rolls over.',
  },
  {
    key: 'automation_enabled',
    label: 'Automation enabled',
    group: 'general',
    secret: false,
    default: 'false',
    help: 'Master switch. When off, the scheduler never starts a run.',
  },

  // -- Schedule ------------------------------------------------------------
  {
    key: 'tick_minutes',
    label: 'Check every (minutes)',
    group: 'schedule',
    secret: false,
    default: '15',
    type: 'number',
    help: 'How often to look for a publishable keyword and site pair.',
  },
  {
    key: 'retention_days',
    label: 'Keep logs for (days)',
    group: 'schedule',
    secret: false,
    default: '30',
    type: 'number',
  },

  // -- LLM -----------------------------------------------------------------
  {
    key: 'llm_base_url',
    label: 'LLM base URL',
    group: 'llm',
    secret: false,
    default: 'https://ollama.com',
    help: 'Shared by every API key. Requests go to {base URL}/api/chat.',
  },

  // -- Image generation ----------------------------------------------------
  {
    key: 'image_base_url',
    label: 'Image service URL',
    group: 'images',
    secret: false,
    default: process.env.IMAGE_BASE_URL ?? 'http://imagegen:8100',
    help:
      'Base URL of the image service. The default reaches the imagegen ' +
      'container over the internal Docker network; change it only to point at ' +
      'an instance running somewhere else.',
  },
  {
    key: 'image_api_key',
    label: 'Image service API key',
    group: 'images',
    secret: true,
    // The imagegen container reads the same value from its environment, so
    // defaulting to it here means setting it once at deploy time rather than
    // typing the same secret into two places. Still overridable in the UI.
    default: process.env.IMAGE_API_KEY ?? '',
    type: 'password',
    help: 'Sent as the X-API-Key header. Defaults to IMAGE_API_KEY from the environment.',
  },
  {
    key: 'flow_project_id',
    label: 'Flow project ID',
    group: 'images',
    secret: false,
    default: process.env.FLOW_PROJECT_ID ?? '',
    help:
      'A real project id from the Google Flow UI. It travels to Google with ' +
      'every generation as clientContext.projectId, so a made-up value makes ' +
      'each request look unlike one the Flow UI would send.',
  },
  {
    key: 'image_poll_interval_seconds',
    label: 'Image poll interval (seconds)',
    group: 'images',
    secret: false,
    default: '15',
    type: 'number',
  },
  {
    key: 'image_poll_max_attempts',
    label: 'Image poll max attempts',
    group: 'images',
    secret: false,
    default: '40',
    type: 'number',
    help: 'Bounds the polling loop. 40 attempts at 15s is a 10 minute ceiling.',
  },

  // -- Buffer --------------------------------------------------------------
  {
    key: 'buffer_enabled',
    label: 'Publish to Buffer',
    group: 'buffer',
    secret: false,
    default: 'true',
  },

  // -- Telegram ------------------------------------------------------------
  {
    key: 'telegram_bot_token',
    label: 'Telegram bot token',
    group: 'telegram',
    secret: true,
    default: '',
    type: 'password',
  },
  {
    key: 'telegram_chat_id',
    label: 'Telegram chat ID',
    group: 'telegram',
    secret: false,
    default: '',
  },
  {
    key: 'telegram_enabled',
    label: 'Send Telegram notifications',
    group: 'telegram',
    secret: false,
    default: 'false',
  },
];

const BY_KEY = new Map(SETTING_SPECS.map((s) => [s.key, s]));

export class Settings {
  constructor(private readonly encryptionKey: Buffer) {}

  get(key: string): string {
    const spec = BY_KEY.get(key);
    const stored = getSetting(key, this.encryptionKey);
    return stored !== '' ? stored : (spec?.default ?? '');
  }

  getNumber(key: string): number {
    const value = Number(this.get(key));
    if (Number.isFinite(value)) return value;
    const fallback = Number(BY_KEY.get(key)?.default ?? 0);
    return Number.isFinite(fallback) ? fallback : 0;
  }

  getBool(key: string): boolean {
    return this.get(key).toLowerCase() === 'true';
  }

  set(key: string, value: string): void {
    const spec = BY_KEY.get(key);
    setSetting(key, value, spec?.secret ?? false, this.encryptionKey);
  }

  /** True when the value is present, whether stored or defaulted. */
  has(key: string): boolean {
    return this.get(key).trim() !== '';
  }

  /** Configuration problems that would stop a run, in plain language. */
  validate(): string[] {
    const problems: string[] = [];

    if (!this.has('image_api_key')) {
      problems.push('Image service API key is not set (Settings → Images).');
    }
    if (!this.has('flow_project_id')) {
      problems.push(
        'Flow project ID is not set (Settings → Images). Images cannot be ' +
          'generated until it is: Google is sent this id with every request.',
      );
    }
    if (this.getBool('telegram_enabled') && !this.has('telegram_bot_token')) {
      problems.push('Telegram notifications are on but no bot token is set.');
    }
    if (!this.has('llm_base_url')) {
      problems.push('LLM base URL is not set (Settings → LLM).');
    }
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: this.get('timezone') });
    } catch {
      problems.push(`Timezone "${this.get('timezone')}" is not a valid IANA timezone.`);
    }

    return problems;
  }
}
