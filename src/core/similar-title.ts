/**
 * Catch an article that is a near-duplicate of one this site already has.
 *
 * A keyword can legitimately run on several sites, and two runs of the same
 * keyword on the *same* site — after a re-import, or after a link was set back
 * to go by hand — produce two articles about the same dish with almost the
 * same title. That is the case worth catching: it splits the site's own
 * ranking between two pages and reads as thin content.
 *
 * Deliberately not exact string equality. "Easy Baked Chicken Breast" and
 * "Baked Chicken Breast (Easy!)" are the same article, and exact matching
 * catches neither.
 *
 * Pure, so the threshold can be argued with in a test rather than in
 * production.
 */

/** Words too common to carry any signal in a recipe title. */
const NOISE = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to',
  'best', 'easy', 'quick', 'simple', 'perfect', 'ultimate', 'homemade',
  'recipe', 'recipes', 'how', 'make', 'making', 'your', 'my',
]);

/** Title reduced to the words that actually name the dish. */
export function significantWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !NOISE.has(word));
}

/**
 * How much two titles overlap, from 0 to 1.
 *
 * Jaccard over the significant words: shared words divided by the total
 * distinct words. Symmetric, and it does not reward a long title for
 * containing a short one by accident.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(significantWords(a));
  const right = new Set(significantWords(b));

  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;

  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Where "too similar" starts.
 *
 * 0.7 means roughly "the same nouns in a different order". Measured against
 * the pairs in the tests: it catches rewordings of one dish and leaves
 * genuinely different dishes that share a main ingredient alone.
 */
export const SIMILARITY_THRESHOLD = 0.7;

export interface DuplicateMatch {
  title: string;
  url: string | null;
  similarity: number;
}

/** The closest existing title, when it is close enough to be a problem. */
export function findDuplicate(
  candidate: string,
  existing: { title: string; url: string | null }[],
  threshold = SIMILARITY_THRESHOLD,
): DuplicateMatch | null {
  let best: DuplicateMatch | null = null;

  for (const other of existing) {
    if (!other.title.trim()) continue;

    const similarity = titleSimilarity(candidate, other.title);
    if (similarity < threshold) continue;
    if (best && similarity <= best.similarity) continue;

    best = { title: other.title, url: other.url, similarity };
  }

  return best;
}
