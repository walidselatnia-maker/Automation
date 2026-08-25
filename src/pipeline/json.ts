/**
 * Parsing helpers for LLM output.
 *
 * These consolidate the cleanup logic that was spread across five separate
 * Code nodes in the previous system (SEO Cleaner, Reciper json, Cleaning
 * Json1, Separate ID + name, Code in JavaScript8), each with its own slightly
 * different idea of how to rescue malformed JSON.
 */

export class LlmJsonError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'LlmJsonError';
  }
}

/** Strip markdown fences and surrounding prose from a model's reply. */
export function stripFences(text: string): string {
  let out = text.trim();

  if (out.startsWith('```')) {
    out = out
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
  }

  // If the model wrapped JSON in commentary, keep the outermost braces.
  if (!out.startsWith('{') && !out.startsWith('[')) {
    const firstBrace = out.indexOf('{');
    const firstBracket = out.indexOf('[');
    const start =
      firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);

    if (start >= 0) {
      const lastBrace = out.lastIndexOf('}');
      const lastBracket = out.lastIndexOf(']');
      const end = Math.max(lastBrace, lastBracket);
      if (end > start) out = out.slice(start, end + 1);
    }
  }

  return out.trim();
}

/** Repairs that are safe because they cannot change a valid document. */
export function repairCommonIssues(text: string): string {
  return text
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    .replace(/﻿/g, '');
}

export function parseJson<T = Record<string, unknown>>(raw: string, what = 'LLM output'): T {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new LlmJsonError(`${what} was empty`, String(raw));
  }

  const cleaned = stripFences(raw);

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    try {
      return JSON.parse(repairCommonIssues(cleaned)) as T;
    } catch (err) {
      throw new LlmJsonError(
        `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        cleaned.slice(0, 2000),
      );
    }
  }
}

/** Require named fields to be present and non-empty. */
export function requireFields<T extends Record<string, unknown>>(
  obj: T,
  fields: string[],
  what: string,
): void {
  const missing = fields.filter((f) => {
    const value = obj[f];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new LlmJsonError(
      `${what} is missing required field(s): ${missing.join(', ')}`,
      JSON.stringify(obj).slice(0, 1000),
    );
  }
}
