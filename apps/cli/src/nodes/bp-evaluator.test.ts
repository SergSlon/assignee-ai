/**
 * Tests for bp_evaluator node (Story 12.3).
 * Verifies that the node evaluates best practices against resource config
 * and stores findings in graph state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BPFinding, BestPractice } from "@assignee/best-practices";
import type { AgentState } from "../services/graph.js";

// Mock loadBestPractices to return controlled fixtures
vi.mock("@assignee/best-practices", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@assignee/best-practices");
  return {
    ...actual,
    loadBestPractices: vi.fn(),
  };
});

// Suppress logger output
vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    BP_EVALUATED: "bp_evaluated",
  },
}));

import { bpEvaluatorNode, resetBPCache } from "./bp-evaluator.js";
import { loadBestPractices } from "@assignee/best-practices";

const S3_VERSIONING_BP: BestPractice = {
  id: "BP-S3-001",
  title: "Enable S3 Bucket Versioning",
  severity: "MEDIUM",
  resource_type: "AWS::S3::Bucket",
  property_path: "VersioningConfiguration.Status",
  check_type: "equals",
  expected_value: "Enabled",
  source: "https://docs.aws.amazon.com/s3/",
  description: "S3 bucket versioning should be enabled for data protection",
  remediation: "Set VersioningConfiguration.Status to Enabled",
  category: "reliability",
  lastVerified: "2026-03-18",
};

const S3_ENCRYPTION_BP: BestPractice = {
  id: "BP-S3-002",
  title: "Enable S3 Default Encryption",
  severity: "CRITICAL",
  resource_type: "AWS::S3::Bucket",
  property_path: "BucketEncryption.ServerSideEncryptionConfiguration",
  check_type: "exists",
  expected_value: undefined,
  source: "https://docs.aws.amazon.com/s3/",
  description: "S3 bucket should have default encryption enabled",
  remediation: "Configure ServerSideEncryptionConfiguration",
  category: "security",
  lastVerified: "2026-03-18",
};

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create an S3 bucket",
    runId: "run-test-bp",
    executionStatus: "pending",
    executionMode: "plan",
    resourceType: "AWS::S3::Bucket",
    desiredState: {},
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    messages: [],
    ...overrides,
  } as AgentState;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBPCache();
});

describe("bpEvaluatorNode", () => {
  it("returns findings for non-compliant S3 config (no versioning)", async () => {
    vi.mocked(loadBestPractices).mockReturnValue([S3_VERSIONING_BP]);

    const state = makeState({
      desiredState: {
        BucketName: "my-bucket",
        // No VersioningConfiguration — should trigger BP-S3-001
      },
    });

    const result = await bpEvaluatorNode(state);

    expect(result.bpFindings).toBeDefined();
    expect(result.bpFindings).toHaveLength(1);
    expect(result.bpFindings![0]!.practiceId).toBe("BP-S3-001");
    expect(result.bpFindings![0]!.severity).toBe("MEDIUM");
  });

  it("returns empty findings for compliant S3 config (versioning enabled)", async () => {
    vi.mocked(loadBestPractices).mockReturnValue([S3_VERSIONING_BP]);

    const state = makeState({
      desiredState: {
        BucketName: "my-bucket",
        VersioningConfiguration: { Status: "Enabled" },
      },
    });

    const result = await bpEvaluatorNode(state);

    expect(result.bpFindings).toBeDefined();
    expect(result.bpFindings).toHaveLength(0);
  });

  it("stores findings in graph state (bpFindings field)", async () => {
    vi.mocked(loadBestPractices).mockReturnValue([
      S3_VERSIONING_BP,
      S3_ENCRYPTION_BP,
    ]);

    const state = makeState({
      desiredState: {
        BucketName: "my-bucket",
        // Neither versioning nor encryption configured
      },
    });

    const result = await bpEvaluatorNode(state);

    expect(result.bpFindings).toBeDefined();
    expect(result.bpFindings).toHaveLength(2);

    const ids = result.bpFindings!.map((f) => f.practiceId);
    expect(ids).toContain("BP-S3-001");
    expect(ids).toContain("BP-S3-002");
  });

  it("does not fire findings for a non-matching resource type", async () => {
    vi.mocked(loadBestPractices).mockReturnValue([S3_VERSIONING_BP]);

    const state = makeState({
      resourceType: "AWS::Lambda::Function",
      desiredState: { FunctionName: "my-fn" },
    });

    const result = await bpEvaluatorNode(state);

    expect(result.bpFindings).toBeDefined();
    expect(result.bpFindings).toHaveLength(0);
  });

  it("caches loaded practices across invocations", async () => {
    vi.mocked(loadBestPractices).mockReturnValue([S3_VERSIONING_BP]);

    const state = makeState();
    await bpEvaluatorNode(state);
    await bpEvaluatorNode(state);

    // Should only load once due to caching
    expect(loadBestPractices).toHaveBeenCalledTimes(1);
  });
});
