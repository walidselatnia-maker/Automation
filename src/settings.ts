import { readFileSync } from 'node:fs';
import { getSetting, setSetting } from './db/repos.js';

/**
 * Every operator-tunable value lives here and is edited in the web UI.
 * The .env file holds only ENCRYPTION_KEY.
 */

export interface SettingSpec {
  key: string;
  label: string;
  group: 'general' | 'llm' | 'images' | 'buffer' | 'telegram' | 'schedule' | 'retry';
  secret: boolean;
  default: string;
  help?: string;
  type?: 'text' | 'number' | 'password' | 'textarea';
  /**
   * Kept out of the settings page.
   *
   * The value, its default and any environment override all still work exactly
   * as before — this only stops it being rendered. These are deployment wiring
   * rather than decisions: the image service URL is always the container next
   * door, the poll numbers are a timeout nobody has ever needed to move, and a
   * field that only ever holds its default is a question the page is asking
   * for no reason.
   *
   * The save handler skips anything the form did not submit, so a hidden
   * setting cannot be blanked by saving the page.
   */
  hidden?: boolean;
}

export const SETTING_SPECS: SettingSpec[] = [
  // -- General -------------------------------------------------------------
  {
    key: 'timezone',
    label: 'Timezone',
    group: 'general',
    secret: false,
    hidden: true,
    default: process.env.TZ?.trim() || 'Africa/Algiers',
    help: 'Determines when the publishing day rolls over. Set TZ to change it.',
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

  // -- Retries -------------------------------------------------------------
  {
    key: 'auto_retry_enabled',
    label: 'Retry failed runs automatically',
    group: 'retry',
    secret: false,
    default: 'true',
    help:
      'Only failures that look transient — a rate limit, a timeout, the image ' +
      'service restarting. A wrong token or a rejected article is left for you, ' +
      'because retrying it produces the identical error.',
  },
  {
    key: 'auto_retry_max',
    label: 'Automatic attempts',
    group: 'retry',
    secret: false,
    default: '1',
    type: 'number',
    help: 'After this many, the run waits for you. Each attempt reuses every completed step.',
  },
  {
    key: 'auto_retry_delay_minutes',
    label: 'Wait before retrying (minutes)',
    group: 'retry',
    secret: false,
    default: '15',
    type: 'number',
    help: 'Doubled on each further attempt, so a service that is properly down is left alone.',
  },

  // -- LLM -----------------------------------------------------------------
  {
    key: 'llm_base_url',
    label: 'LLM base URL',
    group: 'llm',
    secret: false,
    hidden: true,
    default: process.env.LLM_BASE_URL?.trim() || 'https://ollama.com',
    help: 'Shared by every API key. Requests go to {base URL}/api/chat.',
  },

  // -- Image generation ----------------------------------------------------
  {
    key: 'image_base_url',
    label: 'Image service URL',
    group: 'images',
    secret: false,
    hidden: true,
    default: process.env.IMAGE_BASE_URL ?? 'http://imagegen:8100',
    help:
      'Base URL of the image service. The default reaches the imagegen ' +
      'container over the internal Docker network; change it only to point at ' +
      'an instance running somewhere else.',
  },
  {
    key: 'flow_project_id',
    label: 'Flow project ID',
    group: 'images',
    secret: false,
    default: process.env.FLOW_PROJECT_ID ?? '',
    help:
      'A real project id from the Google Flow UI, used by any site that has no ' +
      'project of its own. The ID on a site wins; this is the fallback. It ' +
      'travels to Google as clientContext.projectId on every generation.',
  },
  {
    key: 'image_poll_interval_seconds',
    label: 'Image poll interval (seconds)',
    group: 'images',
    secret: false,
    hidden: true,
    default: '15',
    type: 'number',
  },
  {
    key: 'image_poll_max_attempts',
    label: 'Image poll max attempts',
    group: 'images',
    secret: false,
    hidden: true,
    default: '40',
    type: 'number',
    help: 'Bounds the polling loop. 40 attempts at 15s is a 10 minute ceiling.',
  },

  {
    key: 'run_step_timeout_minutes',
    label: 'Step timeout (minutes)',
    group: 'schedule',
    secret: false,
    default: '8',
    type: 'number',
    help:
      'A step that returns nothing for this long is treated as hung: the run fails ' +
      'with a clear reason and the lock is released, rather than sitting there. ' +
      'Deliberately under the run timeout, so the failure names the step that hung ' +
      'rather than the run that contained it.',
  },
  {
    key: 'run_timeout_minutes',
    label: 'Run timeout (minutes)',
    group: 'schedule',
    secret: false,
    default: '10',
    type: 'number',
    help:
      'The backstop for a run that keeps moving but never finishes. Counted from ' +
      'the first step, and it stops the run wherever it is. Ten because runs on ' +
      'this platform take four to six minutes; raise it if that changes.',
  },

  // -- Buffer --------------------------------------------------------------
  {
    key: 'buffer_enabled',
    label: 'Publish to Buffer',
    group: 'buffer',
    secret: false,
    default: 'true',
  },
  {
    key: 'buffer_hold_hours',
    label: 'Hold a site for (hours) when every Buffer account is full',
    group: 'buffer',
    secret: false,
    default: '12',
    type: 'number',
    help:
      'A site with no account left to try is paused for this long rather than ' +
      'failing. When the pause lifts, the same article resumes and posts its pin ' +
      'before the site takes on anything new.',
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
    help:
      'Sent when something changes state and needs you: the queue running out, ' +
      'a site failing repeatedly, image generation down, articles waiting for ' +
      'approval. Each is sent once, and again when it recovers.',
  },
];

const BY_KEY = new Map(SETTING_SPECS.map((s) => [s.key, s]));

/**
 * The API key shared with the image service.
 *
 * The two containers must agree on it, and asking someone to invent a secret
 * and paste it into two places is the kind of setup step that gets skipped or
 * mistyped. So imagegen generates one on first boot into a volume mounted by
 * both, and this reads it.
 *
 * Read on each call rather than cached: the containers start together, and the
 * platform may well look before imagegen has written. Re-reading means it
 * simply starts working a moment later instead of needing a restart.
 */
const SHARED_KEY_PATH = process.env.SHARED_SECRET_PATH ?? '/run/shared/image-api-key';

function sharedImageApiKey(): string {
  try {
    return readFileSync(SHARED_KEY_PATH, 'utf8').trim();
  } catch {
    // Absent is normal: not deployed with the shared volume, or imagegen has
    // not booted yet.
    return '';
  }
}

/**
 * The key the two containers authenticate with.
 *
 * Not a setting, and no longer a field on the settings page. It was one back
 * when the image service was a separate project that had to be wired up by
 * hand; now they ship together, imagegen generates the key into a volume both
 * containers mount, and the platform reads it. Nobody types it, and a box
 * inviting them to is a way to break a working deployment.
 *
 * The environment still wins, because deploying the two halves on different
 * hosts means no shared volume and the key has to come from somewhere.
 *
 * Any stored value from when this was editable is deliberately ignored: the
 * generated one is what imagegen actually checks against, so preferring it
 * repairs a mismatch instead of preserving one.
 */
function imageApiKey(): string {
  return (process.env.IMAGE_API_KEY ?? '').trim() || sharedImageApiKey();
}

export class Settings {
  constructor(private readonly encryptionKey: Buffer) {}

  get(key: string): string {
    // Resolved from the deployment, never from the settings table — see
    // imageApiKey above.
    if (key === 'image_api_key') return imageApiKey();

    const stored = getSetting(key, this.encryptionKey);
    if (stored !== '') return stored;

    return BY_KEY.get(key)?.default ?? '';
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
      problems.push(
        'Image service API key is missing. The image service writes it into a volume both ' +
          'containers mount, so this normally sorts itself out within a minute of a deploy. ' +
          'If it persists, check the shared-secret volume is mounted, or set IMAGE_API_KEY ' +
          'in the deployment environment.',
      );
    }
    if (!this.has('flow_project_id')) {
      problems.push(
        'No shared Flow project ID (Settings → Images). Sites without one of ' +
          'their own will generate into a placeholder project, which is not a ' +
          'real project on the Google side.',
      );
    }
    if (this.getBool('telegram_enabled') && !this.has('telegram_bot_token')) {
      problems.push('Telegram notifications are on but no bot token is set.');
    }
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: this.get('timezone') });
    } catch {
      problems.push(
        `Timezone "${this.get('timezone')}" is not a valid IANA timezone. ` +
          'It comes from the TZ environment variable.',
      );
    }

    return problems;
  }
}
