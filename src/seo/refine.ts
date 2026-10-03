/**
 * "Check it, ask once more with the exact problems, keep the better answer."
 *
 * Used where SEO wording is produced inside a pipeline run. Wording is never
 * worth stopping a run for, so this cannot throw and an unfixable answer is
 * returned with its remaining problems for the caller to log.
 */
export async function refineOnce<T>(
  first: T,
  check: (value: T) => string[],
  reask: (problems: string[]) => Promise<T | null>,
): Promise<{ value: T; problems: string[] }> {
  const firstProblems = check(first);
  if (firstProblems.length === 0) return { value: first, problems: [] };

  try {
    const second = await reask(firstProblems);
    if (second !== null) {
      const secondProblems = check(second);
      if (secondProblems.length < firstProblems.length) {
        return { value: second, problems: secondProblems };
      }
    }
  } catch {
    // Asking again is a bonus; the first answer still stands.
  }
  return { value: first, problems: firstProblems };
}

/** The line a prompt shows when its previous answer broke rules; empty when it did not. */
export const feedbackFor = (problems: string[]): string =>
  problems.length ? `YOUR LAST ANSWER BROKE THESE SEO RULES. Fix them: ${problems.join(' ')}` : '';
