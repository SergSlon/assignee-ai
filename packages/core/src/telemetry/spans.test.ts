/**
 * W6-04 unit tests for per-graph-node span emission.
 *
 * Acceptance criteria verified:
 *   - span emitted at graph-node entry (nodeEntry=true field)
 *   - span emitted at graph-node exit (nodeExit=true, durationMs present)
 *   - withNodeSpan instruments both entry + exit automatically
 *   - withNodeSpan emits failure errorClass on thrown error, then re-throws
 *   - HUMAN_APPROVAL node is excluded from span instrumentation
 *   - ≥13 of 14 GraphNode constants are NOT in SPAN_EXCLUDED_NODES
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  emitNodeEntry,
  emitNodeExit,
  withNodeSpan,
  SPAN_EXCLUDED_NODES,
  _clearInFlightSpansForTests,
} from "./spans.js";
import { GraphNode } from "../constants/graph-node.js";

// ── Mock the OTEL exporter ────────────────────────────────────────────

const { mockExportLogEvent } = vi.hoisted(() => ({
  mockExportLogEvent: vi.fn(),
}));

vi.mock("./otel-exporter.js", () => ({
  exportLogEvent: mockExportLogEvent,
  isOtelEnabled: vi.fn().mockReturnValue(true),
}));

// ── Setup ─────────────────────────────────────────────────────────────

const RUN_ID = "aaaabbbb-cccc-dddd-eeee-ffffgggghhhh";

beforeEach(() => {
  mockExportLogEvent.mockReset();
  mockExportLogEvent.mockResolvedValue(undefined);
  _clearInFlightSpansForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  _clearInFlightSpansForTests();
});

// ── emitNodeEntry ─────────────────────────────────────────────────────

describe("emitNodeEntry", () => {
  it("emits a log event with nodeEntry=true for an allowed node", async () => {
    const spanId = await emitNodeEntry(RUN_ID, GraphNode.INTENT_PARSER);

    expect(spanId).toBeDefined();
    expect(typeof spanId).toBe("string");
    expect(spanId!.length).toBeGreaterThan(0);

    expect(mockExportLogEvent).toHaveBeenCalledTimes(1);
    const emitted = mockExportLogEvent.mock.calls[0]![0];
    expect(emitted.action).toBe(`${GraphNode.INTENT_PARSER}.entry`);
    expect(emitted.runId).toBe(RUN_ID);
    // extras should contain nodeEntry
    expect(emitted.extras).toMatchObject({
      node: GraphNode.INTENT_PARSER,
      nodeEntry: true,
      spanId: spanId,
      traceId: RUN_ID,
    });
  });

  it("returns undefined for excluded nodes (HUMAN_APPROVAL)", async () => {
    const spanId = await emitNodeEntry(RUN_ID, GraphNode.HUMAN_APPROVAL);
    expect(spanId).toBeUndefined();
    expect(mockExportLogEvent).not.toHaveBeenCalled();
  });
});

// ── emitNodeExit ──────────────────────────────────────────────────────

describe("emitNodeExit", () => {
  it("emits a log event with nodeExit=true and durationMs after a prior entry", async () => {
    await emitNodeEntry(RUN_ID, GraphNode.PLAN_GENERATOR);
    mockExportLogEvent.mockClear();

    await emitNodeExit(RUN_ID, GraphNode.PLAN_GENERATOR, "success");

    expect(mockExportLogEvent).toHaveBeenCalledTimes(1);
    const emitted = mockExportLogEvent.mock.calls[0]![0];
    expect(emitted.action).toBe(`${GraphNode.PLAN_GENERATOR}.exit`);
    expect(emitted.result).toBe("success");
    expect(typeof emitted.durationMs).toBe("number");
    expect(emitted.extras).toMatchObject({
      node: GraphNode.PLAN_GENERATOR,
      nodeExit: true,
      result: "success",
    });
  });

  it("emits errorClass on failure exit", async () => {
    await emitNodeEntry(RUN_ID, GraphNode.RESOURCE_PROVISIONER);
    mockExportLogEvent.mockClear();

    await emitNodeExit(
      RUN_ID,
      GraphNode.RESOURCE_PROVISIONER,
      "failure",
      "AccessDeniedError",
    );

    const emitted = mockExportLogEvent.mock.calls[0]![0];
    expect(emitted.extras).toMatchObject({
      result: "failure",
      errorClass: "AccessDeniedError",
    });
  });

  it("skips excluded nodes (HUMAN_APPROVAL)", async () => {
    await emitNodeExit(RUN_ID, GraphNode.HUMAN_APPROVAL, "success");
    expect(mockExportLogEvent).not.toHaveBeenCalled();
  });

  it("still emits exit even without a prior entry (generates a new spanId)", async () => {
    // No prior emitNodeEntry call
    await emitNodeExit(RUN_ID, GraphNode.RESULT_FORMATTER, "success");
    expect(mockExportLogEvent).toHaveBeenCalledTimes(1);
    const emitted = mockExportLogEvent.mock.calls[0]![0];
    expect(emitted.extras.nodeExit).toBe(true);
  });
});

// ── withNodeSpan ──────────────────────────────────────────────────────

describe("withNodeSpan", () => {
  it("emits entry + exit events wrapping a successful handler", async () => {
    const result = await withNodeSpan(
      RUN_ID,
      GraphNode.SCHEMA_FETCHER,
      async () => {
        return "schema-data";
      },
    );

    expect(result).toBe("schema-data");
    // Entry + exit = 2 export calls
    expect(mockExportLogEvent).toHaveBeenCalledTimes(2);
    const [entryCall, exitCall] = mockExportLogEvent.mock.calls;
    expect(entryCall![0].action).toContain(".entry");
    expect(exitCall![0].action).toContain(".exit");
    expect(exitCall![0].result).toBe("success");
  });

  it("emits failure exit and re-throws when handler throws", async () => {
    await expect(
      withNodeSpan(RUN_ID, GraphNode.PREFLIGHT_GUARD, async () => {
        throw new TypeError("Bad input");
      }),
    ).rejects.toThrow("Bad input");

    // Should still emit entry + exit
    expect(mockExportLogEvent).toHaveBeenCalledTimes(2);
    const exitCall = mockExportLogEvent.mock.calls[1]!;
    expect(exitCall[0].result).toBe("failure");
    expect(exitCall[0].extras?.errorClass).toBe("TypeError");
  });

  it("does not instrument excluded nodes (HUMAN_APPROVAL) — no export calls", async () => {
    const result = await withNodeSpan(
      RUN_ID,
      GraphNode.HUMAN_APPROVAL,
      async () => "approved",
    );
    expect(result).toBe("approved");
    expect(mockExportLogEvent).not.toHaveBeenCalled();
  });
});

// ── Coverage: ≥13 of 14 GraphNode constants not excluded ──────────────

describe("SPAN_EXCLUDED_NODES coverage invariant", () => {
  it("only HUMAN_APPROVAL is excluded (≥13 of 14 nodes instrumented)", () => {
    expect(SPAN_EXCLUDED_NODES.has(GraphNode.HUMAN_APPROVAL)).toBe(true);

    const allNodes = Object.values(GraphNode);
    const instrumentedNodes = allNodes.filter(
      (n) => !SPAN_EXCLUDED_NODES.has(n),
    );

    // Must instrument ≥13 of 14 nodes
    expect(instrumentedNodes.length).toBeGreaterThanOrEqual(13);
    // Exactly 1 excluded (HUMAN_APPROVAL)
    expect(SPAN_EXCLUDED_NODES.size).toBe(1);
  });

  it("all 13+ instrumented nodes emit spans via emitNodeEntry", async () => {
    const allNodes = Object.values(GraphNode);
    const instrumentedNodes = allNodes.filter(
      (n) => !SPAN_EXCLUDED_NODES.has(n),
    );

    for (const node of instrumentedNodes) {
      mockExportLogEvent.mockClear();
      _clearInFlightSpansForTests();
      const spanId = await emitNodeEntry(RUN_ID, node);
      expect(spanId).toBeDefined();
      expect(mockExportLogEvent).toHaveBeenCalledTimes(1);
    }
  });
});
