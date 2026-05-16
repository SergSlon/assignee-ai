/**
 * resolveIntentForType — thin pure-function entry point for the intent-parser.
 *
 * Extracted from `intent-parser/index.ts` (Story 108-B-01) so variant-matrix
 * tests can call the intent-parser for a specific resource type + intent
 * combination without running the full LangGraph node (which does AWS
 * discovery, resource-state merging, and graph routing).
 *
 * ## Design constraints (PRD §9)
 *
 * The `intent-parser/index.ts` god-file (1531 LOC) SOLID extraction is
 * deferred to post-publish (V1-01). This file is a NARROW extraction —
 * it imports the existing public API surface only and adds zero new logic.
 *
 * The existing entry point's behaviour is unchanged: `createIntentParserNode`
 * still composes the same steps in the same order. This file merely exposes
 * a testable sub-surface for the matrix harness.
 *
 * ## Pure-function guarantee (Axis E)
 *
 * `resolveIntentForType` is referentially transparent for a given
 * `(type, intentShape, opts)` triple when the `llmClient` is a deterministic
 * mock. With a `MockLlmAdapter.forScriptedResponse(type, intentShape)` client,
 * calling it twice with identical arguments returns structurally equal results
 * (no hidden state mutation).
 *
 * Story 108-B-01
 */

import type { LlmPort } from "../../../ports/llm-port.js";
import type { AgentState } from "../../graph-state.js";
import { createIntentParserNode } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of AgentState produced by the intent-parser for a single resource type. */
export interface IntentResult {
  /** Resolved resource type string (may be "UNSUPPORTED"). */
  resourceType?: string;
  /** Detected compound pattern (for compound intent shapes). */
  resourcePattern?: AgentState["resourcePattern"];
  /** Intent kind — create / query / destroy / update. */
  intentKind?: AgentState["intentKind"];
  /** Execution status from the node. */
  executionStatus?: AgentState["executionStatus"];
  /** Error message if resolution failed. */
  errorMessage?: string;
}

/** Options for `resolveIntentForType`. */
export interface IntentOpts {
  /** Run ID for tracing (optional; defaults to "variant-matrix-test"). */
  runId?: string;
}

// ---------------------------------------------------------------------------
// NL intent builders
// ---------------------------------------------------------------------------

/**
 * Build a natural-language intent string that will cause the LLM classifier
 * to resolve to the given resource type + intent shape.
 *
 * The strings are crafted to be unambiguous: they include the full CFN type
 * namespace so even a strict classifier returns the expected type. The
 * keyword "standalone" is included to prevent compound-pattern short-circuits.
 *
 * These strings are for MOCK LLM tests only — the LLM response is scripted,
 * so the exact wording only matters for disambiguation (preventing keyword
 * matches in Steps 1–3 of the intent parser from short-circuiting before the
 * mock LLM is consulted).
 */
function buildIntentString(
  resourceType: string,
  intentShape: "CREATE" | "DESCRIBE" | "DESTROY",
): string {
  const typeShort = resourceType.split("::").slice(1).join(" ").toLowerCase();
  switch (intentShape) {
    case "CREATE":
      return `create a standalone ${typeShort} resource`;
    case "DESCRIBE":
      return `describe my existing standalone ${typeShort}`;
    case "DESTROY":
      return `destroy this standalone ${typeShort}`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the intent-parser output for a specific resource type and intent
 * shape using a provided LLM client (expected: a deterministic mock).
 *
 * This is a thin wrapper around `createIntentParserNode` that:
 * 1. Builds a minimal `AgentState` with `userIntent` + `runId`.
 * 2. Calls the intent-parser node with the given `llmClient`.
 * 3. Returns the relevant subset of the resulting `Partial<AgentState>`.
 *
 * No real AWS calls are made — the `productionResourceDiscoveryPort` is
 * mocked at the test level via vitest's module mocking. See
 * `type-intent-seed.test.ts` for the mock setup.
 *
 * @param resourceType - CloudFormation type string (e.g. "AWS::S3::Bucket").
 * @param intentShape  - One of "CREATE" | "DESCRIBE" | "DESTROY".
 * @param llmClient    - LlmPort implementation. Use `MockLlmAdapter.forScriptedResponse()`
 *                       for deterministic matrix tests.
 * @param opts         - Optional overrides (runId for tracing).
 * @returns            - Resolved IntentResult or null if resolution produced
 *                       no actionable fields.
 */
export async function resolveIntentForType(
  resourceType: string,
  intentShape: "CREATE" | "DESCRIBE" | "DESTROY",
  llmClient: LlmPort,
  opts: IntentOpts = {},
): Promise<IntentResult | null> {
  const runId = opts.runId ?? "variant-matrix-test";
  const userIntent = buildIntentString(resourceType, intentShape);

  const node = createIntentParserNode({ llmClient });
  const baseState: AgentState = {
    userIntent,
    runId,
  } as AgentState;

  const result = await node(baseState);

  // Return null only if the result is completely empty (should not happen).
  if (
    result === undefined ||
    result === null ||
    Object.keys(result).length === 0
  ) {
    return null;
  }

  return {
    resourceType: result.resourceType,
    resourcePattern: result.resourcePattern,
    intentKind: result.intentKind,
    executionStatus: result.executionStatus,
    errorMessage: result.errorMessage,
  };
}
