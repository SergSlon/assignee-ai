/**
 * Factory for status command's best-practices directory resolution.
 * Replaces globalThis["__bpDir"] test injection with a proper module
 * that tests can vi.mock.
 *
 * @see Sprint K — Quality Blitz: Fix globalThis DI pattern
 */

import * as path from "node:path";

/**
 * Resolves the best-practices package directory path.
 * Tests vi.mock this module to inject a fixture directory.
 */
export function getBpDir(): string {
  return path.resolve(
    import.meta.dirname,
    "../../../../packages/best-practices",
  );
}
