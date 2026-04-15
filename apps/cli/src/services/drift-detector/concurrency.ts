/**
 * Bounded-concurrency task runner — used by the drift detector to fan out
 * CloudControl GetResource calls without exhausting the AWS API quota.
 *
 * Extracted from drift-detector.ts during Wave-6c decomposition.
 *
 * @see Story 28.6
 */

/**
 * Run tasks with a concurrency limit. Preserves input order in results.
 */
export async function runWithConcurrency<T, R>(
  limit: number,
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex]!);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}
