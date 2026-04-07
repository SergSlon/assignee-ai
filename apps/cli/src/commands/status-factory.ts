/**
 * Factory for status command's best-practices directory resolution.
 * Replaces globalThis["__bpDir"] test injection with a proper module
 * that tests can vi.mock.
 *
 * REQUIREMENT: Node.js >= 20.11. This file uses `import.meta.dirname`,
 * which was added in Node 20.11 (and 21.2). The repo `engines.node` is
 * `>=20`, so installs on 20.0–20.10 will hit a runtime error here.
 * Bumping `engines.node` to `>=20.11` is recommended in a follow-up.
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
