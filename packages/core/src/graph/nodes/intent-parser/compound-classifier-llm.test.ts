/**
 * Unit tests for the LLM-fallback compound-pattern classifier.
 *
 * Epic-107 Story 1 — Variations A-F from the probe plan.
 *
 * Strategy:
 *   - Inject a mock LlmPort via the function parameter — NO real Bedrock calls.
 *   - A mock PatternRegistry is built inline for each test so tests remain
 *     self-contained and registry-state-independent.
 *   - Every test asserts both the return value AND the LLM call count.
 */

import { describe, it, expect, vi } from "vitest";
import { PatternRegistry } from "../../../pattern-templates/index.js";
import type { LlmPort, LlmCallOptions } from "../../../ports/llm-port.js";
import { classifyCompoundViaLlm } from "./compound-classifier-llm.js";

// ── Test fixture helpers ──────────────────────────────────────────────────────

function makeRegistry(
  patterns: Array<{ patternId: string; keywords: string[] }>,
): PatternRegistry {
  const reg = new PatternRegistry();
  for (const p of patterns) {
    reg.register({
      patternId: p.patternId,
      keywords: p.keywords,
      resources: [],
    } as never);
  }
  return reg;
}

/** Build a mock LlmPort whose generateStructured returns the given value. */
function makeMockLlm(
  response:
    | { patternKey: string | null; confidence: string; rationale: string }
    | Error
    | null,
): { mock: LlmPort; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn();
  const mock: LlmPort = {
    generateStructured: spy,
    generateText: vi.fn(),
  };

  if (response instanceof Error) {
    // Simulate LLM / schema error — returns [LlmError, null]
    spy.mockResolvedValue([response, null] as const);
  } else if (response === null) {
    // Should never happen but guard
    spy.mockResolvedValue([null, null] as const);
  } else {
    spy.mockResolvedValue([null, response] as const);
  }

  return { mock, spy };
}

// ── Shared registry used across all tests ───────────────────────────────────

const TEST_PATTERNS = [
  { patternId: "sqs-with-dlq", keywords: ["sqs", "dlq", "dead-letter"] },
  {
    patternId: "lambda-with-dynamodb",
    keywords: ["lambda", "dynamodb", "table"],
  },
  { patternId: "serverless-api", keywords: ["serverless", "api", "gateway"] },
];

// ── Test suite ────────────────────────────────────────────────────────────────

describe("classifyCompoundViaLlm", () => {
  // Variation A — Keyword-hit short-circuits LLM (no LLM call)
  // NOTE: This variation is tested at the intent-parser orchestrator level
  // (see __tests__/llm-fallback-integration.test.ts — Variation A).
  // Here we test that classifyCompoundViaLlm is NOT the bypass point;
  // the orchestrator decides when to call it (only on keyword-miss).
  // We only test the function itself below.

  describe("Variation B — keyword-miss → LLM-hit (high confidence)", () => {
    it("returns match with the patternKey from LLM response", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock, spy } = makeMockLlm({
        patternKey: "lambda-with-dynamodb",
        confidence: "high",
        rationale: "Intent describes a Lambda function with a DynamoDB table",
      });

      const result = await classifyCompoundViaLlm(
        "Lambda function with a DynamoDB table and an exec role allowing read write",
        registry,
        mock,
      );

      expect(result).toEqual({
        kind: "match",
        patternKey: "lambda-with-dynamodb",
      });
      expect(spy).toHaveBeenCalledTimes(1);

      // Verify callsite is passed through to the LLM options
      const callOptions = spy.mock.calls[0]?.[2] as LlmCallOptions | undefined;
      expect(callOptions?.callsite).toBe(
        "intent-parser/compound-classifier-llm",
      );
    });

    it("returns match when confidence is 'medium'", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock } = makeMockLlm({
        patternKey: "serverless-api",
        confidence: "medium",
        rationale: "Looks like a serverless API pattern",
      });

      const result = await classifyCompoundViaLlm(
        "Create a serverless REST endpoint with authentication and a backend function",
        registry,
        mock,
      );

      expect(result).toEqual({ kind: "match", patternKey: "serverless-api" });
    });
  });

  describe("Variation C — keyword-miss → LLM returns null patternKey", () => {
    it("returns no-match when LLM patternKey is null", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock, spy } = makeMockLlm({
        patternKey: null,
        confidence: "high",
        rationale:
          "No matching catalogue pattern — VPC peering is not in the catalogue",
      });

      const result = await classifyCompoundViaLlm(
        "Provision a VPC peering connection between us-east-1 and eu-west-1 regions with route tables",
        registry,
        mock,
      );

      expect(result).toEqual({ kind: "no-match" });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("returns no-match when LLM returns the string 'NONE' as patternKey", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock } = makeMockLlm({
        patternKey: "NONE",
        confidence: "high",
        rationale: "No matching catalogue pattern",
      });

      const result = await classifyCompoundViaLlm(
        "Create a CloudFront distribution in front of an existing S3 bucket with an existing OAI policy",
        registry,
        mock,
      );

      expect(result).toEqual({ kind: "no-match" });
    });
  });

  describe("Variation D — schema rejection / LLM error", () => {
    it("returns no-match (no crash) when LLM returns an error", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock, spy } = makeMockLlm(
        new Error("ZodError: missing confidence field"),
      );

      let caughtError: unknown = null;
      let result;
      try {
        result = await classifyCompoundViaLlm(
          "Lambda function with a DynamoDB table and an exec role allowing read write",
          registry,
          mock,
        );
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeNull();
      expect(result).toEqual({ kind: "no-match" });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("returns no-match when LLM returns a patternKey not in the registry", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock } = makeMockLlm({
        patternKey: "hallucinated-pattern-xyz",
        confidence: "high",
        rationale: "I made this up",
      });

      const result = await classifyCompoundViaLlm(
        "Lambda function with a DynamoDB table and an exec role allowing read write",
        registry,
        mock,
      );

      // Hallucinated keys that don't exist in registry → no-match
      expect(result).toEqual({ kind: "no-match" });
    });
  });

  describe("Variation E — low-confidence rejection", () => {
    it("returns no-match when confidence is 'low'", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock, spy } = makeMockLlm({
        patternKey: "lambda-with-dynamodb",
        confidence: "low",
        rationale: "Unsure if DynamoDB is the primary resource here",
      });

      const result = await classifyCompoundViaLlm(
        "Lambda function with a DynamoDB table and an exec role allowing read write",
        registry,
        mock,
      );

      expect(result).toEqual({ kind: "no-match" });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Variation F — short-intent threshold gate", () => {
    it("returns skipped and does NOT call LLM for short intent (3 words)", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock, spy } = makeMockLlm({
        patternKey: "sqs-with-dlq",
        confidence: "high",
        rationale: "would have matched",
      });

      const result = await classifyCompoundViaLlm(
        "make sqs queue",
        registry,
        mock,
      );

      expect(result).toEqual({ kind: "skipped" });
      expect(spy).toHaveBeenCalledTimes(0); // LLM NOT called
    });

    it("returns skipped for a 9-word intent (below default 10-word threshold)", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock, spy } = makeMockLlm({
        patternKey: "sqs-with-dlq",
        confidence: "high",
        rationale: "would have matched",
      });

      const result = await classifyCompoundViaLlm(
        "create an sqs queue with a dead letter queue",
        registry,
        mock,
      );

      // 9 words: "create an sqs queue with a dead letter queue"
      expect(result).toEqual({ kind: "skipped" });
      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("calls LLM for a 10-word intent (at threshold)", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock, spy } = makeMockLlm({
        patternKey: null,
        confidence: "high",
        rationale: "no match",
      });

      await classifyCompoundViaLlm(
        "create an sqs queue with a dead letter queue now",
        registry,
        mock,
        undefined,
        { minIntentWords: 10 },
      );

      // 10 words → threshold met → LLM called
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("respects minIntentWords override", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock, spy } = makeMockLlm({
        patternKey: null,
        confidence: "high",
        rationale: "no match",
      });

      // With minIntentWords=3, a 3-word intent should now call the LLM
      const result = await classifyCompoundViaLlm(
        "make sqs queue",
        registry,
        mock,
        undefined,
        { minIntentWords: 3 },
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ kind: "no-match" }); // LLM returned null
    });
  });

  describe("callsite token", () => {
    it("passes callsite 'intent-parser/compound-classifier-llm' on every call", async () => {
      const registry = makeRegistry(TEST_PATTERNS);
      const { mock, spy } = makeMockLlm({
        patternKey: null,
        confidence: "high",
        rationale: "no match",
      });

      await classifyCompoundViaLlm(
        "Lambda function with a DynamoDB table and an exec role allowing read write",
        registry,
        mock,
        "test-run-id-001",
      );

      expect(spy).toHaveBeenCalledTimes(1);
      const opts = spy.mock.calls[0]?.[2] as LlmCallOptions | undefined;
      expect(opts?.callsite).toBe("intent-parser/compound-classifier-llm");
      expect(opts?.runId).toBe("test-run-id-001");
    });
  });
});
