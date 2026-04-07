/**
 * Tests for token-usage.ts — Wave 12 P0 instrumentation.
 *
 * Pins the contract that:
 *   - normalizeTokenUsage handles both Vercel AI SDK v3-v5 (promptTokens
 *     /completionTokens) and v6 (inputTokens/outputTokens) shapes
 *   - recordTokenUsage accumulates per-callsite and emits a TOKEN_USAGE
 *     log line tagged with callsite + runId
 *   - getTokenUsageSummary returns the aggregated snapshot
 *   - emitTokenUsageSummary emits exactly one summary log per call
 *   - resetTokenUsage clears the accumulator
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  normalizeTokenUsage,
  recordTokenUsage,
  getTokenUsageSummary,
  emitTokenUsageSummary,
  resetTokenUsage,
} from "./token-usage.js";

// Capture log() calls so tests can verify the structured emissions
// without relying on stderr scraping or filesystem side effects.
const { mockLog } = vi.hoisted(() => ({ mockLog: vi.fn() }));
vi.mock("./logger.js", async () => {
  const actual =
    await vi.importActual<typeof import("./logger.js")>("./logger.js");
  return {
    ...actual,
    log: mockLog,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  resetTokenUsage();
});

describe("normalizeTokenUsage", () => {
  it("returns zeros for undefined usage", () => {
    expect(normalizeTokenUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it("normalizes Vercel AI SDK v6 shape (inputTokens/outputTokens)", () => {
    expect(
      normalizeTokenUsage({
        inputTokens: 1234,
        outputTokens: 567,
        totalTokens: 1801,
      }),
    ).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
      totalTokens: 1801,
    });
  });

  it("falls back to v3-v5 shape (promptTokens/completionTokens)", () => {
    expect(
      normalizeTokenUsage({
        promptTokens: 800,
        completionTokens: 200,
      }),
    ).toEqual({
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1000, // computed from sum since totalTokens absent
    });
  });

  it("computes totalTokens from sum when SDK omits the field", () => {
    expect(
      normalizeTokenUsage({
        inputTokens: 300,
        outputTokens: 100,
        // totalTokens intentionally omitted
      }),
    ).toEqual({
      inputTokens: 300,
      outputTokens: 100,
      totalTokens: 400,
    });
  });

  it("prefers v6 fields when both shapes present (forward compat)", () => {
    expect(
      normalizeTokenUsage({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        promptTokens: 999, // legacy field — ignored
        completionTokens: 999,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });
});

describe("recordTokenUsage", () => {
  it("emits a TOKEN_USAGE log entry tagged with callsite + runId", () => {
    recordTokenUsage(
      "intent_parser",
      { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
      "run-abc-123",
    );

    expect(mockLog).toHaveBeenCalledTimes(1);
    const event = mockLog.mock.calls[0]![0];
    expect(event.action).toBe("token_usage");
    expect(event.runId).toBe("run-abc-123");
    expect(event.extras).toMatchObject({
      callsite: "intent_parser",
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
    });
  });

  it("defaults runId to 'unknown' when caller omits it", () => {
    recordTokenUsage("plan_generator", {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });

    expect(mockLog.mock.calls[0]![0].runId).toBe("unknown");
  });

  it("accumulates multiple calls to the same callsite", () => {
    recordTokenUsage("plan_generator", {
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
    });
    recordTokenUsage("plan_generator", {
      inputTokens: 800,
      outputTokens: 150,
      totalTokens: 950,
    });

    const summary = getTokenUsageSummary();
    expect(summary.totalCallCount).toBe(2);
    expect(summary.byCallsite["plan_generator"]).toEqual({
      callCount: 2,
      inputTokens: 1800,
      outputTokens: 350,
      totalTokens: 2150,
    });
  });

  it("keeps separate tallies per callsite", () => {
    recordTokenUsage("intent_parser", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    recordTokenUsage("plan_generator", {
      inputTokens: 2000,
      outputTokens: 500,
      totalTokens: 2500,
    });
    recordTokenUsage("advice_generator", {
      inputTokens: 300,
      outputTokens: 80,
      totalTokens: 380,
    });

    const summary = getTokenUsageSummary();
    expect(summary.totalCallCount).toBe(3);
    expect(summary.totalTokens).toBe(120 + 2500 + 380);
    expect(Object.keys(summary.byCallsite)).toEqual([
      "intent_parser",
      "plan_generator",
      "advice_generator",
    ]);
  });

  it("survives undefined SDK usage (defensive zero)", () => {
    recordTokenUsage("intent_parser", undefined);

    const summary = getTokenUsageSummary();
    expect(summary.totalCallCount).toBe(1);
    expect(summary.byCallsite["intent_parser"]).toEqual({
      callCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });
});

describe("getTokenUsageSummary", () => {
  it("returns zeros when no calls have been recorded", () => {
    expect(getTokenUsageSummary()).toEqual({
      totalCallCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      byCallsite: {},
    });
  });

  it("does NOT mutate the accumulator when called", () => {
    recordTokenUsage("plan_generator", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    const a = getTokenUsageSummary();
    const b = getTokenUsageSummary();
    expect(a).toEqual(b);
  });
});

describe("emitTokenUsageSummary", () => {
  it("emits exactly one TOKEN_USAGE_SUMMARY log entry", () => {
    recordTokenUsage("intent_parser", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    recordTokenUsage("plan_generator", {
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1000,
    });
    mockLog.mockClear();

    emitTokenUsageSummary("run-xyz-456");

    expect(mockLog).toHaveBeenCalledTimes(1);
    const event = mockLog.mock.calls[0]![0];
    expect(event.action).toBe("token_usage_summary");
    expect(event.runId).toBe("run-xyz-456");
    expect(event.extras).toMatchObject({
      totalCallCount: 2,
      totalInputTokens: 900,
      totalOutputTokens: 220,
      totalTokens: 1120,
    });
    expect(event.extras.byCallsite).toMatchObject({
      intent_parser: { callCount: 1, totalTokens: 120 },
      plan_generator: { callCount: 1, totalTokens: 1000 },
    });
  });

  it("emits a zero summary when no calls were made (lets analysis confirm 'no LLM use')", () => {
    emitTokenUsageSummary("run-empty");

    expect(mockLog).toHaveBeenCalledTimes(1);
    const event = mockLog.mock.calls[0]![0];
    expect(event.extras).toMatchObject({
      totalCallCount: 0,
      totalTokens: 0,
    });
  });
});

describe("resetTokenUsage", () => {
  it("clears all accumulated state", () => {
    recordTokenUsage("plan_generator", {
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
    });
    expect(getTokenUsageSummary().totalCallCount).toBe(1);

    resetTokenUsage();

    expect(getTokenUsageSummary()).toEqual({
      totalCallCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      byCallsite: {},
    });
  });
});
