import { GeminiClient, GeminiError, type GeminiReply } from '../integrations/gemini.js';
import type { Settings } from '../settings.js';
import type { ChatMessage, ChatRequest, Completion } from './client.js';

/**
 * Gemini as a model the prompts can be sent to.
 *
 * A prompt whose model is GEMINI_MODEL (set from Platform settings, stored as an ordinary model
 * override) is answered by Gemini in the image service's browser instead of the AI keys. It is
 * deliberately not an AI key: a key with no model list serves every model, so a Gemini key would
 * take prompts meant for the others, and its secret comes from the deployment, not from a person.
 *
 * Anything that stops Gemini answering -- signed out, daily limit, a reply that is not JSON when
 * JSON was asked for -- is thrown, and chat() then sends the same prompt to its usual model. A
 * Gemini session that needs attention must never be the reason nothing publishes.
 */

export const GEMINI_MODEL = 'gemini';

/** The conversation key of one article: every Gemini prompt for it goes to the same chat. */
export const articleChat = (articleId: number): string => `article:${articleId}`;

/** Platform settings keys holding the last outcome, for the status badge. */
export const GEMINI_LAST_OK = 'gemini_last_ok_at';
export const GEMINI_LAST_ERROR = 'gemini_last_error';

/**
 * How long prompts skip Gemini after it fails to answer, going straight to their usual model.
 * The writer works one prompt at a time, so a Gemini that cannot answer -- the browser busy making
 * pictures, signed out, the extension gone -- must cost one wait, not one per prompt.
 */
export const GEMINI_PAUSE_MS = 10 * 60_000;

/** Failures in which Gemini did answer, only not usably: no reason to stop asking it. */
const ANSWERED = new Set(['NOT_JSON', 'NOT_AN_ANSWER', 'SETUP', 'PAUSED']);

/** Past every wait below it: the last word on how long one prompt may hold up the next. */
const GRACE_MS = 90_000;

/** Where the Gemini chat of each conversation key ("article:12") is remembered. */
export interface GeminiChats {
  get(key: string): string;
  set(key: string, conversationId: string): void;
}

interface GeminiSetup {
  settings: Settings;
  /** The Google account Gemini should answer as; empty for the browser's default account. */
  account: () => string;
  /** Absent: every prompt starts a new chat. */
  chats?: GeminiChats;
  fetchImpl?: typeof fetch;
  /** How often a reply is polled for; the client's default (2 s) unless given. */
  pollIntervalMs?: number;
  /** How long past its own timeout a prompt is given up on regardless; GRACE_MS unless given. */
  graceMs?: number;
}

/**
 * Prompts for the same conversation, one after another. The second prompt of a new article has
 * to wait for the first one's answer, because only then does the article's chat have an id; sent
 * together, each would open a chat of its own.
 *
 * In addition, all calls to Gemini are serialized through a global lock so that concurrent
 * background tasks (e.g. content repurposing vs. autopilot article generation) never send
 * overlapping jobs to the single Gemini browser session in the image service container.
 */
const queues = new Map<string, Promise<unknown>>();
let globalGeminiLock: Promise<unknown> = Promise.resolve();

function inTurn<T>(key: string | undefined, work: () => Promise<T>): Promise<T> {
  const run = globalGeminiLock
    .catch(() => {})
    .then(async () => {
      if (!key) return work();
      const perKeyRun = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
      queues.set(key, perKeyRun);
      try {
        return await perKeyRun;
      } finally {
        if (queues.get(key) === perKeyRun) queues.delete(key);
      }
    });
  globalGeminiLock = run.catch(() => {});
  return run;
}

let setup: GeminiSetup | null = null;

/** Called once at start-up, so chat() can reach the image service without being handed Settings. */
export function configureGemini(next: GeminiSetup | null): void {
  setup = next;
}

export function geminiClient(settings: Settings, fetchImpl?: typeof fetch, pollIntervalMs?: number): GeminiClient | null {
  const baseUrl = settings.get('image_base_url').trim();
  const apiKey = settings.get('image_api_key').trim();
  if (!baseUrl || !apiKey) return null;
  return new GeminiClient({ baseUrl, apiKey, fetchImpl, pollIntervalMs });
}

/** Remember how the last prompt went: the time it worked, or why it did not. */
export function recordGeminiOutcome(settings: Settings, error: string | null): void {
  if (error) {
    settings.set(GEMINI_LAST_ERROR, `${new Date().toISOString()} ${error.slice(0, 300)}`);
  } else {
    settings.set(GEMINI_LAST_OK, new Date().toISOString());
    settings.set(GEMINI_LAST_ERROR, '');
  }
}

/**
 * Until when prompts skip Gemini (epoch ms), or 0. Read off the last error, so the status badge
 * and chat() agree, and a successful answer -- a test message counts -- ends the pause at once.
 */
export function geminiPausedUntil(settings: Settings, now = Date.now()): number {
  const m = /^(\S+) ([A-Z_]{3,30}):/.exec(settings.get(GEMINI_LAST_ERROR));
  if (!m || ANSWERED.has(m[2]!)) return 0;
  const until = Date.parse(m[1]!) + GEMINI_PAUSE_MS;
  return Number.isFinite(until) && until > now ? until : 0;
}

/** The work, or a TIMEOUT once `ms` have gone by, whichever comes first. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GeminiError('Gemini did not answer in time', 'TIMEOUT')), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * The messages as one prompt. Gemini's page has a single box, so the instructions go first and
 * the request after them; a JSON prompt also says how the answer must come back.
 */
export function joinMessages(messages: ChatMessage[], format: 'json' | null | undefined): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content.trim()).filter(Boolean);
  const rest = messages.filter((m) => m.role !== 'system').map((m) => m.content.trim()).filter(Boolean);
  const parts = [
    ...(system.length ? [`Instructions:\n${system.join('\n\n')}`] : []),
    ...(rest.length ? [system.length ? `Request:\n${rest.join('\n\n')}` : rest.join('\n\n')] : []),
  ];
  if (format === 'json') {
    parts.push('Answer with valid JSON only, in one ```json code block, with no other text.');
  }
  return parts.join('\n\n');
}

/** The JSON in a reply: its code block when it has one, else the outermost braces in its text. */
export function jsonFrom(reply: Pick<GeminiReply, 'code_blocks' | 'text' | 'markdown'>): string {
  const candidates = [
    ...reply.code_blocks.filter((b) => b.language === 'json').map((b) => b.code),
    ...reply.code_blocks.map((b) => b.code),
    reply.text,
    reply.markdown,
  ];
  for (const candidate of candidates) {
    const text = candidate.trim();
    const start = text.search(/[[{]/);
    if (start < 0) continue;
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end <= start) continue;
    const slice = text.slice(start, end + 1);
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      /* try the next candidate */
    }
  }
  throw new GeminiError('Gemini did not answer with valid JSON', 'NOT_JSON');
}

// What Gemini says instead of an answer. Short replies only: a long one that merely mentions a
// limit is an answer.
const NOT_AN_ANSWER =
  /reached your (daily )?limit|you('ve| have) reached the (daily )?limit|limit resets|try again (later|tomorrow)|I('m| am) (not able|unable) to help|I can('|’)t help with (that|this)|I('m| am) just a language model/i;

/** Why a reply cannot be used as an answer, or null when it can. */
export function unusableReply(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 2) return 'Gemini gave an empty answer';
  if (trimmed.length < 600 && NOT_AN_ANSWER.test(trimmed)) return `Gemini did not answer: ${trimmed.slice(0, 160)}`;
  return null;
}

/**
 * Ask Gemini for one completion. Throws when it cannot give a usable one.
 *
 * A prompt with a `chat` key continues that conversation's Gemini chat (one per article), or
 * starts it and remembers it; one without starts a new chat of its own.
 *
 * Never waits longer than its own timeout and a margin, whatever the image service does: the
 * prompts of an article go one after another and the writer one article at a time, so one prompt
 * that never came back would stop everything behind it.
 */
export async function geminiCompletion(request: ChatRequest): Promise<Completion> {
  if (!setup) throw new GeminiError('Gemini is not set up in this process', 'SETUP');
  const current = setup;
  const client = geminiClient(current.settings, current.fetchImpl, current.pollIntervalMs);
  if (!client) throw new GeminiError('The image service is not configured, and Gemini runs there', 'SETUP');
  const timeoutMs = request.timeoutMs ?? 300_000;
  const limitMs = timeoutMs + (current.graceMs ?? GRACE_MS);

  return inTurn(request.chat, async () => {
    // Asked in turn, not before: a prompt that waited behind a failed one goes straight on.
    const paused = geminiPausedUntil(current.settings);
    if (paused) {
      throw new GeminiError(`Gemini is paused until ${new Date(paused).toISOString().slice(11, 16)} UTC after it could not answer`, 'PAUSED');
    }
    try {
      const completion = await within(limitMs, answer(current, client, request, timeoutMs));
      recordGeminiOutcome(current.settings, null);
      return completion;
    } catch (err) {
      const error = err instanceof GeminiError ? err : new GeminiError(err instanceof Error ? err.message : String(err));
      recordGeminiOutcome(current.settings, `${error.code}: ${error.message}`);
      throw error;
    }
  });
}

async function answer(current: GeminiSetup, client: GeminiClient, request: ChatRequest, timeoutMs: number): Promise<Completion> {
  const { chats } = current;
  const key = request.chat;
  const reply = await client.ask({
    prompt: joinMessages(request.messages, request.format),
    account: current.account(),
    conversationId: key && chats ? chats.get(key) : '',
    images: false,
    timeoutS: Math.round(timeoutMs / 1000),
  });
  // Remembered even when the reply is then refused: the prompt is in that chat now.
  if (key && chats && reply.conversation_id) chats.set(key, reply.conversation_id);
  const problem = unusableReply(reply.text);
  if (problem) throw new GeminiError(problem, 'NOT_AN_ANSWER');
  const content = request.format === 'json' ? jsonFrom(reply) : reply.markdown || reply.text;
  return { content, tokensIn: 0, tokensOut: 0 };
}
