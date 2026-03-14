/**
 * Go-style Result monad for explicit error handling.
 * Usage: `const [err, value] = await safeTry(somePromise)`
 */
export type Result<T, E = Error> = readonly [null, T] | readonly [E, null]

/**
 * Wraps a Promise in a Result tuple for Go-style error handling.
 * Resolves to `[null, value]` on success, `[error, null]` on rejection.
 *
 * @param promise - The promise to wrap
 * @returns A Result tuple
 *
 * @example
 * ```typescript
 * const [err, user] = await safeTry(getUser(id))
 * if (err) {
 *   console.error('Failed to get user:', err.message)
 *   return
 * }
 * // user is guaranteed to be non-null here
 * ```
 */
export async function safeTry<T, E = Error>(
  promise: Promise<T>,
): Promise<Result<T, E>> {
  try {
    return [null, await promise] as const
  } catch (e) {
    return [e as E, null] as const
  }
}
