import { SETTING_SPECS } from '../settings.js';
import { KNOWN_MODELS } from '../pipeline/prompts.js';
import { publicBaseUrlProblem } from '../core/media-links.js';
import { flowProjectProblem } from '../core/project-id.js';

/**
 * Platform setup for the new dashboard.
 *
 * These are the platform's own settings, shared with the old dashboard (one
 * AI connection, one timezone, one automation switch for the installation).
 * This file decides what a good value is; the routes save it.
 */

/** Set once the platform setup has been saved in the new dashboard. */
export const SETUP_DONE_KEY = 'newsite_platform_setup_done';

export const IMAGE_MODELS = [
  { value: 'auto', label: 'Automatic: Pro first, then the others as fallbacks' },
  { value: 'NANO_BANANA_PRO', label: 'Nano Banana Pro' },
  { value: 'NANO_BANANA_2_1', label: 'Nano Banana 2.1' },
  { value: 'NANO_BANANA_2_LITE', label: 'Nano Banana 2 Lite' },
] as const;

/** The AI models the prompts are written for, offered as ticks on each key. */
export const AI_MODELS: string[] = KNOWN_MODELS;

/** Whole-number settings and the range each may take. */
export const NUMBER_RANGES: Record<string, [number, number]> = {
  auto_retry_max: [0, 10],
  auto_retry_delay_minutes: [0, 1440],
  image_gap_seconds: [0, 600],
};

const SWITCHES = ['auto_retry_enabled', 'telegram_enabled'];

export const AUTOMATION_KEYS = ['auto_retry_enabled', 'auto_retry_max', 'auto_retry_delay_minutes'];

/** The fields on each step. The AI step's key list is handled on its own. */
export const PLATFORM_STEPS: string[][] = [
  ['llm_base_url', 'newKeyName', 'newKeyValue', 'newKeyModels', 'removeKeys', 'bulkKeys'],
  ['timezone'],
  AUTOMATION_KEYS,
  ['flow_project_id', 'image_model', 'image_gap_seconds', 'public_base_url'],
  ['telegram_enabled', 'telegram_bot_token', 'telegram_chat_id'],
  [],
];

export const spec = (key: string) => SETTING_SPECS.find((s) => s.key === key);

export const TIMEZONES: string[] = (() => {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (list?.length) return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    /* older runtime: fall through */
  }
  return ['UTC', 'Africa/Algiers', 'Europe/London', 'Europe/Paris', 'America/New_York'];
})();

export interface KeySummary {
  id: number;
  name: string;
}

export interface PlatformContext {
  keys: KeySummary[];
  /** A Telegram token is already saved, so an empty field keeps it. */
  hasTelegramToken: boolean;
}

export type PlatformErrors = Record<string, string>;

export interface NewKey {
  name: string;
  apiKey: string;
  models: string[];
}

export interface PlatformClean {
  settings: Record<string, string>;
  newKey?: NewKey;
  /** Keys pasted many at once, named, sharing the ticked models. */
  bulkKeys: NewKey[];
  removeKeyIds: number[];
}

const str = (raw: Record<string, unknown>, key: string): string =>
  typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';

/** "https://Ollama.com/" -> "https://ollama.com". Null when it is not a web address. */
export function normalizeBaseUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.search || url.hash) return null;
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const idList = (value: string): number[] =>
  value
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

/** Check the fields of the given steps (all when none are named). */
export function validatePlatform(
  raw: Record<string, unknown>,
  ctx: PlatformContext,
  steps?: number[],
): { errors: PlatformErrors; clean: PlatformClean } {
  const fields = (steps ?? PLATFORM_STEPS.map((_, i) => i)).flatMap((i) => PLATFORM_STEPS[i] ?? []);
  const errors: PlatformErrors = {};
  const clean: PlatformClean = { settings: {}, bulkKeys: [], removeKeyIds: [] };
  const want = (f: string) => fields.includes(f);

  if (want('llm_base_url')) {
    const url = normalizeBaseUrl(str(raw, 'llm_base_url'));
    if (!url) errors.llm_base_url = 'Enter the AI provider address, like https://ollama.com.';
    else clean.settings.llm_base_url = url;
  }

  if (want('newKeyValue')) {
    const known = new Set(ctx.keys.map((k) => k.id));
    clean.removeKeyIds = idList(str(raw, 'removeKeys')).filter((id) => known.has(id));
    const name = str(raw, 'newKeyName').replace(/\s+/g, ' ');
    const apiKey = str(raw, 'newKeyValue');
    const models = str(raw, 'newKeyModels').split(',').map((m) => m.trim()).filter(Boolean);

    if (name || apiKey) {
      const kept = ctx.keys.filter((k) => !clean.removeKeyIds.includes(k.id));
      if (!name || name.length > 40 || /[<>{}\u0000-\u001f]/.test(name)) {
        errors.newKeyName = 'Give the key a short name (up to 40 characters), like "Main key".';
      } else if (kept.some((k) => k.name.toLowerCase() === name.toLowerCase())) {
        errors.newKeyName = 'A key with this name already exists.';
      }
      if (!apiKey) errors.newKeyValue = 'Paste the API key.';
      else if (!/^\S{8,300}$/.test(apiKey)) errors.newKeyValue = 'That does not look like an API key: no spaces, at least 8 characters.';
      const unknown = models.filter((m) => !AI_MODELS.includes(m));
      if (models.length === 0 || unknown.length) errors.newKeyModels = 'Tick at least one model this key can run.';
      if (!errors.newKeyName && !errors.newKeyValue && !errors.newKeyModels) clean.newKey = { name, apiKey, models };
    }

    const pasted = parseBulkKeys(str(raw, 'bulkKeys'), [
      ...ctx.keys.filter((k) => !clean.removeKeyIds.includes(k.id)).map((k) => k.name),
      ...(name ? [name] : []),
    ]);
    if (pasted.problems.length) errors.bulkKeys = pasted.problems.join(' ');
    else if (pasted.keys.length) {
      if (models.length === 0 || models.some((m) => !AI_MODELS.includes(m))) errors.newKeyModels = 'Tick at least one model these keys can run.';
      else clean.bulkKeys = pasted.keys.map((k) => ({ ...k, models }));
    }

    const remaining = ctx.keys.length - clean.removeKeyIds.length + (clean.newKey || errors.newKeyValue ? 1 : 0) + pasted.keys.length;
    if (remaining <= 0 && !errors.newKeyValue && !errors.newKeyName && !errors.newKeyModels) {
      errors.newKeyValue = 'Add at least one AI key. Nothing can be written without it.';
    }
  }

  if (want('timezone')) {
    const tz = str(raw, 'timezone');
    if (!TIMEZONES.includes(tz)) errors.timezone = 'Pick a timezone from the list.';
    else clean.settings.timezone = tz;
  }

  for (const key of SWITCHES) {
    if (!want(key)) continue;
    const v = str(raw, key);
    if (v !== 'true' && v !== 'false') errors[key] = 'Choose on or off.';
    else clean.settings[key] = v;
  }

  for (const [key, [min, max]] of Object.entries(NUMBER_RANGES)) {
    if (!want(key)) continue;
    const v = str(raw, key);
    if (!/^\d{1,5}$/.test(v) || Number(v) < min || Number(v) > max) {
      errors[key] = `Enter a whole number from ${min} to ${max}.`;
    } else clean.settings[key] = String(Number(v));
  }

  if (want('public_base_url')) {
    const v = str(raw, 'public_base_url').replace(/\/+$/, '');
    const problem = publicBaseUrlProblem(v);
    if (problem) errors.public_base_url = problem;
    else clean.settings.public_base_url = v;
  }

  if (want('flow_project_id')) {
    const v = str(raw, 'flow_project_id');
    const problem = flowProjectProblem(v);
    if (problem) errors.flow_project_id = problem;
    else clean.settings.flow_project_id = v;
  }
  if (want('image_model')) {
    const v = str(raw, 'image_model');
    if (!IMAGE_MODELS.some((m) => m.value === v)) errors.image_model = 'Pick an image model.';
    else clean.settings.image_model = v;
  }

  if (want('telegram_bot_token')) {
    const on = str(raw, 'telegram_enabled') === 'true';
    const token = str(raw, 'telegram_bot_token');
    const chat = str(raw, 'telegram_chat_id');
    if (token && !/^\d{5,12}:[A-Za-z0-9_-]{30,50}$/.test(token)) {
      errors.telegram_bot_token = 'That does not look like a bot token. It looks like 123456789:ABC… and comes from @BotFather.';
    } else if (on && !token && !ctx.hasTelegramToken) {
      errors.telegram_bot_token = 'Notifications are on, so paste the bot token.';
    } else if (token) clean.settings.telegram_bot_token = token;

    if (chat && !/^(-?\d{3,20}|@[A-Za-z0-9_]{5,32})$/.test(chat)) {
      errors.telegram_chat_id = 'A chat ID is a number (groups start with -100) or @channelname.';
    } else if (on && !chat) {
      errors.telegram_chat_id = 'Notifications are on, so enter the chat ID.';
    } else clean.settings.telegram_chat_id = chat;
  }

  return { errors, clean };
}

/**
 * Keys pasted many at once, one per line: a bare key, or "name = key" (a comma
 * works too). Unnamed keys get "Key 01", "Key 02"…, carrying on after names
 * already taken; a key pasted twice is kept once.
 */
export function parseBulkKeys(text: string, taken: string[]): { keys: { name: string; apiKey: string }[]; problems: string[] } {
  const names = new Set(taken.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const keys: { name: string; apiKey: string }[] = [];
  const problems: string[] = [];
  const pending: { line: number; apiKey: string }[] = [];
  text.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const named = /^(.+?)\s*[=,]\s*(\S+)$/.exec(line);
    const name = named ? named[1]!.trim().replace(/\s+/g, ' ') : '';
    const apiKey = named ? named[2]! : line;
    if (!/^\S{8,300}$/.test(apiKey)) return void problems.push(`Line ${i + 1} does not look like an API key (no spaces, at least 8 characters).`);
    if (seen.has(apiKey)) return;
    seen.add(apiKey);
    if (!name) return void pending.push({ line: i + 1, apiKey });
    if (name.length > 40 || /[<>{}\u0000-\u001f]/.test(name)) return void problems.push(`Line ${i + 1}: keep the name under 40 characters.`);
    if (names.has(name.toLowerCase())) return void problems.push(`Line ${i + 1}: a key named "${name}" already exists.`);
    names.add(name.toLowerCase());
    keys.push({ name, apiKey });
  });
  let n = 0;
  for (const p of pending) {
    let name: string;
    do name = `Key ${String(++n).padStart(2, '0')}`;
    while (names.has(name.toLowerCase()));
    names.add(name.toLowerCase());
    keys.push({ name, apiKey: p.apiKey });
  }
  return { keys, problems };
}

/* -- Live checks ----------------------------------------------------------- */

export type Fetch = typeof fetch;

/** One tiny request per model, so a key that cannot run a model is caught now. */
export async function testAiKey(
  baseUrl: string,
  apiKey: string,
  models: string[],
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  for (const model of models) {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'Reply with the word OK.' }] }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      return `Could not reach ${baseUrl}. Check the provider address.`;
    }
    if (response.status === 401 || response.status === 403) return 'The AI provider rejected this key.';
    if (response.status === 404) return `This key cannot run ${model}. Untick it, or use a key that can.`;
    if (response.status === 429) return `The key works but is out of quota right now (HTTP 429) for ${model}. Try again later.`;
    if (!response.ok) return `The AI provider answered with an error (HTTP ${response.status}) for ${model}.`;
    const body = (await response.json().catch(() => null)) as { message?: { content?: string }; error?: string } | null;
    if (body?.error) return `${model}: ${body.error}`;
    if (!body?.message?.content?.trim()) return `${model} answered with nothing. Try again.`;
  }
  return null;
}

/** Sends a real message, and says what Telegram answered when it fails. */
export async function testTelegram(token: string, chatId: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: 'Test from the Article Platform: notifications work.' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return null;
    const body = (await response.json().catch(() => null)) as { description?: string } | null;
    if (response.status === 401) return 'Telegram rejected the bot token.';
    return `Telegram said: ${body?.description ?? `HTTP ${response.status}`}`;
  } catch {
    return 'Could not reach Telegram.';
  }
}

/** Whether the image service answers. It is set up by the deployment, so this only reports. */
export async function checkImageService(baseUrl: string, apiKey: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) return 'No image service address is configured in the deployment.';
  if (!apiKey) return 'The image service key is missing. It comes from the deployment (shared volume or IMAGE_API_KEY).';
  try {
    const response = await fetchImpl(`${base}/flow/status`, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 || response.status === 403) return 'The image service rejected the platform key.';
    if (!response.ok) return `The image service answered HTTP ${response.status}.`;
    return null;
  } catch {
    return `The image service at ${base} is not answering. It runs as its own container.`;
  }
}
