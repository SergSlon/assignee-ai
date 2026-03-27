/**
 * Integration tests for the plan-to-apply transition flow.
 *
 * Covers:
 * 1. humanApprovalNode with checkpointResumed=true (auto-approve, no render)
 * 2. humanApprovalNode with checkpointResumed=false (renders plan + confirm)
 * 3. humanApprovalNode with autoApprove=true (auto-approve, no render)
 * 4. State guard error messages (resource already exists)
 * 5. Error messages registry (StateMismatch resolution)
 * 6. Cost History display via renderPlanBox (formatMemoryHints)
 *
 * @see Story 10-1, Story 11-2, Story 18-3, Story 19-3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionStatus, ProvisioningError } from "@assignee/core";
import type { AgentState } from "../services/graph.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../utils/display.js", () => ({
  renderPlanBox: vi.fn(),
  renderHitlConfirm: vi.fn(),
  renderDependencyPlan: vi.fn(),
  renderHitlCompoundConfirm: vi.fn(),
  stopSpinner: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    PLAN_APPROVED: "plan_approved",
    PLAN_REJECTED: "plan_rejected_by_user",
    APPLY_AUTO_APPROVED: "apply_auto_approved",
  },
}));

import { humanApprovalNode } from "./human-approval.js";
import { renderPlanBox, renderHitlConfirm } from "../utils/display.js";
import { log } from "../utils/logger.js";
import {
  defaultErrorMessageRegistry,
  ErrorMessageRegistry,
} from "../utils/error-messages.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "../services/provisioning-port.js";
import { resourceProvisionerNode } from "./resource-provisioner.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeApprovalState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create an S3 bucket named transition-test",
    runId: "run-transition-test",
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

function createMockProvisioner(): ProvisioningPort & {
  getResource: ReturnType<typeof vi.fn>;
  createResource: ReturnType<typeof vi.fn>;
  getRequestStatus: ReturnType<typeof vi.fn>;
  deleteResource: ReturnType<typeof vi.fn>;
  updateResource: ReturnType<typeof vi.fn>;
} {
  return {
    getResource: vi.fn(),
    createResource: vi.fn(),
    getRequestStatus: vi.fn(),
    deleteResource: vi.fn(),
    updateResource: vi.fn(),
  };
}

function makeProvisionerState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an S3 bucket named plan-apply-test",
    runId: "run-prov-transition",
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "apply",
    resourceType: "AWS::S3::Bucket",
    resourceSchema: undefined,
    desiredState: { BucketName: "plan-apply-test" },
    estimatedMonthlyCost: "$0.0230/GB-month",
    requestToken: undefined,
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<typeof resourceProvisionerNode>[0];
}

// ── humanApprovalNode — checkpointResumed ────────────────────────────────────

describe("plan-to-apply transition: humanApprovalNode", () => {
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;
  let stderrWriteSpy: any;

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

  describe("checkpointResumed=true (plan-to-apply flow)", () => {
    it("returns {} (auto-approve) without calling renderPlanBox or renderHitlConfirm", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      const state = makeApprovalState({ checkpointResumed: true });
      const result = await humanApprovalNode(state);

      expect(result).toEqual({});
      expect(result.executionStatus).toBeUndefined();
      expect(renderPlanBox).not.toHaveBeenCalled();
      expect(renderHitlConfirm).not.toHaveBeenCalled();
    });

    it("logs PLAN_APPROVED with checkpointResumed: true", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      const state = makeApprovalState({
        checkpointResumed: true,
        runId: "run-cp-resumed",
      });
      await humanApprovalNode(state);

      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "plan_approved",
          runId: "run-cp-resumed",
          extras: expect.objectContaining({
            checkpointResumed: true,
            source: "plan-to-apply",
          }),
        }),
      );
    });

    it("does not emit a stderr warning (unlike autoApprove+TTY)", async () => {
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

      const state = makeApprovalState({ checkpointResumed: true });
      await humanApprovalNode(state);

      expect(stderrWriteSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Warning"),
      );
    });
  });

  describe("checkpointResumed=false (fresh apply)", () => {
    it("calls renderPlanBox AND renderHitlConfirm for single-resource intents", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      vi.mocked(renderHitlConfirm).mockResolvedValue(true);

      const state = makeApprovalState({ checkpointResumed: false });
      const result = await humanApprovalNode(state);

      expect(renderPlanBox).toHaveBeenCalledWith(state);
      expect(renderHitlConfirm).toHaveBeenCalledWith(state);
      expect(result.executionStatus).toBeUndefined();
    });

    it("logs PLAN_APPROVED without checkpointResumed extras", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      vi.mocked(renderHitlConfirm).mockResolvedValue(true);

      const state = makeApprovalState({ checkpointResumed: false });
      await humanApprovalNode(state);

      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "plan_approved",
        }),
      );
      // The non-checkpoint log call should NOT have checkpointResumed in extras
      const logCalls = vi.mocked(log).mock.calls;
      const approvedCall = logCalls.find(
        (call) =>
          (call[0] as any).action === "plan_approved",
      );
      expect(approvedCall).toBeDefined();
      const extras = (approvedCall![0] as any).extras as
        | Record<string, unknown>
        | undefined;
      expect(extras).toBeUndefined();
    });
  });

  describe("autoApprove=true (--yes flag)", () => {
    it("auto-approves without any render calls", async () => {
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

      const state = makeApprovalState({ autoApprove: true });
      const result = await humanApprovalNode(state);

      expect(result).toEqual({});
      expect(renderPlanBox).not.toHaveBeenCalled();
      expect(renderHitlConfirm).not.toHaveBeenCalled();
    });

    it("logs APPLY_AUTO_APPROVED (not PLAN_APPROVED)", async () => {
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

      const state = makeApprovalState({ autoApprove: true });
      await humanApprovalNode(state);

      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "apply_auto_approved",
          extras: expect.objectContaining({
            autoApproved: true,
            flag: "--yes",
          }),
        }),
      );
    });
  });
});

// ── State guard error messages ───────────────────────────────────────────────

describe("plan-to-apply transition: state guard error messages", () => {
  let mockProvisioner: ReturnType<typeof createMockProvisioner>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvisioner = createMockProvisioner();
  });

  it('error message contains "already exists" and "Choose a different name" when resource exists', async () => {
    mockProvisioner.getResource.mockResolvedValueOnce([null, {}]);

    const result = await resourceProvisionerNode(
      makeProvisionerState(),
      mockProvisioner,
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/already exists/);
    expect(result.errorMessage).toMatch(/Choose a different name/);
    expect(result.errorMessage).toContain("plan-apply-test");
  });

  it('ProvisioningError has code "StateMismatch"', async () => {
    mockProvisioner.getResource.mockResolvedValueOnce([null, {}]);

    const result = await resourceProvisionerNode(
      makeProvisionerState(),
      mockProvisioner,
    );

    expect(result.error).toBeInstanceOf(ProvisioningError);
    expect((result.error as ProvisioningError).provisioningCode).toBe(
      "StateMismatch",
    );
  });

  it("does not call createResource when state guard catches existing resource", async () => {
    mockProvisioner.getResource.mockResolvedValueOnce([null, {}]);

    await resourceProvisionerNode(makeProvisionerState(), mockProvisioner);

    expect(mockProvisioner.createResource).not.toHaveBeenCalled();
  });
});

// ── Error messages registry ──────────────────────────────────────────────────

describe("plan-to-apply transition: error messages registry", () => {
  it('resolves ProvisioningError with code "StateMismatch" to correct entry', () => {
    const error = new ProvisioningError(
      "Resource already exists (my-bucket)",
      "StateMismatch",
    );
    const entry = defaultErrorMessageRegistry.resolve(error);

    expect(entry.what).toContain("Resource already exists");
    expect(entry.howToFix).toContain("Choose a different name");
    expect(entry.code).toBe("StateMismatch");
  });

  it("StateMismatch entry has all three structured fields (what/why/howToFix)", () => {
    const entry = defaultErrorMessageRegistry.get("StateMismatch");

    expect(entry).toBeDefined();
    expect(entry!.what).toBeTruthy();
    expect(entry!.why).toBeTruthy();
    expect(entry!.howToFix).toBeTruthy();
  });

  it('resolves error message string containing "already exists" to AlreadyExists entry', () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "Resource already exists (my-bucket). Choose a different name.",
    );

    expect(entry.code).toBe("AlreadyExists");
  });
});

// ── Cost History display (formatMemoryHints via renderPlanBox) ───────────────

describe("plan-to-apply transition: cost history display", () => {
  let stdoutChunks: string[];
  let stdoutSpy: any;
  let originalStdoutIsTTY: boolean | undefined;

  beforeEach(() => {
    originalStdoutIsTTY = process.stdout.isTTY;
    // Force non-TTY for plain-text output (no ANSI codes)
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    stdoutChunks = [];
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it('warning hint (starts with ⚠) gets "Warning:" label', async () => {
    // Need the real renderPlanBox, not the mock
    vi.doUnmock("../utils/display.js");
    const { renderPlanBox: realRenderPlanBox } = await import(
      "../utils/display.js"
    );

    realRenderPlanBox({
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "warn-test" },
      estimatedMonthlyCost: "~$0.02/month",
      runId: "run-warn-test",
      executionMode: "plan",
      memoryHints: ["⚠ Previous deployment failed after 3 retries"],
    });

    const output = stdoutChunks.join("");
    expect(output).toContain("Warning:");
    expect(output).toContain("Previous deployment failed after 3 retries");

    // Re-mock for subsequent tests
    vi.doMock("../utils/display.js", () => ({
      renderPlanBox: vi.fn(),
      renderHitlConfirm: vi.fn(),
      renderDependencyPlan: vi.fn(),
      renderHitlCompoundConfirm: vi.fn(),
      stopSpinner: vi.fn(),
    }));
  });

  it('cost history hint gets "Cost History:" label', async () => {
    vi.doUnmock("../utils/display.js");
    const { renderPlanBox: realRenderPlanBox } = await import(
      "../utils/display.js"
    );

    realRenderPlanBox({
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "cost-test" },
      estimatedMonthlyCost: "~$0.02/month",
      runId: "run-cost-test",
      executionMode: "plan",
      memoryHints: ["Last deployed: $0.50/mo avg"],
    });

    const output = stdoutChunks.join("");
    expect(output).toContain("Cost History:");
    expect(output).toContain("Last deployed: $0.50/mo avg");

    vi.doMock("../utils/display.js", () => ({
      renderPlanBox: vi.fn(),
      renderHitlConfirm: vi.fn(),
      renderDependencyPlan: vi.fn(),
      renderHitlCompoundConfirm: vi.fn(),
      stopSpinner: vi.fn(),
    }));
  });

  it("mix of warning and cost history hints applies correct labels", async () => {
    vi.doUnmock("../utils/display.js");
    const { renderPlanBox: realRenderPlanBox } = await import(
      "../utils/display.js"
    );

    realRenderPlanBox({
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "mix-test" },
      estimatedMonthlyCost: "~$0.02/month",
      runId: "run-mix-test",
      executionMode: "plan",
      memoryHints: [
        "⚠ Failed 2 times previously",
        "Last deployed: $1.20/mo avg",
      ],
    });

    const output = stdoutChunks.join("");
    expect(output).toContain("Warning:");
    expect(output).toContain("Failed 2 times previously");
    expect(output).toContain("Cost History:");
    expect(output).toContain("Last deployed: $1.20/mo avg");

    vi.doMock("../utils/display.js", () => ({
      renderPlanBox: vi.fn(),
      renderHitlConfirm: vi.fn(),
      renderDependencyPlan: vi.fn(),
      renderHitlCompoundConfirm: vi.fn(),
      stopSpinner: vi.fn(),
    }));
  });
});
