#!/usr/bin/env node
/**
 * Builds the final mcp-mock-responses.ts from processed captures.
 *
 * IMPORTANT (story 48-10, 2026-04-16):
 *   The fixture has been split from a 4708-LOC monolith into a directory of
 *   per-resource files under apps/cli/src/test-fixtures/mcp-mock-responses/.
 *   The original file is now a ≤20-LOC facade re-exporting from that directory.
 *
 *   This generator is currently DISABLED — running it would overwrite the
 *   facade with a fresh monolith and break the file-size invariant. It also
 *   only ever regenerated a subset of the data (8 schemas, partial pricing);
 *   the remaining content has been hand-maintained.
 *
 *   To re-enable: rewrite this script to emit the per-resource layout under
 *   mcp-mock-responses/ instead of overwriting the facade. See story 48-10
 *   Task 7 for the layout spec, and `git log -- apps/cli/scripts/build-fixture-ts.mjs`
 *   for the previous monolith-emitter implementation as reference.
 */
console.error(
  "build-fixture-ts.mjs is disabled — the fixture is now a split directory layout (story 48-10).",
);
console.error(
  "See header comment for re-enablement guidance. Aborting without modifying anything.",
);
process.exit(2);
