/**
 * Unit tests for apply.ts command — action handler behavior.
 * Story 9.9 — T1: apply.ts tests
 *
 * The existing apply.test.ts covers flag parsing (Story 11.1, 11.3).
 * This file tests the action handler's `run` callback: fresh intent flow,
 * checkpoint resume, --yes auto-approve, --no-wizard, error handling, etc.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ExecutionMode,
  ExecutionStatus,
  CheckpointError,
} from "@assignee/core";
import type { RunCommandOptions } from "../utils/command-runner.js";

// ── Module-level mocks ──────────────────────────────────────────────────────

let capturedOpts: RunCommandOptions | null = null;

vi.mock("../utils/command-runner.js", () => ({
  runCommand: vi.fn(async (opts: RunCommandOptions) => {
    capturedOpts = opts;
  }),
  runProvisioningLoop: vi.fn(),
}));

vi.mock("../utils/display.js", () => ({
  renderError: vi.fn(),
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    APPLY_STARTED: "apply_started",
    APPLY_COMPLETE: "apply_complete",
    CHECKPOINT_LOADED: "checkpoint_loaded",
    CHECKPOINT_EXPIRED: "checkpoint_expired",
  },
}));

vi.mock("../services/checkpoint.js", () => ({
  findNewestValidCheckpoint: vi.fn().mockResolvedValue(null),
  loadCheckpointFromPath: vi.fn(),
}));

vi.mock("../config/user-config-loader.js", () => ({
  loadUserConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock("../config/org-policy-cache.js", () => ({
  fetchOrgPolicy: vi.fn().mockResolvedValue(null),
  readAuthToken: vi.fn().mockResolvedValue(null),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: { warn: vi.fn(), info: vi.fn() },
}));

const { runProvisioningLoop } = await import("../utils/command-runner.js");
const { renderError } = await import("../utils/display.js");
const { loadCheckpointFromPath, findNewestValidCheckpoint } =
  await import("../services/checkpoint.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(
  graphInvoke?: (...args: unknown[]) => unknown,
  overrides?: Partial<{ intent: string }>,
) {
  const defaultResult = {
    executionStatus: ExecutionStatus.PENDING,
    preflightPassed: true,
  };

  return {
    intent: overrides?.intent ?? "Create an S3 bucket",
    runId: "test-run-123",
    startTs: Date.now(),
    tools: [],
    graph: {
      invoke: graphInvoke
        ? vi.fn(graphInvoke)
        : vi.fn().mockResolvedValue(defaultResult),
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: defaultResult,
      }),
    } as any,
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  capturedOpts = null;
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never) as any;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: undefined,
    configurable: true,
  });
});

// ── No intent, no checkpoint tests ──────────────────────────────────────────

describe("applyCommand — no intent scenarios", () => {
  it("no intent + no checkpoint — prints usage and exits", async () => {
    vi.mocked(findNewestValidCheckpoint).mockResolvedValue(null);
    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync(["node", "apply"]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("--checkpoint with bad file — prints error and exits", async () => {
    vi.mocked(loadCheckpointFromPath).mockRejectedValue(
      new Error("ENOENT: file not found"),
    );

    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync([
      "node",
      "apply",
      "--checkpoint",
      "nonexistent.json",
    ]);

    expect(console.error).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("--checkpoint with CheckpointError — prints CheckpointError message", async () => {
    vi.mocked(loadCheckpointFromPath).mockRejectedValue(
      new CheckpointError("Checkpoint expired"),
    );

    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync([
      "node",
      "apply",
      "--checkpoint",
      "expired.json",
    ]);

    expect(console.error).toHaveBeenCalledWith("Checkpoint expired");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ── Run callback tests ──────────────────────────────────────────────────────

describe("applyCommand — fresh intent flow (run callback)", () => {
  beforeEach(async () => {
    capturedOpts = null;
    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync(["node", "apply", "Create an S3 bucket"]);
    expect(capturedOpts).not.toBeNull();
  });

  it("T1.1: fresh intent — invokes graph in APPLY mode", async () => {
    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.SUCCESS } as never,
      success: true,
    });

    const ctx = makeCtx();
    const result = await capturedOpts!.run(ctx);

    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: ExecutionMode.APPLY,
      }),
      expect.anything(),
    );
    expect(result.success).toBe(true);
  });

  it("T1.5: failed planning phase — renders error, returns failure", async () => {
    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: "LLM error",
      }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(renderError).toHaveBeenCalledWith("LLM error", undefined);
    expect(result.success).toBe(false);
  });

  it("T1.6: cancelled HITL — returns success, no provisioning", async () => {
    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.CANCELLED,
      }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(result.success).toBe(true);
    expect(runProvisioningLoop).not.toHaveBeenCalled();
  });

  it("unsupported resource — renders error with hint", async () => {
    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
        errorMessage: "Unsupported type",
      }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(renderError).toHaveBeenCalledWith(
      "Unsupported type",
      expect.stringContaining("Supported types"),
    );
    expect(result.success).toBe(false);
  });

  it("T1.7: provisioning loop — delegates to runProvisioningLoop", async () => {
    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.SUCCESS } as never,
      success: true,
    });

    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.PENDING,
        preflightPassed: true,
      }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(runProvisioningLoop).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("T1.8: provisioning loop failure — returns failure", async () => {
    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.FAILED } as never,
      success: false,
    });

    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.PENDING,
      }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(result.success).toBe(false);
  });
});

describe("applyCommand — --yes flag", () => {
  it("T1.3: --yes sets autoApprove in graph state", async () => {
    capturedOpts = null;
    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync([
      "node",
      "apply",
      "--yes",
      "Create an S3 bucket",
    ]);
    expect(capturedOpts).not.toBeNull();

    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.SUCCESS } as never,
      success: true,
    });

    const ctx = makeCtx();
    await capturedOpts!.run(ctx);

    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        autoApprove: true,
      }),
      expect.anything(),
    );
  });
});

describe("applyCommand — --no-wizard flag", () => {
  it("T1.4: --no-wizard sets noWizard in graph state", async () => {
    capturedOpts = null;
    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync([
      "node",
      "apply",
      "--no-wizard",
      "Create an S3 bucket",
    ]);
    expect(capturedOpts).not.toBeNull();

    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.SUCCESS } as never,
      success: true,
    });

    const ctx = makeCtx();
    await capturedOpts!.run(ctx);

    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        noWizard: true,
      }),
      expect.anything(),
    );
  });
});

describe("applyCommand — auto-detect checkpoint (intent provided)", () => {
  it("auto-detect checkpoint found + TTY user confirms → uses checkpoint", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const mockCheckpoint = {
      runId: "auto-cp-run",
      userIntent: "Create an S3 bucket",
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "test" },
      estimatedMonthlyCost: "$0.02/mo",
      preflightPassed: true,
      elicitedOptions: {},
      created_at: new Date().toISOString(),
      ttl_hours: 72,
    };

    vi.mocked(findNewestValidCheckpoint).mockResolvedValue(
      mockCheckpoint as any,
    );
    const clack = await import("@clack/prompts");
    vi.mocked(clack.confirm).mockResolvedValue(true);

    capturedOpts = null;
    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync(["node", "apply", "Create an S3 bucket"]);
    expect(capturedOpts).not.toBeNull();

    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.SUCCESS } as never,
      success: true,
    });

    const ctx = makeCtx();
    const result = await capturedOpts!.run(ctx);

    // Should invoke with checkpointResumed: true
    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointResumed: true,
      }),
      expect.anything(),
    );
    expect(result.success).toBe(true);
  });

  it("auto-detect checkpoint found + user declines → runs fresh", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const mockCheckpoint = {
      runId: "auto-cp-run",
      userIntent: "Create an S3 bucket",
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "test" },
      preflightPassed: true,
      created_at: new Date().toISOString(),
      ttl_hours: 72,
    };

    vi.mocked(findNewestValidCheckpoint).mockResolvedValue(
      mockCheckpoint as any,
    );
    const clack = await import("@clack/prompts");
    vi.mocked(clack.confirm).mockResolvedValue(false);

    capturedOpts = null;
    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync(["node", "apply", "Create an S3 bucket"]);
    expect(capturedOpts).not.toBeNull();

    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.SUCCESS } as never,
      success: true,
    });

    const ctx = makeCtx();
    const result = await capturedOpts!.run(ctx);

    // Should NOT use checkpoint (user declined), runs fresh
    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: ExecutionMode.APPLY,
      }),
      expect.anything(),
    );
    // Should not have checkpointResumed
    const invokeArgs = vi.mocked(ctx.graph.invoke).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(invokeArgs["checkpointResumed"]).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("auto-detect checkpoint error → logs warning, runs fresh", async () => {
    vi.mocked(findNewestValidCheckpoint).mockRejectedValue(
      new Error("corrupt checkpoint"),
    );

    capturedOpts = null;
    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync(["node", "apply", "Create an S3 bucket"]);
    expect(capturedOpts).not.toBeNull();

    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.SUCCESS } as never,
      success: true,
    });

    const { log } = await import("../utils/logger.js");
    const ctx = makeCtx();
    await capturedOpts!.run(ctx);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "checkpoint_expired",
      }),
    );
  });
});

describe("applyCommand — checkpoint resume flow", () => {
  it("T1.2: --checkpoint loads checkpoint and skips Phase 1", async () => {
    const mockCheckpoint = {
      runId: "checkpoint-run-id",
      userIntent: "Create an S3 bucket",
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "test" },
      estimatedMonthlyCost: "$0.02/mo",
      preflightPassed: true,
      elicitedOptions: {},
      created_at: new Date().toISOString(),
      ttl_hours: 72,
    };

    vi.mocked(loadCheckpointFromPath).mockResolvedValue(mockCheckpoint as any);

    capturedOpts = null;
    const { applyCommand } = await import("./apply.js");
    await applyCommand.parseAsync([
      "node",
      "apply",
      "--checkpoint",
      ".assignee/checkpoint.json",
    ]);
    expect(capturedOpts).not.toBeNull();

    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.SUCCESS } as never,
      success: true,
    });

    const ctx = makeCtx();
    const result = await capturedOpts!.run(ctx);

    // Should invoke graph with checkpointResumed: true
    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointResumed: true,
        resourceType: "AWS::S3::Bucket",
        executionMode: ExecutionMode.APPLY,
      }),
      expect.anything(),
    );
    expect(result.success).toBe(true);
  });
});
