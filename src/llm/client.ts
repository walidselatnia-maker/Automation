import { candidatesFor, allFor, markFailure, markSuccess, COOLDOWNS } from './pool.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('llm');

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Ollama's structured output mode; the article prompts rely on 'json'. */
  format?: 'json' | null;
  temperature?: number;
  timeoutMs?: number;
}

export interface ChatResult {
  content: string;
  endpoint: string;
  model: string;
  durationMs: number;
  attempts: number;
}

/** Raised when every endpoint able to serve the model has been tried. */
export class NoEndpointAvailableError extends Error {
  constructor(
    readonly model: string,
    readonly tried: string[],
    readonly lastError: string,
  ) {
    const detail = tried.length
      ? `tried ${tried.length} endpoint(s): ${tried.join(', ')}. Last error: ${lastError}`
      : `no enabled endpoint serves model "${model}". Add one in Settings → LLM endpoints.`;
    super(`No Ollama endpoint could serve "${model}" — ${detail}`);
    this.name = 'NoEndpointAvailableError';
  }
}

const DEFAULT_TIMEOUT_MS = 300_000; // article parts are large; five minutes

interface OllamaChatResponse {
  message?: { content?: string };
  response?: string;
  error?: string;
}

async function callOllama(
  endpoint: { baseUrl: string; apiKey: string },
  request: ChatRequest,
  signal: AbortSignal,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: false,
  };
  if (request.format) body.format = request.format;
  if (request.temperature !== undefined) body.options = { temperature: request.temperature };

  const response = await fetch(`${endpoint.baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    (error as Error & { status?: number }).status = response.status;
    (error as Error & { retryAfter?: string | null }).retryAfter =
      response.headers.get('retry-after');
    throw error;
  }

  const json = (await response.json()) as OllamaChatResponse;
  if (json.error) throw new Error(json.error);

  const content = json.message?.content ?? json.response ?? '';
  if (!content.trim()) throw new Error('Endpoint returned an empty completion');

  return content;
}

/**
 * Send a chat request, transparently failing over between endpoints.
 *
 * The caller never learns which endpoint served it until it succeeds — and
 * the endpoint name comes back in the result so the run log can record it.
 */
export async function chat(request: ChatRequest, encryptionKey: Buffer): Promise<ChatResult> {
  const started = Date.now();
  const candidates = candidatesFor(request.model, encryptionKey);
  const tried: string[] = [];
  let lastError = '';

  // If health has knocked everything out, fall back to trying them anyway
  // rather than failing the run outright — a stale health flag should never
  // be the sole reason nothing can publish.
  const pool = candidates.length > 0 ? candidates : allFor(request.model, encryptionKey);
  if (candidates.length === 0 && pool.length > 0) {
    log.warn(`All endpoints for "${request.model}" are marked unhealthy; retrying anyway`);
  }

  for (const endpoint of pool) {
    tried.push(endpoint.name);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const content = await callOllama(endpoint, request, controller.signal);
      markSuccess(endpoint.id);

      return {
        content,
        endpoint: endpoint.name,
        model: request.model,
        durationMs: Date.now() - started,
        attempts: tried.length,
      };
    } catch (err) {
      const message = errorMessage(err);
      lastError = message;

      const status = (err as Error & { status?: number }).status;
      const retryAfter = (err as Error & { retryAfter?: string | null }).retryAfter;

      if (status === 429) {
        const seconds = Number(retryAfter);
        const cooldown = Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000
          : COOLDOWNS.RATE_LIMIT_COOLDOWN_MS;
        markFailure(endpoint.id, `Rate limited: ${message}`, cooldown);
        log.warn(`"${endpoint.name}" rate limited, cooling down ${cooldown / 1000}s`);
      } else {
        markFailure(endpoint.id, message);
        log.warn(`"${endpoint.name}" failed: ${message}`);
      }
      // Fall through to the next endpoint — this is the failover.
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new NoEndpointAvailableError(request.model, tried, lastError);
}

/** Liveness probe used by the Settings page. */
export async function probeEndpoint(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, models: [], error: `HTTP ${response.status}` };

    const json = (await response.json()) as { models?: { name?: string }[] };
    const models = (json.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string');

    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: errorMessage(err) };
  }
}
