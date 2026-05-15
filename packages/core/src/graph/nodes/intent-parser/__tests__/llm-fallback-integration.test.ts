/**
 * Graph-level integration test for the LLM compound-classifier fallback.
 *
 * Epic-107 Story 1 — Variations A-F probed via `createIntentParserNode`.
 *
 * Strategy:
 *   - Inject a multi-response mock LlmPort that tracks call count AND
 *     returns different structured payloads on each call:
 *       call 1 = compound-classifier response (classifyCompoundViaLlm)
 *       call 2 = intent-parser classification response (Step 4 LLM)
 *   - NO module-level vi.mock("ai") — uses pure constructor injection.
 *   - NO real Bedrock calls (CI safety per feedback_simulate_ci_no_creds).
 *
 * Scenarios verified:
 *   A. Keyword-hit — LLM never called at all (sqs-with-dlq keyword match).
 *   B. Keyword-miss → LLM compound hit (lambda-with-dynamodb, high confidence).
 *   C. Keyword-miss → LLM compound NONE → falls through to SX-1 advisory.
 *   D. Keyword-miss → LLM compound schema-rejection → falls through to advisory.
 *   E. Keyword-miss → LLM compound low-confidence → falls through to advisory.
 *   F. Short intent (3 words) → LLM never called even on keyword-miss.
 */

import { describe, it, expect } from "vitest";
import type { ZodSchema } from "zod";
import type { LlmPort, LlmCallOptions } from "../../../../ports/llm-port.js";
import type { LlmError } from "../../../../errors.js";
import type { Result } from "../../../../types/result.js";
import { ExecutionStatus } from "../../../../index.js";
import type { AgentState } from "../../../graph-state.js";
import { createIntentParserNode } from "../index.js";

// ── Multi-response mock LlmPort ───────────────────────────────────────────────

/**
 * A mock LlmPort where each call to `generateStructured` pops the next
 * response from a queue. Allows different responses for:
 *   - call 1: compound-classifier (classifyCompoundViaLlm)
 *   - call 2: resource-type classifier (Step 4 LLM in intent-parser)
 */
class SequentialMockLlm implements LlmPort {
  public readonly calls: Array<{
    prompt: string;
    options?: LlmCallOptions;
  }> = [];
  private readonly responses: Array<Result<unknown, LlmError> | "error">;

  constructor(responses: Array<unknown | "error">) {
    // "error" sentinel → return [LlmError, null]; anything else → [null, value]
    this.responses = responses.map((r) => {
      if (r === "error") return "error";
      return [null, r] as Result<unknown, LlmError>;
    });
  }

  async generateStructured<T>(
    prompt: string,
    _schema: ZodSchema<T>,
    options?: LlmCallOptions,
  ): Promise<Result<T, LlmError>> {
    this.calls.push({ prompt, options });
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("SequentialMockLlm: no more responses queued");
    }
    if (next === "error") {
      const { LlmError: E } = await import("../../../../errors.js");
      return [new E("Mock LLM schema error"), null] as const;
    }
    return next as Result<T, LlmError>;
  }

  async generateText(
    _prompt: string,
    _options?: LlmCallOptions,
  ): Promise<Result<string, LlmError>> {
    throw new Error("SequentialMockLlm.generateText not used in these tests");
  }
}

// ── Minimal AgentState fixture ────────────────────────────────────────────────

function makeState(userIntent: string): AgentState {
  return { userIntent, runId: "test-run-integration" } as AgentState;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createIntentParserNode — LLM compound-classifier fallback (integration)", () => {
  describe("Variation A — keyword-hit short-circuits both LLM calls", () => {
    it("sqs + dlq keyword match: LLM is never called", async () => {
      // SequentialMockLlm with zero responses — any LLM call would throw
      const llm = new SequentialMockLlm([]);
      const node = createIntentParserNode({ llmClient: llm });

      const result = await node(makeState("create an sqs queue with a dlq"));

      expect(result.resourcePattern?.patternId).toBe("sqs-with-dlq");
      expect(llm.calls).toHaveLength(0); // NO LLM call at all
    });
  });

  describe("Variation B — keyword-miss → LLM compound hit", () => {
    it("injects compound pattern into graph state on high-confidence LLM match", async () => {
      // Response sequence:
      //   call 1 (compound-classifier): patternKey="lambda-with-exec-role", confidence="high"
      //   (no call 2 — compound path returns early)
      const llm = new SequentialMockLlm([
        {
          patternKey: "lambda-with-exec-role",
          confidence: "high",
          rationale:
            "Compute unit with attached execution permissions compound",
        },
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      // Intent is long (>10 words) and deliberately avoids ALL keywords from
      // ALL registered patterns (no "lambda function", "create a lambda", etc.)
      // so the keyword registry returns null and the LLM fallback fires.
      const result = await node(
        makeState(
          "Set up a compute handler plus an identity role granting write access to object storage",
        ),
      );

      expect(result.resourcePattern?.patternId).toBe("lambda-with-exec-role");
      expect(result.intentKind).toBe("create");
      expect(result.executionStatus).toBeUndefined(); // Not FAILED

      // Compound classifier call should carry the callsite token
      expect(llm.calls).toHaveLength(1);
      expect(llm.calls[0]?.options?.callsite).toBe(
        "intent-parser/compound-classifier-llm",
      );
    });
  });

  describe("Variation C — keyword-miss → LLM compound NONE", () => {
    it("falls through to Step-4 LLM when compound-classifier returns null patternKey", async () => {
      // call 1 (compound-classifier): NONE → no compound match
      // call 2 (Step-4 LLM): UNSUPPORTED → SX-1 advisory path
      const llm = new SequentialMockLlm([
        {
          patternKey: null,
          confidence: "high",
          rationale:
            "No matching compound pattern — VPC peering not in catalogue",
        },
        { resourceType: "UNSUPPORTED", kind: "create" },
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      const result = await node(
        makeState(
          "Provision a VPC peering connection between us-east-1 and eu-west-1 regions with custom route tables",
        ),
      );

      // Should fall through to UNSUPPORTED (SX-1 advisory path)
      expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
      expect(result.resourcePattern).toBeUndefined();

      // Both LLM calls were made
      expect(llm.calls).toHaveLength(2);
      expect(llm.calls[0]?.options?.callsite).toBe(
        "intent-parser/compound-classifier-llm",
      );
    });
  });

  describe("Variation D — compound LLM schema rejection", () => {
    it("falls through gracefully (no crash) on schema-rejection error", async () => {
      // Intent deliberately avoids all pattern keywords so keyword-registry misses,
      // triggering the compound-classifier LLM call.
      // call 1 (compound-classifier): LLM error (schema rejection)
      // call 2 (Step-4 LLM): UNSUPPORTED → SX-1 advisory path
      const llm = new SequentialMockLlm([
        "error", // compound-classifier throws/errors
        { resourceType: "UNSUPPORTED", kind: "create" },
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      let caughtError: unknown = null;
      let result: Partial<AgentState> | undefined;
      try {
        result = await node(
          makeState(
            "Set up a compute handler plus an identity role granting write access to object storage",
          ),
        );
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeNull(); // NO crash
      expect(result?.executionStatus).toBe(
        ExecutionStatus.UNSUPPORTED_RESOURCE,
      );
      // Both LLM calls made
      expect(llm.calls).toHaveLength(2);
    });
  });

  describe("Variation E — low-confidence rejection", () => {
    it("falls through to Step-4 LLM when compound-classifier returns low confidence", async () => {
      // Intent deliberately avoids all pattern keywords so keyword-registry misses.
      // call 1 (compound-classifier): low confidence → rejected
      // call 2 (Step-4 LLM): UNSUPPORTED → SX-1 advisory path
      const llm = new SequentialMockLlm([
        {
          patternKey: "lambda-with-exec-role",
          confidence: "low",
          rationale: "Not sure if IAM role is intended as compound",
        },
        { resourceType: "UNSUPPORTED", kind: "create" },
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      const result = await node(
        makeState(
          "Set up a compute handler plus an identity role granting write access to object storage",
        ),
      );

      // Low-confidence → falls through → UNSUPPORTED (SX-1 advisory)
      expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
      expect(result.resourcePattern).toBeUndefined();
      expect(llm.calls).toHaveLength(2);
    });
  });

  describe("Variation F — short intent below threshold", () => {
    it("skips compound-classifier LLM for short intents (< 10 words)", async () => {
      // Only one LLM call should be made (Step-4, not compound-classifier)
      // because "make sqs" is only 2 words → skipped
      const llm = new SequentialMockLlm([
        { resourceType: "AWS::SQS::Queue", kind: "create" },
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      const result = await node(makeState("make sqs"));

      expect(result.resourceType).toBe("AWS::SQS::Queue");
      // Only Step-4 LLM called; compound-classifier was skipped (short intent)
      expect(llm.calls).toHaveLength(1);
      expect(llm.calls[0]?.options?.callsite).toBe("intent_parser"); // Step-4 callsite
    });
  });
});
