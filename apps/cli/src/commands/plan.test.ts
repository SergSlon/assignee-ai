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
import type { MockInstance } from "vitest";
import { Command } from "commander";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type {
  CommandContext,
  RunCommandOptions,
} from "../utils/command-runner.js";

// ── Module-level mocks ──────────────────────────────────────────────────────

// Capture the run callback from `runCommand`
let capturedOpts: RunCommandOptions | null = null;

vi.mock("../utils/command-runner.js", () => ({
  runCommand: vi.fn(async (opts: RunCommandOptions) => {
    capturedOpts = opts;
  }),
  runProvisioningLoop: vi.fn(),
}));

// Story 50-2: renderApplyNowConfirm was collapsed into renderHitlConfirm.
// Both identifiers point at the SAME vi.fn so legacy tests that assert
// `renderApplyNowConfirm` and new tests that assert `renderHitlConfirm`
// share a single call log — the underlying implementation is one function.
// Uses vi.hoisted so the shared mock reference is available to the
// (also-hoisted) vi.mock factory above any subsequent `import`.
const { sharedApprovalConfirm } = vi.hoisted(() => ({
  sharedApprovalConfirm: vi.fn(),
}));
vi.mock("../utils/display.js", () => ({
  renderError: vi.fn(),
  renderApplyNowConfirm: sharedApprovalConfirm,
  renderHitlConfirm: sharedApprovalConfirm,
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

vi.mock("@assignee/core/checkpoint", () => ({
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
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
}));

const { runProvisioningLoop } = await import("../utils/command-runner.js");
// Story 50-2: orchestrator now calls renderHitlConfirm (unified confirm);
// renderApplyNowConfirm is a deprecated alias. Import both so legacy tests
// can reference either — they point to the same underlying mock instance.
const { renderError, renderHitlConfirm } = await import("../utils/display.js");
// Back-compat: keep the old identifier wired to the same vi.fn so older
// test bodies that assert `renderApplyNowConfirm` still read the call log.
const renderApplyNowConfirm = renderHitlConfirm;
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
  } as unknown as CommandContext["graph"];

  return {
    intent: "Create an S3 bucket",
    runId: "test-run-123",
    startTs: Date.now(),
    tools: [],
    graph: mockGraph,
  };
}

let stdoutWriteSpy: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  capturedOpts = null;
  vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  stdoutWriteSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
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
    // Wave 18: strengthened — assert by long-flag name. The previous
    // `toBeDefined()` would have passed for any non-undefined Option
    // object the find() returned, even one with a different long flag.
    expect(opt?.long).toBe("--no-apply");
    expect(opt?.description).toBe("Skip apply prompt");
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
  it("T2.0: no intent — throws with usage message", async () => {
    const { planCommand } = await import("./plan.js");
    await expect(planCommand.parseAsync(["node", "plan"])).rejects.toThrow(
      "Missing intent",
    );
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
      await import("@assignee/core/checkpoint");
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
    // Exit non-zero so CI can detect blocking findings
    expect(result.success).toBe(false);
  });

  it("T2.6: TTY + preflightPassed=false but no blocking findings after fix → shows apply prompt", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    // Simulate: preflight failed originally, but interactive fix removed all blocking findings
    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.SUCCESS,
        preflightPassed: false,
        bpFindings: [
          {
            practiceId: "BP-S3-010",
            title: "S3 lifecycle",
            severity: "MEDIUM",
            category: "cost",
            message: "Missing lifecycle",
            blocking: false, // no blocking findings remain
            propertyPath: "LifecycleConfiguration",
          },
        ],
      }),
    );

    const result = await capturedOpts!.run(ctx);

    // Should NOT show the blocking warning — blocking findings were resolved
    const clack = await import("@clack/prompts");
    expect(clack.log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Cannot apply"),
    );
    // Should show the apply prompt since blockers are gone
    expect(renderApplyNowConfirm).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("P1-1: blocking findings removed after interactive fix → 'Apply now?' prompt appears", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    // Graph returns preflightPassed=false (blockers existed at evaluation time),
    // but result-formatter's promptFixSelection already removed all blocking findings
    // from bpFindings (simulating the user fixing them interactively).
    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.SUCCESS,
        preflightPassed: false,
        resourceType: "AWS::S3::Bucket",
        desiredState: {
          BucketName: "test",
          PublicAccessBlockConfiguration: { BlockPublicAcls: true },
        },
        userIntent: "Create an S3 bucket",
        bpFindings: [
          {
            practiceId: "BP-S3-010",
            title: "S3 lifecycle",
            severity: "MEDIUM",
            category: "cost",
            message: "Missing lifecycle",
            blocking: false, // was blocking, but fix resolved it
            propertyPath: "LifecycleConfiguration",
          },
        ],
      }),
    );

    vi.mocked(renderApplyNowConfirm).mockResolvedValue(false);
    const result = await capturedOpts!.run(ctx);

    // The blocking re-check in plan.ts should see no remaining blockers
    // and present the "Apply now?" prompt instead of the "Cannot apply" warning
    const clack = await import("@clack/prompts");
    expect(clack.log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Cannot apply"),
    );
    expect(renderApplyNowConfirm).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("P1-1b: plan with no findings (all checks passed) shows no fix prompt and offers apply", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const ctx = makeCtx(() =>
      Promise.resolve({
        executionStatus: ExecutionStatus.SUCCESS,
        preflightPassed: true,
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test" },
        userIntent: "Create an S3 bucket",
        bpFindings: [], // no findings at all — "All checks passed"
      }),
    );

    vi.mocked(renderApplyNowConfirm).mockResolvedValue(false);
    const result = await capturedOpts!.run(ctx);

    // No blocking warning, apply prompt appears
    const clack = await import("@clack/prompts");
    expect(clack.log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Cannot apply"),
    );
    expect(renderApplyNowConfirm).toHaveBeenCalled();
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

    // Item 4b (2026-04-10): the fallback hint is no longer undefined —
    // every FAILED plan now carries a guide-the-user default hint that
    // suggests `--verbose` and lists the most common root causes.
    expect(renderError).toHaveBeenCalledWith(
      "LLM crashed",
      expect.stringContaining("--verbose"),
    );
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
      expect.stringContaining("What you can create"),
    );
    expect(result.success).toBe(false);
  });

  it("checkpoint save failure — logs warning, still succeeds", async () => {
    const { saveCheckpoint } = await import("@assignee/core/checkpoint");
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

    // Item 4b (2026-04-10): the errorMessage is still forwarded
    // verbatim, but the fallback hint was rewritten to guide the
    // user toward `assignee plan` + `--verbose` instead of a
    // blame-flavored "Check the error details above".
    expect(renderError).toHaveBeenCalledWith(
      "Apply failed",
      expect.stringContaining("assignee plan"),
    );
    const [, hint] = vi.mocked(renderError).mock.calls[0]!;
    expect(hint).toMatch(/--verbose/);
    expect(result.success).toBe(false);
  });
});

// ── P1-6: --no-apply skips renderApplyNowConfirm ──────────────────────────
// MUST be last describe block — Commander is a singleton and parseAsync with
// --no-apply mutates the shared command instance's opts.

describe("planCommand — run callback (--no-apply)", () => {
  beforeEach(async () => {
    capturedOpts = null;
    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync([
      "node",
      "plan",
      "--no-apply",
      "Create an S3 bucket",
    ]);
    expect(capturedOpts).not.toBeNull();
  });

  it("P1-6: --no-apply skips renderApplyNowConfirm entirely", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const ctx = makeCtx();
    const result = await capturedOpts!.run(ctx);

    expect(renderApplyNowConfirm).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

// ── Epic 92 Wave 2.c — JSON envelope + stderr discipline (A-02 / B-04 / D-29) ──
// The `--output json` path installs a stdout interceptor in plan.ts
// that buffers per-resource NDJSON written by the formatter and
// re-emits a single top-level envelope. We exercise the interceptor
// via `runCommand`'s mocked `run` callback by having the mock write
// formatter-shaped payloads to stdout while the interceptor is live.
describe("planCommand — --output json stdout interceptor (A-02 / B-04 / D-29)", () => {
  beforeEach(() => {
    capturedOpts = null;
  });

  it("compound plan writes buffer as NDJSON then flush as a single { ok, plans:[...] } envelope", async () => {
    const { runCommand } = await import("../utils/command-runner.js");

    // Real-shape payloads — matches formatPlanResult.ts output.
    // Account IDs redacted per feedback_no_real_account_ids_in_repo.
    const s3 = {
      resourceType: "AWS::S3::Bucket",
      region: "us-east-1",
      desiredState: { BucketName: "demo" },
      estimatedMonthlyCost: "$0.023/mo",
      pricingBreakdown: null,
      bpFindings: [],
      appliedFixes: [],
      freeTierNote: null,
      adviceHints: [],
    };
    const lambda = {
      resourceType: "AWS::Lambda::Function",
      region: "us-east-1",
      desiredState: {
        FunctionName: "demo-fn",
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Role: "arn:aws:iam::210987654321:role/lambda-exec",
      },
      estimatedMonthlyCost: "$0.20/mo",
      pricingBreakdown: null,
      bpFindings: [],
      appliedFixes: [],
      freeTierNote: null,
      adviceHints: [],
    };

    // Capture raw stdout bytes across the interceptor boundary.
    const stdoutCaptured: string[] = [];
    stdoutWriteSpy.mockImplementation(((chunk: unknown) => {
      stdoutCaptured.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf8"),
      );
      return true;
    }) as never);

    // Swap in a runCommand implementation that emulates the formatter
    // by writing pretty-printed JSON payloads to stdout. The call is
    // invoked synchronously inside the CLI's action() body so the
    // interceptor is live when these writes occur.
    vi.mocked(runCommand).mockImplementationOnce(
      async (opts: RunCommandOptions) => {
        capturedOpts = opts;
        process.stdout.write(JSON.stringify(s3, null, 2) + "\n");
        process.stdout.write(JSON.stringify(lambda, null, 2) + "\n");
      },
    );

    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync([
      "node",
      "plan",
      "--output",
      "json",
      "Create an S3 and a Lambda",
    ]);

    const joined = stdoutCaptured.join("");
    // The envelope must be parseable JSON. Because the interceptor
    // buffers writes and calls the ORIGINAL write on flush, the
    // captured tail is the envelope.
    // Find the last top-level JSON value — it must be the envelope.
    const parsed = JSON.parse(joined.trim());
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.plans)).toBe(true);
    expect(parsed.plans).toHaveLength(2);
    expect(parsed.plans[0].resourceType).toBe("AWS::S3::Bucket");
    expect(parsed.plans[1].resourceType).toBe("AWS::Lambda::Function");
    // Critical: there must be NO NDJSON — only the envelope.
    // Two concatenated root objects would throw on the JSON.parse above.
  });

  it("single-resource plan flushes as { ok, plan: <payload> } (not plans array)", async () => {
    const { runCommand } = await import("../utils/command-runner.js");

    const s3 = {
      resourceType: "AWS::S3::Bucket",
      region: "us-east-1",
      desiredState: { BucketName: "demo-single" },
      estimatedMonthlyCost: "$0.023/mo",
      pricingBreakdown: null,
      bpFindings: [],
      appliedFixes: [],
      freeTierNote: null,
      adviceHints: [],
    };

    const stdoutCaptured: string[] = [];
    stdoutWriteSpy.mockImplementation(((chunk: unknown) => {
      stdoutCaptured.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf8"),
      );
      return true;
    }) as never);

    vi.mocked(runCommand).mockImplementationOnce(
      async (opts: RunCommandOptions) => {
        capturedOpts = opts;
        process.stdout.write(JSON.stringify(s3, null, 2) + "\n");
      },
    );

    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync([
      "node",
      "plan",
      "--output",
      "json",
      "Create an S3 bucket",
    ]);

    const parsed = JSON.parse(stdoutCaptured.join("").trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.plan).toEqual(s3);
    expect(parsed.plans).toBeUndefined();
  });

  it("runCommand throw — emits a single { ok:false, error:{code,message,hint} } envelope", async () => {
    const { runCommand } = await import("../utils/command-runner.js");

    const stdoutCaptured: string[] = [];
    stdoutWriteSpy.mockImplementation(((chunk: unknown) => {
      stdoutCaptured.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf8"),
      );
      return true;
    }) as never);

    const { AssigneeError } = await import("@assignee/core");
    vi.mocked(runCommand).mockImplementationOnce(async () => {
      throw new AssigneeError(
        "Plan generation failed: LLM crashed",
        "PLAN_FAILED",
      );
    });

    const { planCommand } = await import("./plan.js");
    await expect(
      planCommand.parseAsync([
        "node",
        "plan",
        "--output",
        "json",
        "Create an S3 bucket",
      ]),
    ).rejects.toThrow("Plan generation failed: LLM crashed");

    const joined = stdoutCaptured.join("").trim();
    expect(joined.length).toBeGreaterThan(0);
    const parsed = JSON.parse(joined);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("PLAN_FAILED");
    expect(parsed.error.message).toContain("Plan generation failed");
    expect(parsed.error.hint).toBeDefined();
  });

  it("runCommand throw discards any partial NDJSON buffer — only the error envelope reaches stdout", async () => {
    const { runCommand } = await import("../utils/command-runner.js");

    const partial = {
      resourceType: "AWS::S3::Bucket",
      region: "us-east-1",
      desiredState: { BucketName: "partial" },
      estimatedMonthlyCost: "$0.023/mo",
      pricingBreakdown: null,
      bpFindings: [],
      appliedFixes: [],
      freeTierNote: null,
      adviceHints: [],
    };

    const stdoutCaptured: string[] = [];
    stdoutWriteSpy.mockImplementation(((chunk: unknown) => {
      stdoutCaptured.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf8"),
      );
      return true;
    }) as never);

    vi.mocked(runCommand).mockImplementationOnce(async () => {
      // Simulate the formatter emitting a first resource payload
      // before the second resource errors.
      process.stdout.write(JSON.stringify(partial, null, 2) + "\n");
      throw new Error("second resource failed");
    });

    const { planCommand } = await import("./plan.js");
    await expect(
      planCommand.parseAsync([
        "node",
        "plan",
        "--output",
        "json",
        "Create an S3 and a Lambda",
      ]),
    ).rejects.toThrow("second resource failed");

    const joined = stdoutCaptured.join("").trim();
    // Exactly ONE JSON value — the error envelope — must reach stdout.
    const parsed = JSON.parse(joined);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toBe("second resource failed");
    // The partial S3 payload must NOT have leaked — no "partial" string
    // in the captured stdout.
    expect(joined).not.toContain('"BucketName": "partial"');
  });

  it("text mode does NOT swap stdout.write (regression — byte-identical passthrough)", async () => {
    // In text mode, installJsonStdoutInterceptor returns no-op handlers
    // and leaves process.stdout.write untouched. We confirm by asserting
    // the reference is unchanged across the command action boundary.
    const before = process.stdout.write;
    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync(["node", "plan", "Create an S3 bucket"]);
    expect(process.stdout.write).toBe(before);
  });
});
