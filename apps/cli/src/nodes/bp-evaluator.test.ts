/**
 * Tests for bp_evaluator node (Story 12.3).
 * Verifies that the node evaluates best practices against resource config
 * and stores findings in graph state.
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
import type { BPFinding, BestPractice } from "@assignee/best-practices";
import type { AgentState } from "../services/graph.js";

// Mock loadBestPractices to return controlled fixtures. verifyManifest and
// computeManifest are also mocked so integrity-mode tests can simulate
// tampering / TOFU / missing reference scenarios without touching the real
// packaged manifest.
vi.mock("@assignee/best-practices", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@assignee/best-practices");
  return {
    ...actual,
    loadBestPractices: vi.fn(),
    computeFreshness: vi.fn(() => ({
      oldestFileDate: new Date().toISOString(),
      oldestAgeDays: 1,
      fileCount: 10,
      isStale: false,
      staleThresholdDays: 180,
    })),
    computeManifest: vi.fn(() => ({
      version: 1 as const,
      hash: "a".repeat(64),
      files: { "s3/BP-S3-001.yaml": "a".repeat(64) },
      count: 1,
      generatedAt: new Date().toISOString(),
    })),
    verifyManifest: vi.fn(() => ({ valid: true })),
  };
});

// Suppress logger output
vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    BP_EVALUATED: "bp_evaluated",
    BP_EVALUATION_SKIPPED: "bp_evaluation_skipped",
    MCP_OPTIONAL_INIT_FAILED: "mcp_optional_init_failed",
  },
}));

import {
  bpEvaluatorNode,
  resetBPCache,
  BpIntegrityError,
  BpIntegrityMode,
  resolveBpIntegrityMode,
} from "./bp-evaluator.js";
import { loadBestPractices, verifyManifest } from "@assignee/best-practices";

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
  blocking: true,
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

  it("returns findings with blocking: true for blocking practices", async () => {
    vi.mocked(loadBestPractices).mockReturnValue([S3_ENCRYPTION_BP]);

    const state = makeState({
      desiredState: {
        BucketName: "my-bucket",
        // No encryption configured — should trigger blocking finding
      },
    });

    const result = await bpEvaluatorNode(state);

    expect(result.bpFindings).toHaveLength(1);
    expect(result.bpFindings![0]!.blocking).toBe(true);
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

describe("BP integrity mode resolution (H18)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetBPCache();
  });

  it("returns 'enforce' when ASSIGNEE_BP_INTEGRITY=enforce", () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "enforce";
    expect(resolveBpIntegrityMode()).toBe(BpIntegrityMode.ENFORCE);
  });

  it("returns 'warn' when ASSIGNEE_BP_INTEGRITY=warn", () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "warn";
    expect(resolveBpIntegrityMode()).toBe(BpIntegrityMode.WARN);
  });

  it("returns 'disabled' when ASSIGNEE_BP_INTEGRITY=disabled", () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "disabled";
    expect(resolveBpIntegrityMode()).toBe(BpIntegrityMode.DISABLED);
  });

  it("defaults to 'warn' when NODE_ENV=test and no explicit override", () => {
    delete process.env["ASSIGNEE_BP_INTEGRITY"];
    process.env["NODE_ENV"] = "test";
    expect(resolveBpIntegrityMode()).toBe(BpIntegrityMode.WARN);
  });

  it("defaults to 'enforce' when NODE_ENV is production-like", () => {
    delete process.env["ASSIGNEE_BP_INTEGRITY"];
    process.env["NODE_ENV"] = "production";
    expect(resolveBpIntegrityMode()).toBe(BpIntegrityMode.ENFORCE);
  });
});

describe("BP integrity enforcement (H18)", () => {
  const originalEnv = { ...process.env };
  let stderrSpy: MockInstance;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    resetBPCache();
    vi.mocked(loadBestPractices).mockReturnValue([S3_VERSIONING_BP]);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it("ENFORCE mode: throws BpIntegrityError on hash mismatch", async () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "enforce";
    vi.mocked(verifyManifest).mockReturnValue({
      valid: false,
      reason:
        "BP library hash mismatch (expected abc…, got def…). 1 file(s) differ.",
      mismatchedFiles: ["s3/BP-S3-001.yaml"],
    });

    await expect(bpEvaluatorNode(makeState())).rejects.toThrow(
      BpIntegrityError,
    );
  });

  it("ENFORCE mode: throws when reference manifest is missing (TOFU)", async () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "enforce";
    vi.mocked(verifyManifest).mockReturnValue({
      valid: false,
      reason:
        "No reference manifest found at /tmp/fake/manifest.json. Refusing to trust BP library in strict mode.",
      trustOnFirstUse: true,
    });

    await expect(bpEvaluatorNode(makeState())).rejects.toThrow(
      /No reference manifest/,
    );
  });

  it("WARN mode: does NOT throw on hash mismatch, writes stderr warning", async () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "warn";
    vi.mocked(verifyManifest).mockReturnValue({
      valid: false,
      reason: "BP library hash mismatch",
      mismatchedFiles: ["s3/BP-S3-001.yaml"],
    });

    const result = await bpEvaluatorNode(makeState());
    expect(result.bpFindings).toBeDefined();
    expect(stderrSpy).toHaveBeenCalled();
    const messages = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toContain("BP manifest integrity check failed");
  });

  it("WARN mode: emits loud TOFU warning when manifest missing", async () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "warn";
    vi.mocked(verifyManifest).mockReturnValue({
      valid: true,
      reason: "No reference manifest (trust-on-first-use)",
      trustOnFirstUse: true,
    });

    await bpEvaluatorNode(makeState());
    const messages = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toContain("trust-on-first-use");
    expect(messages).toContain("ASSIGNEE_BP_INTEGRITY=enforce");
  });

  it("DISABLED mode: never calls verifyManifest and never throws", async () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "disabled";
    vi.mocked(verifyManifest).mockImplementation(() => {
      throw new Error("should not be called");
    });

    const result = await bpEvaluatorNode(makeState());
    expect(result.bpFindings).toBeDefined();
    expect(verifyManifest).not.toHaveBeenCalled();
  });

  it("ENFORCE mode: passes through cleanly when manifest matches", async () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "enforce";
    vi.mocked(verifyManifest).mockReturnValue({ valid: true });

    const result = await bpEvaluatorNode(makeState());
    expect(result.bpFindings).toBeDefined();
  });
});

// L-A7 regression: success-path evaluations log with BP_EVALUATED, while
// failure-path/skipped logging uses the new BP_EVALUATION_SKIPPED action so
// log scrapers and metrics can distinguish the two cases.
describe("BP log action separation (L-A7)", () => {
  let logMock: ReturnType<typeof vi.fn>;
  let stderrSpy: MockInstance;

  beforeEach(async () => {
    process.env = { ...process.env };
    delete process.env["ASSIGNEE_BP_INTEGRITY"];
    process.env["NODE_ENV"] = "test"; // → WARN mode default
    vi.clearAllMocks();
    resetBPCache();
    vi.mocked(loadBestPractices).mockReturnValue([S3_VERSIONING_BP]);
    const loggerModule = await import("../utils/logger.js");
    logMock = vi.mocked(loggerModule.log);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("uses BP_EVALUATED for the successful evaluation summary log", async () => {
    vi.mocked(verifyManifest).mockReturnValue({ valid: true });
    const result = await bpEvaluatorNode(
      makeState({
        resourceType: "AWS::S3::Bucket",
        desiredState: {
          BucketName: "my-bucket",
          // versioning missing → triggers a finding so the summary log fires
        },
      }),
    );
    expect(result.bpFindings).toBeDefined();

    const evaluatedCalls = logMock.mock.calls.filter((args) => {
      const event = args[0] as { action?: string };
      return event.action === "bp_evaluated";
    });
    expect(evaluatedCalls.length).toBeGreaterThan(0);
  });

  it("uses BP_EVALUATION_SKIPPED for warn-mode integrity-check failure log", async () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "warn";
    vi.mocked(verifyManifest).mockReturnValue({
      valid: false,
      reason: "BP library hash mismatch",
      mismatchedFiles: ["s3/BP-S3-001.yaml"],
    });

    await bpEvaluatorNode(makeState());

    const skippedCalls = logMock.mock.calls.filter((args) => {
      const event = args[0] as {
        action?: string;
        extras?: Record<string, unknown>;
      };
      return (
        event.action === "bp_evaluation_skipped" &&
        event.extras?.["phase"] === "integrity_check"
      );
    });
    expect(skippedCalls.length).toBeGreaterThan(0);
    // Crucially: this failure-path log must NOT use the BP_EVALUATED action.
    const wrongAction = logMock.mock.calls.filter((args) => {
      const event = args[0] as {
        action?: string;
        extras?: Record<string, unknown>;
      };
      return (
        event.action === "bp_evaluated" &&
        event.extras?.["phase"] === "integrity_check"
      );
    });
    expect(wrongAction).toHaveLength(0);
  });

  it("uses BP_EVALUATION_SKIPPED for enforce-mode integrity-check error log", async () => {
    process.env["ASSIGNEE_BP_INTEGRITY"] = "enforce";
    vi.mocked(verifyManifest).mockReturnValue({
      valid: false,
      reason: "BP library hash mismatch",
      mismatchedFiles: ["s3/BP-S3-001.yaml"],
    });

    await expect(bpEvaluatorNode(makeState())).rejects.toThrow(
      BpIntegrityError,
    );

    const skippedCalls = logMock.mock.calls.filter((args) => {
      const event = args[0] as {
        action?: string;
        extras?: Record<string, unknown>;
      };
      return (
        event.action === "bp_evaluation_skipped" &&
        event.extras?.["phase"] === "integrity_check"
      );
    });
    expect(skippedCalls.length).toBeGreaterThan(0);
  });
});
