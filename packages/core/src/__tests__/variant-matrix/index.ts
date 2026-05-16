/**
 * Variant-matrix harness — registry-driven axis enumeration.
 *
 * This module is the single source of truth for enumerating every testable
 * axis in the Assignee.ai test suite. All values are derived from live
 * registries at import time so the harness self-updates when new types,
 * patterns, or commands are added.
 *
 * ## Design
 *
 * - `enumerateTypes()` — returns live SUPPORTED_TYPES_ARRAY (the CFN registry).
 * - `enumeratePatterns()` — returns `defaultPatternRegistry.list()` (13 patterns).
 * - `enumerateBpRules()` — returns all BP rule IDs from @assignee/best-practices.
 * - `enumerateCommands()` — returns the CLI command list (static; sourced from
 *   the CLI index.ts tree; kept as a typed tuple so new commands fail the
 *   drift-guard test explicitly).
 *
 * ## Adding a new axis
 *
 * 1. Add the enumeration function or extend an existing one here.
 * 2. Add test cases to the appropriate `*.test.ts` file in this directory.
 * 3. Update the drift-guard threshold in `drift-guard.test.ts` if the minimum
 *    coverage count changes.
 *
 * @see variant-matrix/drift-guard.test.ts — registry-parity enforcement.
 * @see variant-matrix/type-intent-seed.test.ts — baseline type × intent coverage.
 * @see variant-matrix/README.md — usage guide for dev workers.
 *
 * Story 108-B-01
 */

import { SUPPORTED_TYPES_ARRAY } from "../../config/resource-types/supported.js";
import { defaultPatternRegistry } from "../../pattern-templates/index.js";
import { loadBestPractices } from "@assignee/best-practices";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ---------------------------------------------------------------------------
// Intent shapes
// ---------------------------------------------------------------------------

/**
 * Canonical intent shapes exercised by the variant matrix.
 *
 * Each shape is a NL intent string prefix that the intent-parser will route
 * via LLM classification. The shape name is used as a test-case identifier;
 * the value is passed to `resolveIntentForType` as the userIntent fragment.
 *
 * Additional shapes (UPDATE, LIST, etc.) can be registered here and the
 * drift-guard threshold updated accordingly.
 */
export const INTENT_SHAPES = {
  CREATE: "CREATE",
  DESCRIBE: "DESCRIBE",
  DESTROY: "DESTROY",
} as const;

export type IntentShape = keyof typeof INTENT_SHAPES;

/** The three baseline intent shapes exercised by the seed test. */
export const BASELINE_INTENT_SHAPES: readonly IntentShape[] = [
  "CREATE",
  "DESCRIBE",
  "DESTROY",
] as const;

// ---------------------------------------------------------------------------
// Axis enumeration
// ---------------------------------------------------------------------------

/**
 * Return the live list of all supported CloudFormation resource types.
 * Count: SUPPORTED_TYPES_ARRAY.length (currently 38 + any additions).
 * Source: `packages/core/src/config/resource-types/supported.ts`.
 */
export function enumerateTypes(): readonly string[] {
  return SUPPORTED_TYPES_ARRAY;
}

/**
 * Return all registered compound architecture patterns in precedence order.
 * Count: `defaultPatternRegistry.size()` (currently 13 + any additions).
 * Source: `packages/core/src/pattern-templates/index.ts`.
 */
export function enumeratePatterns(): Array<{
  patternId: string;
  displayName: string;
  resourceCount: number;
}> {
  return defaultPatternRegistry.list().map((p) => ({
    patternId: p.patternId,
    displayName: p.displayName,
    resourceCount: p.resourceList.length,
  }));
}

/**
 * Return all BP rule IDs loaded from the `packages/best-practices` manifest.
 * Count: runtime (currently 185 + any additions).
 * Source: `packages/best-practices/` YAML files via `loadBestPractices()`.
 *
 * NOTE: this does file I/O; call once and cache in test suite setup.
 */
export function enumerateBpRules(): string[] {
  // Resolve the best-practices root relative to this file's location:
  //   packages/core/src/__tests__/variant-matrix/  →  packages/best-practices
  const bpRoot = join(__dirname, "..", "..", "..", "..", "best-practices");
  const bps = loadBestPractices(bpRoot);
  return bps.map((bp) => bp.id);
}

/**
 * CLI commands registered in `apps/cli/src/index.ts`.
 *
 * This is a typed tuple rather than a dynamic walk so that adding a new
 * command without updating this list causes a compile-time / drift-guard
 * test failure. To add a command: append its name below AND register a
 * matrix entry in `drift-guard.test.ts`.
 *
 * Current count: 17 (as of Story 108-B-01).
 */
export const CLI_COMMANDS = [
  "plan",
  "apply",
  "completions",
  "init",
  "describe",
  "destroy",
  "drift",
  "optimize",
  "list",
  "setup",
  "status",
  "reconcile",
  "doctor",
  "restore-provisions",
  "audit-verify",
  "update",
  "version",
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

/**
 * Return the registered CLI command names.
 * Count: `CLI_COMMANDS.length` (currently 17 + any additions).
 */
export function enumerateCommands(): readonly CliCommand[] {
  return CLI_COMMANDS;
}

// ---------------------------------------------------------------------------
// Variant-matrix record shapes
// ---------------------------------------------------------------------------

/**
 * A single variant-matrix entry. Every test case in the matrix MUST produce
 * at least one MatrixEntry so the drift-guard can verify coverage.
 *
 * The `covered` flag is set to `true` by test helpers once the combination
 * has been exercised. The drift-guard iterates the registry and asserts that
 * every type/pattern/rule key has at least one corresponding MatrixEntry.
 */
export interface MatrixEntry {
  /** Axis: resource type (CFN string) or pattern ID or BP rule ID or command. */
  key: string;
  /** Axis category — used by drift-guard to select the right registry set. */
  axis: "type" | "pattern" | "bp-rule" | "command";
  /** Intent shape exercised for this entry (types / commands only). */
  intentShape?: IntentShape;
}

/**
 * In-memory registry of matrix entries populated by test suites.
 *
 * Usage:
 * ```ts
 * import { matrixRegistry, registerMatrixEntry } from '../variant-matrix/index.js';
 *
 * registerMatrixEntry({ key: 'AWS::S3::Bucket', axis: 'type', intentShape: 'CREATE' });
 * ```
 */
const matrixRegistry: MatrixEntry[] = [];

/** Register a matrix entry from a test case. */
export function registerMatrixEntry(entry: MatrixEntry): void {
  matrixRegistry.push(entry);
}

/**
 * Return a copy of the current matrix registry for inspection.
 * The drift-guard calls this to assert coverage completeness.
 */
export function getMatrixRegistry(): readonly MatrixEntry[] {
  return [...matrixRegistry];
}

/**
 * Reset the matrix registry. Call in `beforeEach` / `afterAll` when
 * running isolated drift-guard scenarios (e.g. sentinel injection tests).
 */
export function resetMatrixRegistry(): void {
  matrixRegistry.length = 0;
}
