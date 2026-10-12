/**
 * How every AI step of the new website gets its answer right.
 *
 * Two kinds of trouble, handled differently:
 * - A technical failure (the AI cannot be reached, or never gives a readable
 *   answer) is a fail: the step stops, and the platform's automatic retries
 *   take it from there.
 * - A mistake (the answer breaks one of the step's rules) is not a fail. The
 *   AI is sent its own previous answer with a numbered list of exactly what
 *   is wrong and how to fix it, and asked to fix only that. Round after
 *   round, until every rule passes.
 *
 * MAX_ROUNDS is only a safety net against a rule the AI cannot meet: if it
 * is ever reached, the best attempt so far is kept and the step carries on,
 * with what is still wrong noted on its card.
 */

export const MAX_ROUNDS = 10;
export const NOT_REACHED = 'The AI could not be reached. Check the AI keys on the Platform page.';
const NEVER_READ = 'The AI never gave a readable answer.';

/** The correction for the next round: what to fix, then the answer to fix it in. */
export function correction(problems: string[], previous: string): string {
  if (!problems.length) return '(none: this is your first answer)';
  return [
    `Your previous answer (shown below) breaks ${problems.length} rule${problems.length === 1 ? '' : 's'}. ` +
      'Fix every numbered point exactly as it says. Change only what a point asks for and keep everything ' +
      'else in your previous answer as it is: the parts not listed here are already right.',
    '',
    ...problems.map((p, i) => `${i + 1}. ${p}`),
    '',
    'Your previous answer:',
    previous.slice(0, 16_000),
  ].join('\n');
}

export interface Outcome<T> {
  /** The answer that passed, or the best attempt; null only on a technical failure with nothing usable. */
  answer: T | null;
  /** What is still wrong with the answer kept (empty when it passed). */
  problems: string[];
  /** True when the step failed for a technical reason, not because of a mistake. */
  technical: boolean;
}

export interface RoundsOptions<T> {
  /** One request to the AI, carrying the correction text. Throws when the AI cannot be reached. */
  ask: (corrections: string) => Promise<string>;
  /** The answer out of the AI's raw text, or null when it cannot be read. */
  parse: (raw: string) => T | null;
  /** What is wrong with an answer, each problem saying how to fix it. */
  check: (answer: T) => string[];
  /** Which of two attempts is better when none passes: lower is better. Default: fewer problems. */
  rank?: (problems: string[]) => number;
  maxRounds?: number;
  /** Called on a technical failure, for the log. */
  onError?: (err: unknown) => void;
}

/** Ask, check, and send back the mistakes until the answer passes. */
export async function correctUntilRight<T>(o: RoundsOptions<T>): Promise<Outcome<T>> {
  const rank = o.rank ?? ((p: string[]) => p.length);
  let corrections = correction([], '');
  let best: { answer: T; problems: string[] } | null = null;
  for (let round = 0; round < (o.maxRounds ?? MAX_ROUNDS); round++) {
    let raw: string;
    try {
      raw = await o.ask(corrections);
    } catch (err) {
      o.onError?.(err);
      return { answer: best?.answer ?? null, problems: [NOT_REACHED], technical: true };
    }
    const answer = o.parse(raw);
    const problems = answer
      ? o.check(answer)
      : ['Your answer could not be read. Answer with exactly the format asked for (the JSON shape or Markdown section), with nothing before or after it.'];
    if (answer && problems.length === 0) return { answer, problems: [], technical: false };
    if (answer && (!best || rank(problems) < rank(best.problems))) best = { answer, problems };
    corrections = correction(problems, raw);
  }
  if (!best) return { answer: null, problems: [NEVER_READ], technical: true };
  return { answer: best.answer, problems: best.problems, technical: false };
}

/** The note kept on a step that carried on with problems after every round. */
export const keptNote = (problems: string[]): string =>
  problems.length ? [`Kept after ${MAX_ROUNDS} rounds of corrections; still to fix:`, ...problems].join('\n') : '';
