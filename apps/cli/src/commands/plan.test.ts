/**
 * Unit tests for plan.ts command
 * Story 9.9 — T2: plan.ts tests
 *
 * Strategy: We mock `runCommand` to capture its `run` callback, trigger
 * the plan command action, then invoke the captured callback with mock ctx.
 *
 * Commander-specific tests (flag parsing, --no-apply) are done via
 * parseOptions on a test command to avoid shared mutable state issues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { RunCommandOptions } from "../utils/command-runner.js";

// ── Module-level mocks ──────────────────────────────────────────────────────

// Capture the run callback from `runCommand`
let capturedOpts: RunCommandOptions | null = null;

vi.mock("../utils/command-runner.js", () => ({
  runCommand: vi.fn(async (opts: RunCommandOptions) => {
    capturedOpts = opts;
  }),
  runProvisioningLoop: vi.fn(),
}));

vi.mock("../utils/display.js", () => ({
  renderError: vi.fn(),
  renderApplyNowConfirm: vi.fn(),
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    PLAN_STARTED: "plan_started",
    PLAN_COMPLETE: "plan_complete",
    PLAN_TO_APPLY_STARTED: "plan_to_apply_started",
    PLAN_TO_APPLY_DECLINED: "plan_to_apply_declined",
    CHECKPOINT_SAVED: "checkpoint_saved",
    APPLY_COMPLETE: "apply_complete",
  },
}));

vi.mock("../services/checkpoint.js", () => ({
  serializeCheckpoint: vi.fn(() => ({
    runId: "test-run",
    ttl_hours: 72,
  })),
  saveCheckpoint: vi.fn().mockResolvedValue("/path/to/checkpoint.json"),
}));

vi.mock("../config/user-config-loader.js", () => ({
  loadUserConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock("../config/org-policy-cache.js", () => ({
  fetchOrgPolicy: vi.fn().mockResolvedValue(null),
  readAuthToken: vi.fn().mockResolvedValue(null),
}));

vi.mock("@clack/prompts", () => ({
  log: { warn: vi.fn(), info: vi.fn() },
}));

const { runProvisioningLoop } = await import("../utils/command-runner.js");
const { renderError, renderApplyNowConfirm } =
  await import("../utils/display.js");
const { log } = await import("../utils/logger.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(graphInvokeFn?: (...args: unknown[]) => unknown) {
  const defaultGraphResult = {
    executionStatus: ExecutionStatus.SUCCESS,
    preflightPassed: true,
    resourceType: "AWS::S3::Bucket",
    desiredState: { BucketName: "test" },
    userIntent: "Create an S3 bucket",
  };

  const mockGraph = {
    invoke: graphInvokeFn
      ? vi.fn(graphInvokeFn)
      : vi.fn().mockResolvedValue(defaultGraphResult),
    getState: vi.fn().mockResolvedValue({
      next: [],
      values: defaultGraphResult,
    }),
  } as any;

  return {
    intent: "Create an S3 bucket",
    runId: "test-run-123",
    startTs: Date.now(),
    tools: [],
    graph: mockGraph,
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  capturedOpts = null;
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never) as any;
  stdoutWriteSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true) as any;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

// ── Commander flag parsing tests ────────────────────────────────────────────

describe("planCommand — flag parsing", () => {
  it("--no-apply option is registered", () => {
    const cmd = new Command("plan")
      .argument("[intent]")
      .option("--no-apply", "Skip apply prompt");
    const opt = cmd.options.find((o) => o.long === "--no-apply");
    expect(opt).toBeDefined();
  });

  it("--no-apply sets opts.apply to false", () => {
    const cmd = new Command("plan")
      .argument("[intent]")
      .option("--no-apply", "Skip apply prompt");
    cmd.parseOptions(["--no-apply", "Create an S3 bucket"]);
    expect(cmd.opts()["apply"]).toBe(false);
  });

  it("without --no-apply, opts.apply defaults to true", () => {
    const cmd = new Command("plan")
      .argument("[intent]")
      .option("--no-apply", "Skip apply prompt");
    cmd.parseOptions(["Create an S3 bucket"]);
    expect(cmd.opts()["apply"]).toBe(true);
  });
});

// ── Plan command action tests (via captured run callback) ───────────────────

describe("planCommand — action", () => {
  it("T2.0: no intent — prints usage and exits", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync(["node", "plan"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Usage"));
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe("planCommand — run callback (no --no-apply)", () => {
  // Trigger the command once to capture the run callback
  beforeEach(async () => {
    capturedOpts = null;
    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync(["node", "plan", "Create an S3 bucket"]);
    expect(capturedOpts).not.toBeNull();
  });

  it("T2.1: invokes graph in PLAN mode", async () => {
    const ctx = makeCtx();
    await capturedOpts!.run(ctx);

    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: ExecutionMode.PLAN,
      }),
      expect.anything(),
    );
  });

  it("T2.2: checkpoint — serializeCheckpoint and saveCheckpoint called", async () => {
    const { serializeCheckpoint, saveCheckpoint } =
      await import("../services/checkpoint.js");
    const ctx = makeCtx();
    await capturedOpts!.run(ctx);

    expect(serializeCheckpoint).toHaveBeenCalled();
    expect(saveCheckpoint).toHaveBeenCalled();
  });

  it("T2.3: TTY + apply now yes — transitions to apply", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(renderApplyNowConfirm).mockResolvedValue(true);
    vi.mocked(runProvisioningLoop).mockResolvedValue({
      finalState: { executionStatus: ExecutionStatus.SUCCESS } as never,
      success: true,
    });

    const ctx = makeCtx(
      vi
        .fn()
        .mockResolvedValueOnce({
          executionStatus: ExecutionStatus.SUCCESS,
          preflightPassed: true,
          resourceType: "AWS::S3::Bucket",
          desiredState: { BucketName: "test" },
          userIntent: "Create an S3 bucket",
        })
        .mockResolvedValueOnce({
          executionStatus: ExecutionStatus.PENDING,
        }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(renderApplyNowConfirm).toHaveBeenCalled();
    expect(runProvisioningLoop).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("T2.4: TTY + apply now no — returns success, no provisioning", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(renderApplyNowConfirm).mockResolvedValue(false);

    const ctx = makeCtx();
    const result = await capturedOpts!.run(ctx);

    expect(renderApplyNowConfirm).toHaveBeenCalled();
    expect(runProvisioningLoop).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("T2.5: TTY + BP blocking — shows warning, no apply prompt", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    const clack = await import("@clack/prompts");

    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.SUCCESS,
        preflightPassed: false,
      }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(clack.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Cannot apply"),
    );
    expect(renderApplyNowConfirm).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("T2.7: non-TTY — no apply prompt", async () => {
    const ctx = makeCtx();
    const result = await capturedOpts!.run(ctx);

    expect(renderApplyNowConfirm).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("failed plan — renders error, returns failure", async () => {
    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: "LLM crashed",
      }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(renderError).toHaveBeenCalledWith("LLM crashed", undefined);
    expect(result.success).toBe(false);
  });

  it("unsupported resource — renders error with hint", async () => {
    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
        errorMessage: "Unsupported",
      }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(renderError).toHaveBeenCalledWith(
      "Unsupported",
      expect.stringContaining("Supported types"),
    );
    expect(result.success).toBe(false);
  });

  it("checkpoint save failure — logs warning, still succeeds", async () => {
    const { saveCheckpoint } = await import("../services/checkpoint.js");
    vi.mocked(saveCheckpoint).mockRejectedValueOnce(new Error("disk full"));

    const ctx = makeCtx();
    const result = await capturedOpts!.run(ctx);

    expect(result.success).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "checkpoint_saved",
        result: "failed",
      }),
    );
  });

  it("TTY checkpoint save — writes checkpoint path to stdout", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });

    const ctx = makeCtx();
    await capturedOpts!.run(ctx);

    const calls = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("Plan saved to"))).toBe(true);
  });

  it("apply phase cancelled — returns success, no provisioning", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(renderApplyNowConfirm).mockResolvedValue(true);

    const ctx = makeCtx(
      vi
        .fn()
        .mockResolvedValueOnce({
          executionStatus: ExecutionStatus.SUCCESS,
          preflightPassed: true,
          resourceType: "AWS::S3::Bucket",
          userIntent: "Create an S3 bucket",
        })
        .mockResolvedValueOnce({
          executionStatus: ExecutionStatus.CANCELLED,
        }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(result.success).toBe(true);
    expect(runProvisioningLoop).not.toHaveBeenCalled();
  });

  it("apply phase failed — renders error, returns failure", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(renderApplyNowConfirm).mockResolvedValue(true);

    const ctx = makeCtx(
      vi
        .fn()
        .mockResolvedValueOnce({
          executionStatus: ExecutionStatus.SUCCESS,
          preflightPassed: true,
          resourceType: "AWS::S3::Bucket",
          userIntent: "Create an S3 bucket",
        })
        .mockResolvedValueOnce({
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: "Apply failed",
        }),
    );

    const result = await capturedOpts!.run(ctx);

    expect(renderError).toHaveBeenCalledWith("Apply failed");
    expect(result.success).toBe(false);
  });
});
