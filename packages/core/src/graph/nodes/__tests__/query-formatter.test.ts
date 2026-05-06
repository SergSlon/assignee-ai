/**
 * Unit tests for formatQueryResult — the result-formatter branch for
 * query intents (executionStatus=QUERY_INTENT).
 *
 * HIGH 4 fix: verifies JSON output mode emits a structured envelope.
 * Existing text-mode behaviour is also covered as a regression guard.
 *
 * Story: feature-query-intent-classifier
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { ExecutionStatus } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import type { ManagedResource } from "@/list-resources/types.js";

// ── Clack mock (text-mode rendering uses clack.log.*) ────────────────────────
vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Display-output mock (renderResourceTable / renderEmptyList) ───────────────
vi.mock("@/utils/display-output/index.js", () => ({
  renderResourceTable: vi.fn(),
  renderEmptyList: vi.fn(),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("@/utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    RESULT_FORMATTED: "result_formatted",
    QUERY_RESOLVED: "query_resolved",
  },
}));

import * as clack from "@clack/prompts";
import * as displayOutput from "@/utils/display-output/index.js";
import { formatQueryResult } from "../result-formatter/formatters/query.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeResource(partial: Partial<ManagedResource> = {}): ManagedResource {
  return {
    resourceType: "AWS::CloudFront::Distribution",
    arn: "arn:aws:cloudfront::112233445566:distribution/E1234567890ABC",
    region: "global",
    createdDate: "2026-05-06T16:35:00Z",
    estimatedMonthlyCost: "$2.40/mo",
    ...partial,
  };
}

function baseState(partial: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "what's my CloudFront site URL?",
    runId: "test-run-id",
    executionMode: "apply",
    resourceType: "",
    executionStatus: ExecutionStatus.QUERY_INTENT,
    ...partial,
  } as AgentState;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("formatQueryResult", () => {
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    // Spy on stdout to capture JSON output mode writes.
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true) as unknown as MockInstance;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
  });

  // ── HIGH 4: JSON output mode ───────────────────────────────────────────────

  describe("JSON output mode (HIGH 4 fix)", () => {
    it("emits structured JSON envelope when outputFormat=json", async () => {
      const cf = makeResource();
      const state = baseState({
        outputFormat: "json",
        queryResult: {
          resourceType: "AWS::CloudFront::Distribution",
          resources: [cf],
          naturalQuestion: "what's my CloudFront site URL?",
          isEmpty: false,
        },
      });

      await formatQueryResult(state);

      // Must write to stdout, NOT call clack renderers.
      expect(stdoutSpy).toHaveBeenCalledOnce();
      const written = stdoutSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(written) as {
        status: string;
        queryResult: unknown;
      };
      expect(parsed.status).toBe("QUERY_INTENT");
      expect(parsed.queryResult).toBeDefined();

      // No clack UI rendered in JSON mode.
      expect(
        (clack.log as unknown as { success: ReturnType<typeof vi.fn> }).success,
      ).not.toHaveBeenCalled();
      expect(
        (clack.log as unknown as { info: ReturnType<typeof vi.fn> }).info,
      ).not.toHaveBeenCalled();
    });

    it("emits {status: QUERY_INTENT, queryResult: null} when no queryResult in JSON mode", async () => {
      const state = baseState({
        outputFormat: "json",
        errorMessage: "Query routing unavailable",
      });

      await formatQueryResult(state);

      const written = stdoutSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(written) as {
        status: string;
        queryResult: null;
      };
      expect(parsed.status).toBe("QUERY_INTENT");
      expect(parsed.queryResult).toBeNull();
    });

    it("does NOT call renderResourceTable in JSON mode", async () => {
      const cf = makeResource();
      const state = baseState({
        outputFormat: "json",
        queryResult: {
          resourceType: "AWS::CloudFront::Distribution",
          resources: [cf],
          naturalQuestion: "what's my cloudfront URL?",
          isEmpty: false,
        },
      });

      await formatQueryResult(state);

      expect(displayOutput.renderResourceTable).not.toHaveBeenCalled();
    });
  });

  // ── Text mode (existing behaviour regression guard) ────────────────────────

  describe("text output mode", () => {
    it("renders resource table when resources found", async () => {
      const cf = makeResource();
      const state = baseState({
        queryResult: {
          resourceType: "AWS::CloudFront::Distribution",
          resources: [cf],
          naturalQuestion: "what's my CloudFront site URL?",
          isEmpty: false,
        },
      });

      await formatQueryResult(state);

      expect(displayOutput.renderResourceTable).toHaveBeenCalledWith([cf]);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it("renders empty list message when no resources found", async () => {
      const state = baseState({
        queryResult: {
          resourceType: "AWS::S3::Bucket",
          resources: [],
          naturalQuestion: "list my S3 buckets",
          isEmpty: true,
        },
      });

      await formatQueryResult(state);

      expect(displayOutput.renderEmptyList).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it("renders helpful paragraph when queryResult is absent (no-fetcher path)", async () => {
      const state = baseState({
        errorMessage: "Query routing is not available in this context.",
      });

      await formatQueryResult(state);

      expect(
        (clack.log as unknown as { info: ReturnType<typeof vi.fn> }).info,
      ).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });
});
