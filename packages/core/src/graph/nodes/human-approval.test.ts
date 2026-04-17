/**
 * Tests for human_approval node (Story 11.2: --yes CI flag).
 * Verifies auto-approval, TTY warning, non-TTY error, audit logging,
 * and that preflight is not bypassed by --yes.
 *
 * Story 50-4 Wave 5 finale: relocated from apps/cli/src/nodes/ to
 * packages/core/src/graph/nodes/ so the in-core human-approval
 * implementation's `../../utils/display.js` + `../../utils/logger/index.js`
 * imports get mocked at core paths (not CLI paths).
 *
 * @see Story 11-2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionStatus } from "../../index.js";
import type { AgentState } from "../graph-state.js";

// Mock display functions to avoid real TTY interactions — core paths.
vi.mock("../../utils/display.js", () => ({
  renderPlanBox: vi.fn(),
  renderHitlConfirm: vi.fn(),
  renderDependencyPlan: vi.fn(),
  renderHitlCompoundConfirm: vi.fn(),
  promptFixSelection: vi.fn().mockResolvedValue(null),
}));

// Mock logger — capture calls for audit assertions.
vi.mock("../../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    PLAN_APPROVED: "plan_approved",
    PLAN_REJECTED: "plan_rejected_by_user",
    APPLY_AUTO_APPROVED: "apply_auto_approved",
  },
}));

import { humanApprovalNode } from "./human-approval.js";
import {
  renderPlanBox,
  renderHitlConfirm,
  promptFixSelection,
} from "../../utils/display.js";
import { log } from "../../utils/logger/index.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create an S3 bucket",
    runId: "run-test-approval",
    executionStatus: "pending",
    executionMode: "apply",
    resourceType: "AWS::S3::Bucket",
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    messages: [],
    autoApprove: false,
    noWizard: false,
    checkpointResumed: false,
    ...overrides,
  } as AgentState;
}

describe("humanApprovalNode", () => {
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;
  let stderrWriteSpy: { mockRestore: () => void };

  beforeEach(() => {
    vi.clearAllMocks();
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
    stderrWriteSpy.mockRestore();
  });

  // ── AC #1: autoApprove: true skips interactive prompt ──────────────
  it("autoApprove: true returns approval without interactive prompt", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const state = makeState({ autoApprove: true });
    const result = await humanApprovalNode(state);

    // Should return empty (approved) — no executionStatus: CANCELLED
    expect(result.executionStatus).toBeUndefined();
    // Should NOT call interactive confirm
    expect(renderHitlConfirm).not.toHaveBeenCalled();
    expect(renderPlanBox).not.toHaveBeenCalled();
  });

  // ── AC #3: autoApprove + TTY emits warning ─────────────────────────
  it("autoApprove: true + TTY emits warning to stderr", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const state = makeState({ autoApprove: true });
    await humanApprovalNode(state);

    expect(stderrWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Warning: --yes flag used in interactive session",
      ),
    );
  });

  // ── AC #5: no --yes + non-TTY throws error ────────────────────────
  it("autoApprove: false + non-TTY throws clear error", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const state = makeState({ autoApprove: false });

    const result = await humanApprovalNode(state);
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain(
      "Apply requires confirmation. Use --yes for non-interactive mode.",
    );
  });

  // ── AC #1 (interactive): autoApprove: false + TTY runs prompt ──────
  it("autoApprove: false + TTY runs interactive prompt (existing behaviour)", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    vi.mocked(renderHitlConfirm).mockResolvedValue(true);

    const state = makeState({ autoApprove: false });
    const result = await humanApprovalNode(state);

    expect(renderPlanBox).toHaveBeenCalled();
    expect(renderHitlConfirm).toHaveBeenCalled();
    expect(result.executionStatus).toBeUndefined();
  });

  // ── Interactive prompt — user declines ─────────────────────────────
  it("autoApprove: false + TTY + user declines sets CANCELLED", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    vi.mocked(renderHitlConfirm).mockResolvedValue(false);

    const state = makeState({ autoApprove: false });
    const result = await humanApprovalNode(state);

    expect(result.executionStatus).toBe(ExecutionStatus.CANCELLED);
  });

  // ── AC #2: audit log contains autoApproved: true and flag ──────────
  it("autoApprove: true writes audit log with autoApproved and flag", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const state = makeState({ autoApprove: true, runId: "run-audit-test" });
    await humanApprovalNode(state);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "apply_auto_approved",
        runId: "run-audit-test",
        extras: expect.objectContaining({
          autoApproved: true,
          flag: "--yes",
        }),
      }),
    );
  });
});

// ── Epic 35: Interactive fix selection flows ─────────────────────────────

describe("humanApprovalNode — interactive fix selection (Story 35.4)", () => {
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;
  let stderrWriteSpy: { mockRestore: () => void };

  beforeEach(() => {
    vi.clearAllMocks();
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    // Default: TTY mode for interactive tests
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
    stderrWriteSpy.mockRestore();
  });

  it("TTY + no fixable findings → promptFixSelection returns null, normal HITL flow", async () => {
    vi.mocked(promptFixSelection).mockResolvedValue(null);
    vi.mocked(renderHitlConfirm).mockResolvedValue(true);

    const state = makeState({ bpFindings: [] });
    const result = await humanApprovalNode(state);

    expect(renderPlanBox).toHaveBeenCalledTimes(1); // only initial render
    expect(promptFixSelection).toHaveBeenCalled();
    expect(renderHitlConfirm).toHaveBeenCalled();
    expect(result.executionStatus).toBeUndefined(); // approved
  });

  it("TTY + user fixes findings → plan re-renders, updated state returned on approval", async () => {
    const fixResult = {
      desiredState: {
        BucketName: "test",
        VersioningConfiguration: { Status: "Enabled" },
      },
      bpFindings: [], // all fixed
      appliedFixes: [
        {
          practiceId: "BP-S3-005",
          title: "Versioning",
          fieldPath: "VersioningConfiguration.Status",
          oldValue: undefined,
          newValue: "Enabled",
        },
      ],
    };

    vi.mocked(promptFixSelection).mockResolvedValue(fixResult);
    vi.mocked(renderHitlConfirm).mockResolvedValue(true);

    const state = makeState({
      bpFindings: [
        {
          practiceId: "BP-S3-005",
          title: "Versioning",
          severity: "HIGH",
          category: "security",
          message: "No versioning",
          blocking: false,
          autoFixable: true,
          desiredStatePatch: { VersioningConfiguration: { Status: "Enabled" } },
          propertyPath: "VersioningConfiguration.Status",
        },
      ],
    });

    const result = await humanApprovalNode(state);

    // Plan re-rendered after fix
    expect(renderPlanBox).toHaveBeenCalledTimes(2);
    // Second render has updated state with cleared cost
    const secondCall = vi.mocked(renderPlanBox).mock.calls[1]![0];
    expect(secondCall.desiredState).toEqual(fixResult.desiredState);
    expect(secondCall.bpFindings).toEqual([]);
    expect(secondCall.estimatedMonthlyCost).toBeUndefined(); // stale cost cleared
    expect(secondCall.pricingBreakdown).toBeUndefined();

    // Returns the fix result on approval
    expect(result.desiredState).toEqual(fixResult.desiredState);
    expect(result.bpFindings).toEqual([]);
    expect(result.appliedFixes).toHaveLength(1);
  });

  it("TTY + user fixes findings then DECLINES apply → CANCELLED, fix state NOT returned", async () => {
    const fixResult = {
      desiredState: {
        BucketName: "test",
        VersioningConfiguration: { Status: "Enabled" },
      },
      bpFindings: [],
      appliedFixes: [
        {
          practiceId: "BP-S3-005",
          title: "V",
          fieldPath: "V.S",
          oldValue: undefined,
          newValue: "Enabled",
        },
      ],
    };

    vi.mocked(promptFixSelection).mockResolvedValue(fixResult);
    vi.mocked(renderHitlConfirm).mockResolvedValue(false); // user declines

    const state = makeState();
    const result = await humanApprovalNode(state);

    expect(result.executionStatus).toBe(ExecutionStatus.CANCELLED);
    // Fix state NOT returned when cancelled
    expect(result.desiredState).toBeUndefined();
    expect(result.appliedFixes).toBeUndefined();
  });

  it("autoApprove=true → promptFixSelection NOT called, skips interactive", async () => {
    const state = makeState({ autoApprove: true });
    await humanApprovalNode(state);

    expect(promptFixSelection).not.toHaveBeenCalled();
    expect(renderPlanBox).not.toHaveBeenCalled();
  });

  it("non-TTY → promptFixSelection NOT called", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const state = makeState({ autoApprove: false });
    const result = await humanApprovalNode(state);

    expect(promptFixSelection).not.toHaveBeenCalled();
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
  });

  it("compound intent → promptFixSelection IS called (fix selection works for all flows)", async () => {
    vi.mocked(renderHitlConfirm).mockResolvedValue(true);
    const { renderHitlCompoundConfirm } =
      await import("../../utils/display.js");
    vi.mocked(renderHitlCompoundConfirm).mockResolvedValue(true);

    const state = makeState({
      resourcePattern: {
        patternId: "test",
        displayName: "Test",
        resources: [],
      } as unknown as AgentState["resourcePattern"],
      resourceQueue: [
        {
          resourceType: "AWS::S3::Bucket",
          resourceId: "r1",
          displayName: "Bucket",
        },
      ] as unknown as AgentState["resourceQueue"],
    });

    await humanApprovalNode(state);

    expect(promptFixSelection).toHaveBeenCalledWith(state);
  });

  it("checkpointResumed=true → promptFixSelection NOT called (plan-to-apply)", async () => {
    const state = makeState({ checkpointResumed: true });
    await humanApprovalNode(state);

    expect(promptFixSelection).not.toHaveBeenCalled();
  });
});
