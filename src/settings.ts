import { readFileSync } from 'node:fs';
import { getSetting, setSetting } from './db/repos.js';

/**
 * Every operator-tunable value lives here and is edited in the web UI.
 * The .env file holds only ENCRYPTION_KEY.
 */

export interface SettingSpec {
  key: string;
  label: string;
  group:
    | 'general'
    | 'reels'
    | 'llm'
    | 'images'
    | 'buffer'
    | 'facebook'
    | 'telegram'
    | 'schedule'
    | 'retry';
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
    help:
      'The main switch. On: the platform publishes by itself, following each ' +
      'site\'s daily target and gap between posts. Off: nothing starts on its own. ' +
      'You can still run one article by hand from Home.',
  },

  // -- Schedule ------------------------------------------------------------
  {
    key: 'tick_minutes',
    label: 'Check every (minutes)',
    group: 'schedule',
    secret: false,
    default: '15',
    type: 'number',
    help:
      'How often the platform looks for something to publish. 1 to 5 minutes is ' +
      'fine. A site never posts more often than its own gap between posts, ' +
      'whatever you put here.',
  },
  {
    key: 'retention_days',
    label: 'Keep logs for (days)',
    group: 'schedule',
    secret: false,
    default: '30',
    type: 'number',
    help:
      'How long to keep the decision and event history before old entries are ' +
      'deleted. This never affects what gets published.',
  },

  // -- Retries -------------------------------------------------------------
  {
    key: 'auto_retry_enabled',
    label: 'Retry failed runs automatically',
    group: 'retry',
    secret: false,
    default: 'true',
    help:
      'When a run fails because of a temporary problem (a busy service, a ' +
      'timeout, image generation restarting), try again by itself. Problems that ' +
      'would fail the same way again, like a wrong token or an article the site ' +
      'refuses, are left for you.',
  },
  {
    key: 'auto_retry_max',
    label: 'Automatic attempts',
    group: 'retry',
    secret: false,
    default: '1',
    type: 'number',
    help:
      'How many automatic tries before the run stops and waits for you. Each try ' +
      'continues from where it failed; finished steps are not repeated.',
  },
  {
    key: 'auto_retry_delay_minutes',
    label: 'Wait before retrying (minutes)',
    group: 'retry',
    secret: false,
    default: '15',
    type: 'number',
    help:
      'How long to wait before the first retry. Each further retry waits twice as ' +
      'long.',
  },

  {
    key: 'pair_failure_limit',
    label: 'Hold a keyword back after (failures on one site)',
    group: 'retry',
    secret: false,
    default: '3',
    type: 'number',
    help:
      'If the same keyword keeps failing on the same site, stop offering it after ' +
      'this many failures and flag it on the keyword page for you. Temporary ' +
      'problems do not count. 0 never holds anything back.',
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
      'The Google Flow project that images are generated into, for any site that ' +
      'has no project of its own. Copy it from the address bar of the project in ' +
      'Flow: the long code after /project/.',
  },
  {
    // Rendered by the images group's footer rather than as a plain input, so
    // the page can show what Google last said to each model beside the choice.
    // Still a setting: the form submits it under this key and the save handler
    // stores it like any other.
    key: 'image_model',
    label: 'Image model',
    group: 'images',
    secret: false,
    hidden: true,
    default: 'auto',
  },
  {
    key: 'image_gap_seconds',
    label: 'Pause between images (seconds)',
    group: 'images',
    secret: false,
    default: '30',
    type: 'number',
    help:
      'A short pause between one image and the next. Several images back to back ' +
      'can make Google treat the session as automated. 30 seconds is a safe ' +
      'default; raise it if runs keep failing at the third or fourth image.',
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
      'If one step (writing the article, generating an image, posting) makes no ' +
      'progress for this long, the run is stopped and marked failed so it does ' +
      'not block everything else. 8 minutes is enough for the slowest normal ' +
      'step.',
  },
  {
    key: 'run_timeout_minutes',
    label: 'Run timeout (minutes)',
    group: 'schedule',
    secret: false,
    default: '10',
    type: 'number',
    help:
      'The longest a whole run may take before it is stopped. Normal runs take 4 ' +
      'to 6 minutes.',
  },

  // -- Buffer --------------------------------------------------------------
  {
    key: 'fb_enabled',
    label: 'Publish reels to Facebook',
    group: 'facebook',
    secret: false,
    default: 'false',
    help:
      'On: every published article becomes a reel on the Facebook page assigned ' +
      'to its niche (Channels → Facebook). Off: nothing is posted to Facebook.',
  },

  // -- Reels -----------------------------------------------------------------
  // Shown on their own page (Setup → Reels) rather than in the general form:
  // the formats are a set of checkboxes, not a field.
  {
    key: 'reel_mode',
    label: 'How a reel is made',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'single',
    help:
      'single: one clip from one prompt and up to three of the article\u2019s photos. ' +
      'scenes: a storyboard of ten-second scenes, filmed one by one and joined.',
  },
  {
    key: 'reel_single_references',
    label: 'Photos sent with a single-clip reel',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '["feature","topShot","textureMacro"]',
  },
  {
    key: 'reel_length_seconds',
    label: 'Reel length (seconds)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '30',
    type: 'number',
    help:
      'How long a reel is. 30 seconds is three scenes; 60 is six. Longer costs more ' +
      'video credits per article.',
  },
  {
    key: 'reel_formats',
    label: 'Formats',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '["reveal","taste-test","three-things","mistake","pov","before-after","secret","countdown","myth","asmr","time-trap","first-bite","story"]',
  },
  {
    key: 'reel_fresh_images',
    label: 'Make a fresh image for every scene',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'false',
    help:
      "Off: scenes are filmed from the article's own images, which costs nothing " +
      'extra. On: a new image is made for every scene first.',
  },
  {
    key: 'reel_cta_text',
    label: 'Call to action',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'Full recipe in the comments',
    help: 'The last thing every reel says and shows. The article link goes in the first comment.',
  },
  {
    key: 'reel_publisher',
    label: 'Where reels are published',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'facebook',
    help:
      'facebook: the platform uploads the video to the page itself. buffer: the ' +
      'video is handed to Buffer, which posts it on its own schedule to the ' +
      'channel the page names.',
  },
  {
    key: 'reel_buffer_token',
    label: 'Buffer token for reels',
    group: 'reels',
    secret: true,
    hidden: true,
    default: '',
    help:
      'The Buffer account whose channels the pages post to. Separate from the ' +
      'per-site tokens that schedule pins: those belong to a site, and a reel ' +
      'belongs to a page.',
  },
  {
    key: 'public_base_url',
    label: 'Public address of this platform',
    group: 'reels',
    secret: false,
    hidden: true,
    default: process.env.PUBLIC_BASE_URL?.trim() ?? '',
    help:
      'Where this platform answers from on the open internet, like ' +
      'https://reels.example.com. Buffer fetches a reel video from here when ' +
      'the queued post goes out, so it has to be an address Buffer can reach. ' +
      'Left blank, the video is copied to the site instead.',
  },
  {
    key: 'reel_media_link_days',
    label: 'How long a reel video link lasts',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '14',
    help:
      'A link has to outlive the Buffer queue it is waiting in. Too short and ' +
      'the post goes out with nothing to publish; there is no cost to it being ' +
      'generous, because the link points at one video and nothing else.',
  },
  {
    key: 'reel_buffer_link_in_text',
    label: 'Put the article link in the reel text',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'true',
    help:
      'Buffer posts on its own later, so nothing here can add a first comment ' +
      'the way publishing to the page directly does. On: the link goes at the ' +
      'end of the caption instead, which is the only place left for it.',
  },
  {
    key: 'buffer_enabled',
    label: 'Publish to Buffer',
    group: 'buffer',
    secret: false,
    default: 'true',
    help:
      'On: after each article, a Pinterest pin is scheduled through the site\'s ' +
      'Buffer account. Off: articles are published without a pin.',
  },
  {
    key: 'buffer_hold_hours',
    label: 'Hold a site for (hours) when every Buffer account is full',
    group: 'buffer',
    secret: false,
    default: '12',
    type: 'number',
    help:
      'If every Buffer account on a site is full for the day, wait this long ' +
      'before trying that site again. The article stays published; only the pin ' +
      'waits.',
  },

  // -- Telegram ------------------------------------------------------------
  {
    key: 'telegram_bot_token',
    label: 'Telegram bot token',
    group: 'telegram',
    secret: true,
    default: '',
    type: 'password',
    help:
      'Create a bot with @BotFather in Telegram and paste the token it gives you.',
  },
  {
    key: 'telegram_chat_id',
    label: 'Telegram chat ID',
    group: 'telegram',
    secret: false,
    default: '',
    help:
      'The chat or group that receives the messages. Add the bot to it, send it a ' +
      'message, then ask @userinfobot for the id.',
  },
  {
    key: 'telegram_enabled',
    label: 'Send Telegram notifications',
    group: 'telegram',
    secret: false,
    default: 'false',
    help:
      'Get a message when something needs you: keywords running out, a site ' +
      'failing repeatedly, image generation down, an article waiting for ' +
      'approval. One message when it starts, one when it is fixed.',
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
    // Google replaced Nano Banana 2 with 2.1 on 2026-10-10; a pick saved
    // before then means 2.1.
    if (key === 'image_model' && stored === 'NANO_BANANA_2') return 'NANO_BANANA_2_1';
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
