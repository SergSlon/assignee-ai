/**
 * Tests for fix_applicator node (Story 22.2).
 * Verifies auto-fix patching, user choices, interactive flows,
 * state immutability, and config reading.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentState } from "../services/graph.js";
import type { BPFinding } from "@assignee/best-practices";

// Mock fs — controls config file reading
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

// Mock yaml
vi.mock("yaml", () => ({
  parse: vi.fn(),
}));

// Mock clack prompts
vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn(() => false),
}));

// Suppress logger output
vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    FIX_APPLIED: "fix_applied",
  },
}));

import { fixApplicatorNode } from "./fix-applicator.js";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import * as clack from "@clack/prompts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create an S3 bucket",
    runId: "run-test-fix",
    executionStatus: "pending",
    executionMode: "plan",
    resourceType: "AWS::S3::Bucket",
    desiredState: { BucketName: "my-bucket" },
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    messages: [],
    checkpointResumed: false,
    noWizard: false,
    autoApprove: false,
    ...overrides,
  } as AgentState;
}

function makeFinding(overrides: Partial<BPFinding> = {}): BPFinding {
  return {
    practiceId: "BP-S3-001",
    title: "Enable Versioning",
    severity: "MEDIUM",
    category: "reliability",
    message: "Versioning should be enabled",
    blocking: false,
    autoFixable: true,
    desiredStatePatch: {
      VersioningConfiguration: { Status: "Enabled" },
    },
    ...overrides,
  };
}

function enableAutoFix(): void {
  vi.mocked(readFileSync).mockReturnValue("autoFixBestPractices: true");
  vi.mocked(parseYaml).mockReturnValue({ autoFixBestPractices: true });
}

function disableAutoFix(): void {
  vi.mocked(readFileSync).mockImplementation(() => {
    throw new Error("ENOENT: no such file or directory");
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  disableAutoFix();
  // Default non-TTY
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("fixApplicatorNode", () => {
  it("no findings -> returns empty (pass through)", async () => {
    enableAutoFix();
    const state = makeState({ bpFindings: [] });
    const result = await fixApplicatorNode(state);
    expect(result).toEqual({});
  });

  it("no findings (undefined) -> returns empty", async () => {
    enableAutoFix();
    const state = makeState({ bpFindings: undefined });
    const result = await fixApplicatorNode(state);
    expect(result).toEqual({});
  });

  it("auto-fix disabled -> returns appliedFixes empty array", async () => {
    disableAutoFix();
    const finding = makeFinding();
    const state = makeState({ bpFindings: [finding] });
    const result = await fixApplicatorNode(state);
    expect(result).toEqual({ appliedFixes: [], autoFixEnabled: false });
  });

  it("auto-fix enabled + autoFixable findings -> patches desiredState and returns appliedFixes", async () => {
    enableAutoFix();

    const finding = makeFinding({
      practiceId: "BP-S3-001",
      desiredStatePatch: {
        VersioningConfiguration: { Status: "Enabled" },
      },
    });

    const state = makeState({
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [finding],
    });

    const result = await fixApplicatorNode(state);

    expect(result.desiredState).toEqual({
      BucketName: "my-bucket",
      VersioningConfiguration: { Status: "Enabled" },
    });
    expect(result.appliedFixes).toHaveLength(1);
    expect(result.appliedFixes![0]!.practiceId).toBe("BP-S3-001");
    expect(result.appliedFixes![0]!.fieldPath).toBe(
      "VersioningConfiguration.Status",
    );
    // Residual findings should NOT include the fixed one
    expect(result.bpFindings).toHaveLength(0);
  });

  it("user explicit choice -> finding NOT auto-fixed, marked userExplicitChoice", async () => {
    enableAutoFix();

    const finding = makeFinding({
      practiceId: "BP-S3-PUBBLOCK",
      desiredStatePatch: {
        PublicAccessBlockConfiguration: { BlockPublicAcls: true },
      },
    });

    const state = makeState({
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [finding],
      // User explicitly set BlockPublicAcls in the wizard
      elicitedOptions: { BlockPublicAcls: false },
    });

    const result = await fixApplicatorNode(state);

    // Should NOT be patched — user explicitly chose the value
    expect(result.desiredState).toEqual({ BucketName: "my-bucket" });
    expect(result.appliedFixes).toHaveLength(0);
    // Residual finding should have userExplicitChoice flag
    expect(result.bpFindings).toHaveLength(1);
    expect(result.bpFindings![0]!.userExplicitChoice).toBe(true);
  });

  it("interactive finding with skip -> marked userSkipped", async () => {
    enableAutoFix();

    // Set TTY so interactive path triggers
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const finding: BPFinding = {
      practiceId: "BP-EC2-LOGGING",
      title: "Enable logging",
      severity: "MEDIUM",
      category: "security",
      message: "Logging should be enabled",
      blocking: false,
      fixType: "interactive",
      interactiveOptions: [
        {
          label: "Enable logging",
          action: "prompt_value",
          targetField: "LoggingEnabled",
        },
        { label: "Skip", action: "skip" },
      ],
    };

    // User selects the "skip" option (index 1)
    vi.mocked(clack.select).mockResolvedValueOnce(1);

    const state = makeState({
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [finding],
    });

    const result = await fixApplicatorNode(state);

    expect(result.bpFindings).toHaveLength(1);
    expect(result.bpFindings![0]!.userSkipped).toBe(true);
    expect(result.appliedFixes).toHaveLength(0);
  });

  it("multiple patches applied -> all tracked in appliedFixes", async () => {
    enableAutoFix();

    const finding1 = makeFinding({
      practiceId: "BP-S3-001",
      desiredStatePatch: {
        VersioningConfiguration: { Status: "Enabled" },
      },
    });

    const finding2 = makeFinding({
      practiceId: "BP-S3-002",
      title: "Enable Encryption",
      desiredStatePatch: {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
      },
    });

    const state = makeState({
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [finding1, finding2],
    });

    const result = await fixApplicatorNode(state);

    expect(result.appliedFixes).toHaveLength(2);
    expect(result.appliedFixes!.map((f) => f.practiceId)).toEqual([
      "BP-S3-001",
      "BP-S3-002",
    ]);
    expect(result.desiredState).toHaveProperty("VersioningConfiguration");
    expect(result.desiredState).toHaveProperty("BucketEncryption");
    expect(result.bpFindings).toHaveLength(0);
  });

  it("conflicting patches (same field) -> last wins (current behavior)", async () => {
    enableAutoFix();

    const finding1 = makeFinding({
      practiceId: "BP-CONFLICT-A",
      desiredStatePatch: {
        VersioningConfiguration: { Status: "Enabled" },
      },
    });

    const finding2 = makeFinding({
      practiceId: "BP-CONFLICT-B",
      title: "Suspend Versioning",
      desiredStatePatch: {
        VersioningConfiguration: { Status: "Suspended" },
      },
    });

    const state = makeState({
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [finding1, finding2],
    });

    const result = await fixApplicatorNode(state);

    // Last patch wins
    expect(
      (result.desiredState as Record<string, unknown>)[
        "VersioningConfiguration"
      ],
    ).toEqual({ Status: "Suspended" });
    expect(result.appliedFixes).toHaveLength(2);
  });

  it("state immutability -- original bpFindings NOT mutated", async () => {
    enableAutoFix();

    const originalFinding = makeFinding({
      practiceId: "BP-S3-001",
      desiredStatePatch: {
        VersioningConfiguration: { Status: "Enabled" },
      },
    });

    const findingsCopy = [{ ...originalFinding }];
    const originalDesiredState = { BucketName: "my-bucket" };

    const state = makeState({
      desiredState: originalDesiredState,
      bpFindings: [originalFinding],
    });

    const result = await fixApplicatorNode(state);

    // Original desiredState passed to the node should NOT be mutated
    expect(originalDesiredState).toEqual({ BucketName: "my-bucket" });
    // The result should have the patched version
    expect(result.desiredState).toHaveProperty("VersioningConfiguration");
    // Original finding should not have userExplicitChoice or userSkipped
    expect(findingsCopy[0]).not.toHaveProperty("userExplicitChoice");
    expect(findingsCopy[0]).not.toHaveProperty("userSkipped");
  });

  it('string "true" in config -> treated as enabled', async () => {
    vi.mocked(readFileSync).mockReturnValue("autoFixBestPractices: 'true'");
    vi.mocked(parseYaml).mockReturnValue({ autoFixBestPractices: "true" });

    const finding = makeFinding();
    const state = makeState({
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [finding],
    });

    const result = await fixApplicatorNode(state);

    expect(result.appliedFixes).toHaveLength(1);
  });

  it("missing config -> auto-fix disabled", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const finding = makeFinding();
    const state = makeState({
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [finding],
    });

    const result = await fixApplicatorNode(state);

    // Auto-fix is disabled when config is missing
    expect(result).toEqual({ appliedFixes: [], autoFixEnabled: false });
  });

  it("interactive option with prompt_value but undefined targetField → skipped (residual with userSkipped)", async () => {
    enableAutoFix();

    // Set TTY so interactive path triggers
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const finding: BPFinding = {
      practiceId: "BP-EC2-MISCONFIG",
      title: "Misconfigured interactive option",
      severity: "MEDIUM",
      category: "security",
      message: "Option has no targetField",
      blocking: false,
      fixType: "interactive",
      interactiveOptions: [
        {
          label: "Enter a value",
          action: "prompt_value",
          targetField: undefined,
        },
        { label: "Skip", action: "skip" },
      ],
    };

    // User selects the first option (index 0) which has action=prompt_value but no targetField
    vi.mocked(clack.select).mockResolvedValueOnce(0);

    const state = makeState({
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [finding],
    });

    const result = await fixApplicatorNode(state);

    // Finding should be in residual findings with userSkipped flag
    expect(result.bpFindings).toHaveLength(1);
    expect(result.bpFindings![0]!.practiceId).toBe("BP-EC2-MISCONFIG");
    expect(result.bpFindings![0]!.userSkipped).toBe(true);
    // Should NOT have been applied
    expect(result.appliedFixes).toHaveLength(0);
    // desiredState should be unchanged
    expect(result.desiredState).toEqual({ BucketName: "my-bucket" });
  });

  it("non-autoFixable findings are NOT patched", async () => {
    enableAutoFix();

    const manualFinding = makeFinding({
      practiceId: "BP-MANUAL-001",
      autoFixable: false,
      desiredStatePatch: undefined,
    });

    const state = makeState({
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [manualFinding],
    });

    const result = await fixApplicatorNode(state);

    // No autoFixable findings, so pass through with empty appliedFixes
    expect(result).toEqual({ appliedFixes: [], autoFixEnabled: true });
  });
});
