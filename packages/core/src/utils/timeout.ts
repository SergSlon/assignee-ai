/**
 * Generic timeout wrapper — races a promise against a timer.
 * Returns null if the timer fires first.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then((v) => {
      clearTimeout(timer);
      return v;
    }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]);
}
