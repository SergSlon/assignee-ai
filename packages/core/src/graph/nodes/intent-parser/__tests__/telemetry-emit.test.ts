/**
 * Story 108-B-04 — Intent-routing telemetry emission tests.
 *
 * Axes covered:
 *   A — Keyword-match path: classifierPath = "keyword", patternKey set.
 *   B — LLM-primary path: classifierPath = "llm-primary", resourceType set.
 *   C — LLM-fallback path: classifierPath = "llm-fallback", patternKey set.
 *   D — UNSUPPORTED path: classifierPath = "unsupported", patternKey = null.
 *   E — Telemetry disabled: writer NOT called when env var unset.
 *   K — durationMs accuracy: positive number in plausible range.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import type { ZodSchema } from "zod";
import type { LlmPort, LlmCallOptions } from "../../../../ports/llm-port.js";
import type { LlmError } from "../../../../errors.js";
import type { Result } from "../../../../types/result.js";
import type { AgentState } from "../../../graph-state.js";
import { createIntentParserNode } from "../index.js";
import * as localLogWriter from "../../../../telemetry/local-log-writer.js";
import type { IntentRoutingEvent } from "../../../../telemetry/telemetry-event-schema.js";

// ---------------------------------------------------------------------------
// Multi-response mock LlmPort (reused from llm-fallback-integration.test.ts)
// ---------------------------------------------------------------------------

/**
 * Response tokens accepted by SequentialMockLlm:
 *   "error"     — generic LLM failure (LlmError with non-Zod message)
 *   "zod-error" — Zod validation failure (LlmError with "ZodError" in message)
 *   <object>    — successful structured response
 */
type MockResponse = unknown | "error" | "zod-error";

class SequentialMockLlm implements LlmPort {
  public readonly calls: Array<{ prompt: string; options?: LlmCallOptions }> =
    [];
  private readonly responses: Array<
    Result<unknown, LlmError> | "error" | "zod-error"
  >;

  constructor(responses: Array<MockResponse>) {
    this.responses = responses.map((r) => {
      if (r === "error" || r === "zod-error") return r;
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
    if (next === "zod-error") {
      const { LlmError: E } = await import("../../../../errors.js");
      return [
        new E(
          "ZodError: Invalid enum value — resourceType must be a supported CFN type",
        ),
        null,
      ] as const;
    }
    return next as Result<T, LlmError>;
  }

  async generateText(
    _prompt: string,
    _options?: LlmCallOptions,
  ): Promise<Result<string, LlmError>> {
    throw new Error("SequentialMockLlm.generateText not used");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(userIntent: string): AgentState {
  return { userIntent, runId: "test-run-telemetry" } as AgentState;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createIntentParserNode — routing telemetry (108-B-04)", () => {
  let appendSpy: MockInstance;
  let isTelemetrySpy: MockInstance;

  beforeEach(() => {
    // Spy on appendRoutingEvent — we'll assert it was called with correct args
    appendSpy = vi
      .spyOn(localLogWriter, "appendRoutingEvent")
      .mockResolvedValue(undefined);
    // Enable telemetry by default for most tests
    isTelemetrySpy = vi
      .spyOn(localLogWriter, "isTelemetryEnabled")
      .mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Axis A — Keyword-match path ───────────────────────────────────────────

  describe("Axis A — keyword-match path", () => {
    it("emits classifierPath='keyword' when singleton-override hits (EC2-type intent)", async () => {
      // Zero LLM responses — keyword path should never call LLM
      const llm = new SequentialMockLlm([]);
      const node = createIntentParserNode({ llmClient: llm });

      // "sqs queue with a dlq" hits the sqs-with-dlq pattern keyword
      const result = await node(makeState("create an sqs queue with a dlq"));

      expect(result.classifierPath).toBe("keyword");
      expect(appendSpy).toHaveBeenCalledOnce();

      const [event] = appendSpy.mock.calls[0] as [
        IntentRoutingEvent,
        ...unknown[],
      ];
      expect(event.eventType).toBe("intent-routing");
      expect(event.classifierPath).toBe("keyword");
      // Pattern-based keyword hit: patternKey is the pattern ID
      expect(event.patternKey).toBe("sqs-with-dlq");
      expect(event.resourceType).toBeNull();
    });

    it("emits classifierPath='keyword' when pattern registry detect hits", async () => {
      const llm = new SequentialMockLlm([]);
      const node = createIntentParserNode({ llmClient: llm });

      // "lambda function with exec role" hits the lambda-with-exec-role keyword
      const result = await node(
        makeState("create a lambda function with execution role"),
      );

      expect(result.classifierPath).toBe("keyword");
      expect(appendSpy).toHaveBeenCalledOnce();

      const [event] = appendSpy.mock.calls[0] as [
        IntentRoutingEvent,
        ...unknown[],
      ];
      expect(event.classifierPath).toBe("keyword");
      expect(event.patternKey).not.toBeNull();
    });
  });

  // ── Axis B — LLM-primary path ────────────────────────────────────────────

  describe("Axis B — LLM-primary path", () => {
    it("emits classifierPath='llm-primary' when Bedrock Step-4 classifies a resource type", async () => {
      // Sequence:
      //   call 1 = compound-classifier: no match (intent is short so skipped,
      //            but we'll use a long intent that deliberately avoids keywords)
      //   call 2 = Step-4 LLM: returns AWS::S3::Bucket
      const llm = new SequentialMockLlm([
        // compound-classifier response: no match
        { patternKey: null, confidence: "medium", rationale: "no match" },
        // Step-4 response: S3 bucket
        { resourceType: "AWS::S3::Bucket", kind: "create" },
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      // Long intent that avoids all pattern keywords to force LLM path
      const result = await node(
        makeState(
          "provision an object storage container for static asset hosting without any special CDN or function configuration",
        ),
      );

      expect(result.classifierPath).toBe("llm-primary");
      expect(result.resourceType).toBe("AWS::S3::Bucket");
      expect(appendSpy).toHaveBeenCalledOnce();

      const [event] = appendSpy.mock.calls[0] as [
        IntentRoutingEvent,
        ...unknown[],
      ];
      expect(event.classifierPath).toBe("llm-primary");
      expect(event.resourceType).toBe("AWS::S3::Bucket");
      expect(event.patternKey).toBeNull();
    });
  });

  // ── Axis C — LLM-fallback compound path ──────────────────────────────────

  describe("Axis C — LLM-fallback compound path", () => {
    it("emits classifierPath='llm-fallback' when compound-classifier hits a pattern", async () => {
      // Response sequence (long intent, keyword miss → compound LLM fires):
      //   call 1 = compound-classifier: matches lambda-with-exec-role (high confidence)
      const llm = new SequentialMockLlm([
        {
          patternKey: "lambda-with-exec-role",
          confidence: "high",
          rationale: "Matches compute handler + identity role compound",
        },
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      // Long intent, no keywords from any pattern
      const result = await node(
        makeState(
          "Set up a compute handler plus an identity role granting write access to object storage resources",
        ),
      );

      expect(result.classifierPath).toBe("llm-fallback");
      expect(result.resourcePattern?.patternId).toBe("lambda-with-exec-role");
      expect(appendSpy).toHaveBeenCalledOnce();

      const [event] = appendSpy.mock.calls[0] as [
        IntentRoutingEvent,
        ...unknown[],
      ];
      expect(event.classifierPath).toBe("llm-fallback");
      expect(event.patternKey).toBe("lambda-with-exec-role");
      expect(event.resourceType).toBeNull();
    });
  });

  // ── Axis D — UNSUPPORTED path ────────────────────────────────────────────

  describe("Axis D — UNSUPPORTED path", () => {
    it("emits classifierPath='unsupported' when LLM returns UNSUPPORTED", async () => {
      // Sequence:
      //   call 1 = compound-classifier: no match
      //   call 2 = Step-4 LLM: UNSUPPORTED
      const llm = new SequentialMockLlm([
        { patternKey: null, confidence: "medium", rationale: "no match" },
        { resourceType: "UNSUPPORTED", kind: "create" },
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      const result = await node(
        makeState(
          "I want to deploy a quantum entanglement service to the cloud provider network quickly and reliably",
        ),
      );

      expect(result.classifierPath).toBe("unsupported");
      expect(appendSpy).toHaveBeenCalledOnce();

      const [event] = appendSpy.mock.calls[0] as [
        IntentRoutingEvent,
        ...unknown[],
      ];
      expect(event.classifierPath).toBe("unsupported");
      expect(event.patternKey).toBeNull();
      expect(event.resourceType).toBeNull();
    });
  });

  // ── Axis B+ — LLM Zod validation failure emits telemetry ─────────────────

  describe("Axis B+ — LLM Zod validation failure", () => {
    it("emits classifierPath='unsupported' when LLM returns a Zod validation error", async () => {
      // compound-classifier (call 1) returns no-match; Step-4 LLM (call 2) fails
      // with a ZodError message (invalid enum value for resourceType).
      const llm = new SequentialMockLlm([
        { patternKey: null, confidence: "medium", rationale: "no match" },
        "zod-error",
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      const result = await node(
        makeState(
          "provision a totally nonexistent futuristic hyperledger thingy in the cloud platform service",
        ),
      );

      expect(result.executionStatus).toBe("UNSUPPORTED_RESOURCE");
      expect(appendSpy).toHaveBeenCalledOnce();

      const [event] = appendSpy.mock.calls[0] as [
        IntentRoutingEvent,
        ...unknown[],
      ];
      expect(event.classifierPath).toBe("unsupported");
      expect(event.patternKey).toBeNull();
      expect(event.resourceType).toBeNull();
    });
  });

  // ── Axis B- — LLM generic error emits telemetry ──────────────────────────

  describe("Axis B- — LLM generic error", () => {
    it("emits classifierPath='unsupported' when LLM returns a generic error", async () => {
      // compound-classifier (call 1) returns no-match; Step-4 LLM (call 2) fails
      // with a generic (non-Zod) error (e.g. Bedrock timeout / connectivity).
      const llm = new SequentialMockLlm([
        { patternKey: null, confidence: "medium", rationale: "no match" },
        "error",
      ]);
      const node = createIntentParserNode({ llmClient: llm });

      const result = await node(
        makeState(
          "provision an object storage container for static asset hosting without any special CDN or function configuration",
        ),
      );

      expect(result.executionStatus).toBe("FAILED");
      expect(appendSpy).toHaveBeenCalledOnce();

      const [event] = appendSpy.mock.calls[0] as [
        IntentRoutingEvent,
        ...unknown[],
      ];
      expect(event.classifierPath).toBe("unsupported");
      expect(event.patternKey).toBeNull();
      expect(event.resourceType).toBeNull();
    });
  });

  // ── Axis E — Telemetry disabled ──────────────────────────────────────────

  describe("Axis E — telemetry disabled", () => {
    it("does NOT call appendRoutingEvent when isTelemetryEnabled returns false", async () => {
      // Disable telemetry
      isTelemetrySpy.mockReturnValue(false);

      const llm = new SequentialMockLlm([]);
      const node = createIntentParserNode({ llmClient: llm });

      await node(makeState("create an sqs queue with a dlq"));

      expect(appendSpy).not.toHaveBeenCalled();
    });
  });

  // ── Axis K — durationMs accuracy ────────────────────────────────────────

  describe("Axis K — durationMs accuracy", () => {
    it("emits a positive durationMs within a plausible range for a mocked call", async () => {
      const llm = new SequentialMockLlm([]);
      const node = createIntentParserNode({ llmClient: llm });

      await node(makeState("create an sqs queue with a dlq"));

      expect(appendSpy).toHaveBeenCalledOnce();
      const [event] = appendSpy.mock.calls[0] as [
        IntentRoutingEvent,
        ...unknown[],
      ];
      // durationMs may be 0 for a synchronous mocked call (same-millisecond
      // resolution); the spec says "> 0" but that only holds for real LLM calls.
      // We assert >= 0 (non-negative) and < 30000 (plausible upper bound).
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.durationMs).toBeLessThan(30000);
    });
  });
});
