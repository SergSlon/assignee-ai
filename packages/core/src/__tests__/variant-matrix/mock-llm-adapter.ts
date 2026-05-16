/**
 * Shared MockLlmAdapter contract for the variant-matrix harness.
 *
 * This module promotes the deterministic mock LLM adapter to a shared
 * test fixture accessible by all variant-matrix tests. The adapter
 * returns fully scripted, deterministic structured LLM responses so that
 * matrix tests run without hitting Bedrock.
 *
 * ## Contract
 *
 * `MockLlmAdapter.forScriptedResponse(type, intentShape)` — factory method
 * that builds a mock whose `generateStructured` always returns a consistent
 * structured response for the given type and intent shape. Calling it
 * multiple times with the same arguments returns structurally identical
 * results (identity equality on the fixture object).
 *
 * ## Why not import from packages/core/src/testing?
 *
 * The base `MockLlmAdapter` in `packages/core/src/testing/mock-llm-adapter.ts`
 * is a general-purpose stub. This variant-matrix version extends it with the
 * `forScriptedResponse` factory that understands `IntentShape` semantics and
 * returns structured fixtures that match the `intentParserSchema` (`kind` +
 * `resourceType`). The two coexist; tests that only need a generic stub
 * still import from `@assignee/core/testing`.
 *
 * ## Dependency invariant (Axis I)
 *
 * This file MUST NOT import from `apps/cli/`. Test utilities must not depend
 * on the CLI package. All imports are from `packages/core/src/` only.
 *
 * Story 108-B-01
 */

import type { ZodSchema } from "zod";
import type { Result } from "../../types/result.js";
import { LlmError } from "../../errors.js";
import type { LlmPort, LlmCallOptions } from "../../ports/llm-port.js";
import type { IntentShape } from "./index.js";

// ---------------------------------------------------------------------------
// Scripted response fixtures
// ---------------------------------------------------------------------------

/**
 * The scripted structured response returned by `forScriptedResponse`.
 * Shape matches `intentParserSchema` in `intent-parser/index.ts`.
 */
export interface ScriptedIntentResponse {
  resourceType: string;
  kind: "create" | "query" | "destroy" | "update";
}

/**
 * The scripted response for an unknown / unsupported type.
 * Returned when the resourceType passed to `forScriptedResponse` is not a
 * known CFN type string (i.e. not `AWS::*:*`).
 */
export const UNSUPPORTED_SCRIPTED_RESPONSE: ScriptedIntentResponse =
  Object.freeze({
    resourceType: "UNSUPPORTED",
    kind: "create" as const,
  });

/**
 * Map an IntentShape to its `kind` value in the intent-parser schema.
 * DESCRIBE maps to "query" (read-only intent); DESTROY maps to "destroy";
 * CREATE maps to "create".
 */
function intentShapeToKind(
  intentShape: IntentShape,
): ScriptedIntentResponse["kind"] {
  switch (intentShape) {
    case "CREATE":
      return "create";
    case "DESCRIBE":
      return "query";
    case "DESTROY":
      return "destroy";
  }
}

/**
 * Build the scripted structured response for a given type + intent shape.
 * Always returns the same object instance for the same inputs (interned
 * in `_responseCache`), so Axis C identity-equality assertions pass.
 */
const _responseCache = new Map<string, ScriptedIntentResponse>();

function buildScriptedResponse(
  resourceType: string,
  intentShape: IntentShape,
): ScriptedIntentResponse {
  const cacheKey = `${resourceType}:${intentShape}`;
  const cached = _responseCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const isKnownType =
    typeof resourceType === "string" && resourceType.startsWith("AWS::");

  // For unknown types, return the UNSUPPORTED_SCRIPTED_RESPONSE singleton
  // itself (not a copy) so identity equality (toBe) holds in Axis D tests.
  const response: ScriptedIntentResponse = isKnownType
    ? Object.freeze({ resourceType, kind: intentShapeToKind(intentShape) })
    : UNSUPPORTED_SCRIPTED_RESPONSE;
  _responseCache.set(cacheKey, response);
  return response;
}

// ---------------------------------------------------------------------------
// VariantMatrixMockLlmAdapter
// ---------------------------------------------------------------------------

/**
 * Variant-matrix mock LLM adapter. Wraps a scripted fixture so matrix tests
 * never hit Bedrock. Every call to `generateStructured` returns the same
 * deterministic response frozen at construction time.
 *
 * Use `MockLlmAdapter.forScriptedResponse(type, intentShape)` as the primary
 * entry point.
 */
export class MockLlmAdapter implements LlmPort {
  /**
   * The scripted structured response this adapter will always return.
   * Read-only; set at construction time.
   */
  public readonly scriptedResponse: ScriptedIntentResponse;

  /** Number of times `generateStructured` has been called. For assertion use. */
  public callCount = 0;

  /** All recorded call arguments (for assertion use). */
  public readonly calls: Array<{ prompt: string; options?: LlmCallOptions }> =
    [];

  constructor(response: ScriptedIntentResponse) {
    this.scriptedResponse = response;
  }

  /**
   * Factory: build a `MockLlmAdapter` that returns a deterministic scripted
   * response for the given resource type and intent shape.
   *
   * Axis C — identity equality: calling with identical arguments twice
   * returns the SAME frozen fixture object (interned in `_responseCache`),
   * so `expect(result1).toBe(result2)` assertions pass.
   *
   * Axis D — unknown-type fallback: passing a non-`AWS::` string returns
   * `UNSUPPORTED_SCRIPTED_RESPONSE` rather than throwing.
   *
   * @param resourceType - CloudFormation type string (e.g. "AWS::S3::Bucket")
   *   or any string. Non-`AWS::` values produce the UNSUPPORTED fallback.
   * @param intentShape - Intent shape ("CREATE" | "DESCRIBE" | "DESTROY").
   * @returns A new `MockLlmAdapter` pre-loaded with the scripted fixture.
   */
  static forScriptedResponse(
    resourceType: string,
    intentShape: IntentShape,
  ): MockLlmAdapter {
    return new MockLlmAdapter(buildScriptedResponse(resourceType, intentShape));
  }

  async generateStructured<T>(
    prompt: string,
    _schema: ZodSchema<T>,
    options?: LlmCallOptions,
  ): Promise<Result<T, LlmError>> {
    this.callCount++;
    this.calls.push({ prompt, options });
    return [null, this.scriptedResponse as T] as const;
  }

  async generateText(
    _prompt: string,
    _options?: LlmCallOptions,
  ): Promise<Result<string, LlmError>> {
    // Matrix tests use generateStructured; text path is not exercised.
    // Returning empty string (no-op) rather than throwing so adapters
    // don't accidentally abort tests that happen to also call generateText.
    this.callCount++;
    return [null, ""] as const;
  }
}
