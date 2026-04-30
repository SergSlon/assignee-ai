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
  // Epic 92 u.e: resolvePlanArgs calls resolveSetKey for each --set
  // token; the CLI's display.ts re-exports it from core. In this mock
  // module we pass through (identity) because the fields-under-test do
  // not exercise the human-name → CFN-key mapping — they only care
  // that the --set token parsing + validation itself works.
  resolveSetKey: (k: string) => k,
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

/**
 * Commander v12 retains parsed option values on the shared singleton
 * `planCommand` between `parseAsync` calls. When one test passes
 * `--set size=t3.medium` and the next test omits `--set`, the second
 * test's `opts.set` still contains the leftover value. That was fine
 * until Epic 92 u.e added a `--set` token validator — now stale state
 * throws in the next test. Wipe `_optionValues` on each beforeEach.
 */
async function resetPlanCommandOptions(): Promise<void> {
  const { planCommand } = await import("./plan.js");
  const internals = planCommand as unknown as {
    _optionValues: Record<string, unknown>;
  };
  for (const opt of planCommand.options) {
    // Restore the option's declared default (e.g. `--set` defaults to
    // `[]` — wiping to `undefined` breaks the collector `[...prev, val]`).
    internals._optionValues[opt.attributeName()] = opt.defaultValue;
  }
}

beforeEach(async () => {
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
  await resetPlanCommandOptions();
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

// ── Epic 92 Wave 3.b.1 — flag alias registration (D-13) ───────────────────
describe("planCommand — flag aliases (Epic 92 D-13)", () => {
  it("registers --wizard as a boolean option (behaviour-equivalent to --quick, D-14 harmonised help text)", async () => {
    const { planCommand } = await import("./plan.js");
    const wizard = planCommand.options.find((o) => o.long === "--wizard");
    expect(wizard?.long).toBe("--wizard");
    // Epic 98 e98.W5.N5 (Epic 97 D-14): help text harmonised with
    // apply.ts's `--wizard` description — both surfaces now describe
    // the same concept ("interactive configuration wizard"), closing
    // the drift where plan said "Alias for --quick" while apply
    // described it as a distinct interactive mode. Internally plan
    // still aliases --wizard → --quick (plan is read-only so there
    // is no "full wizard" mode beyond required-field prompts), but
    // the help surface is now consistent across plan/apply.
    expect(wizard?.description).toMatch(/interactive configuration wizard/i);
    // It MUST be a boolean flag (no argument), so the help renders as
    // `--wizard` not `--wizard <value>`.
    expect(wizard?.flags).toBe("--wizard");
  });

  it("registers --quick with -q shorthand (canonical wizard flag)", async () => {
    const { planCommand } = await import("./plan.js");
    const quick = planCommand.options.find((o) => o.long === "--quick");
    expect(quick?.long).toBe("--quick");
    expect(quick?.short).toBe("-q");
  });

  it("registers --json as a boolean shorthand for --output json", async () => {
    const { planCommand } = await import("./plan.js");
    const json = planCommand.options.find((o) => o.long === "--json");
    expect(json?.long).toBe("--json");
    expect(json?.description).toMatch(/--output json/);
    // Boolean, not --json <value>.
    expect(json?.flags).toBe("--json");
  });

  it("keeps -o, --output <format> option registered alongside --json shorthand", async () => {
    const { planCommand } = await import("./plan.js");
    const output = planCommand.options.find((o) => o.long === "--output");
    expect(output?.long).toBe("--output");
    expect(output?.short).toBe("-o");
  });
});

// ── Epic 92 Wave 3.b.1 — help text consolidation (C-24 / D-01) ────────────
// Commander 12's `helpInformation()` intentionally does NOT concat the
// `addHelpText()` payloads — those emit through `beforeHelp`/`afterHelp`
// event hooks during `outputHelp()`. We re-run outputHelp with a
// capture write to get the fully-rendered help.
function captureFullPlanHelp(cmd: Command): string {
  let captured = "";
  cmd.outputHelp({
    write: (chunk: string) => {
      captured += chunk;
    },
  } as unknown as { error: boolean });
  return captured;
}

describe("planCommand — help text (Epic 92 C-24 / D-01)", () => {
  // The parent `program` in index.ts also registers an
  // `addHelpText("after", ...)` block. These tests assert the
  // PER-COMMAND block (owned by plan.ts) is correctly shaped and
  // that the per-command `addHelpText` itself is ONE consolidated
  // call (not scattered), which is what C-24 / D-01 require.
  it("plan command registers exactly one addHelpText(after) entry on itself", async () => {
    const { planCommand } = await import("./plan.js");
    // Commander keeps per-command addHelpText listeners on the
    // command's EventEmitter under 'afterHelp' (the event the
    // "after" position emits). We count the listeners directly.
    const listeners = (
      planCommand as unknown as {
        listeners: (evt: string) => unknown[];
      }
    ).listeners("afterHelp");
    // Exactly one — the consolidated block installed in plan.ts.
    expect(listeners.length).toBe(1);
  });

  it("plan --help per-command block lists plan-specific invocations", async () => {
    const { planCommand } = await import("./plan.js");
    const helpText = captureFullPlanHelp(planCommand);
    // Plan-specific invocations must appear.
    expect(helpText).toContain('assignee plan "');
    // The per-command block includes the alias examples that do
    // NOT appear in the global block — presence of these two strings
    // confirms the per-command block rendered.
    expect(helpText).toContain("--wizard");
    expect(helpText).toContain("--json");
  });

  it("plan --help Examples block shows --wizard and --json alias examples", async () => {
    const { planCommand } = await import("./plan.js");
    const helpText = captureFullPlanHelp(planCommand);
    expect(helpText).toContain("assignee plan --wizard");
    expect(helpText).toContain("assignee plan --json");
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

// ── Epic 92 Wave 3.b.1 — alias normalization in action (D-13) ────────────
// The action rewrites `opts.wizard=true` → `opts.quick=true` and
// `opts.json=true` → `opts.output="json"` before handing off to
// `resolvePlanArgs` + `runPlan`. These tests invoke the real
// planCommand through parseAsync and verify the run callback sees
// the normalized values.

describe("planCommand — --wizard alias normalization (Epic 92 D-13)", () => {
  it("--wizard flag on plan triggers the quick/wizard run path", async () => {
    capturedOpts = null;
    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync([
      "node",
      "plan",
      "--wizard",
      "Create an S3 bucket",
    ]);
    expect(capturedOpts).not.toBeNull();

    // Exercise the captured run callback; runPlan inspects
    // `opts.quick` on its way into the graph. We assert the callback
    // completes without throwing and that the graph state reflects
    // the quick mode flag.
    const ctx = makeCtx();
    await capturedOpts!.run(ctx);
    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        quickMode: true,
      }),
      expect.anything(),
    );
  });

  it("--quick alone (no --wizard) still sets quickMode on graph state", async () => {
    capturedOpts = null;
    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync([
      "node",
      "plan",
      "--quick",
      "Create an S3 bucket",
    ]);
    expect(capturedOpts).not.toBeNull();
    const ctx = makeCtx();
    await capturedOpts!.run(ctx);
    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        quickMode: true,
      }),
      expect.anything(),
    );
  });
});

describe("planCommand — --json shorthand normalization (Epic 92 D-13)", () => {
  it("--json (boolean) behaves the same as --output json", async () => {
    capturedOpts = null;
    // Capture stdout so the JSON-mode interceptor has something to
    // restore against; we don't assert on the envelope content here.
    stdoutWriteSpy.mockImplementation((() => true) as never);

    const { runCommand } = await import("../utils/command-runner.js");
    vi.mocked(runCommand).mockImplementationOnce(
      async (opts: Parameters<typeof runCommand>[0]) => {
        capturedOpts = opts;
      },
    );

    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync([
      "node",
      "plan",
      "--json",
      "Create an S3 bucket",
    ]);
    expect(capturedOpts).not.toBeNull();
    // The shorthand normalizes to the same JSON-mode path, which
    // suppresses the AWS-context stderr preamble. We detect that by
    // asserting `silent: true` was passed to runCommand (the flag the
    // JSON-mode branch sets in the plan action).
    expect(capturedOpts!.silent).toBe(true);
  });

  it("--output json (explicit) keeps setting silent run", async () => {
    capturedOpts = null;
    stdoutWriteSpy.mockImplementation((() => true) as never);

    const { runCommand } = await import("../utils/command-runner.js");
    vi.mocked(runCommand).mockImplementationOnce(
      async (opts: Parameters<typeof runCommand>[0]) => {
        capturedOpts = opts;
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
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.silent).toBe(true);
  });
});

// ── P1-6: --no-apply skips renderApplyNowConfirm ──────────────────────────
// MUST be last describe block — Commander is a singleton and parseAsync with
// --no-apply mutates the shared command instance's opts.

// ── Epic 92 u.e — --set parsing (C-11 / C-17) ─────────────────────────────
// C-11: `plan --set size=t3.medium "Create an EC2"` used to drop the
//       positional intent because the variadic `--set <key=value...>`
//       swallowed the intent string. Now each `--set` takes one value;
//       the flag can still be supplied multiple times.
// C-17: a malformed `--set badsyntax` (no `=`) used to be silently
//       dropped; now it throws with an actionable USAGE_ERROR.
//
// These tests exercise the Commander surface AND the `resolvePlanArgs`
// validator — they share the same code path the real CLI runs.
describe("planCommand — --set flag parsing (Epic 92 C-11 / C-17)", () => {
  beforeEach(() => {
    capturedOpts = null;
  });

  it("C-11: --set key=value before the intent does NOT swallow the intent", async () => {
    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync([
      "node",
      "plan",
      "--set",
      "size=t3.medium",
      "Create an EC2 instance",
    ]);

    // The intent was preserved (otherwise runCommand.run would throw
    // "Missing intent" before capturedOpts could be set).
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.intent).toBe("Create an EC2 instance");
  });

  it("C-11: multiple --set flags are collected (non-variadic, repeatable)", async () => {
    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync([
      "node",
      "plan",
      "--set",
      "size=t3.medium",
      "--set",
      "region=us-east-1",
      "Create an EC2 instance",
    ]);
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.intent).toBe("Create an EC2 instance");
  });

  it("C-17: --set without = fails with a USAGE_ERROR", async () => {
    const { planCommand } = await import("./plan.js");
    await expect(
      planCommand.parseAsync([
        "node",
        "plan",
        "--set",
        "badsyntax",
        "Create an EC2 instance",
      ]),
    ).rejects.toThrow(/Invalid --set token "badsyntax"/);
  });

  it("C-17: --set with empty key (starts with =) fails", async () => {
    const { planCommand } = await import("./plan.js");
    await expect(
      planCommand.parseAsync([
        "node",
        "plan",
        "--set",
        "=oops",
        "Create an EC2 instance",
      ]),
    ).rejects.toThrow(/Invalid --set token/);
  });

  it("C-17: --set key= (empty value) is allowed (explicit clear)", async () => {
    const { planCommand } = await import("./plan.js");
    // Empty value is legitimate — `--set Tags=` means "clear the Tags
    // field". Regex allows `.*` after the `=`.
    await planCommand.parseAsync([
      "node",
      "plan",
      "--set",
      "Tags=",
      "Create an EC2 instance",
    ]);
    expect(capturedOpts).not.toBeNull();
  });
});

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

  // ── Epic 94 R5 (C-03) — error-envelope discipline ───────────────────
  // On AssigneeError with a specific code (UNSUPPORTED_RESOURCE,
  // INVALID_DESIRED_STATE, …) the envelope must preserve that code
  // verbatim, not collapse to a generic "PLAN_FAILED". On a plain
  // Error the envelope must use code "UNKNOWN_ERROR" + the `--verbose`
  // hint so machine readers can filter unmodelled crashes from typed
  // failures.
  it("AssigneeError(UNSUPPORTED_RESOURCE) preserves its code + message on stdout", async () => {
    const { runCommand } = await import("../utils/command-runner.js");
    const { AssigneeError } = await import("@assignee/core");

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
      throw new AssigneeError(
        'Resource type "AWS::RDS::DBInstance" is not supported in the current phase.',
        "UNSUPPORTED_RESOURCE",
      );
    });

    const { planCommand } = await import("./plan.js");
    await expect(
      planCommand.parseAsync([
        "node",
        "plan",
        "--output",
        "json",
        "Create an unsupported resource",
      ]),
    ).rejects.toThrow("is not supported");

    const parsed = JSON.parse(stdoutCaptured.join("").trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("UNSUPPORTED_RESOURCE");
    expect(parsed.error.message).toContain("not supported");
    expect(parsed.error.hint).toBeDefined();
  });

  it("plain Error (non-AssigneeError) emits UNKNOWN_ERROR + --verbose hint", async () => {
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

    vi.mocked(runCommand).mockImplementationOnce(async () => {
      throw new Error("unexpected pipeline crash");
    });

    const { planCommand } = await import("./plan.js");
    await expect(
      planCommand.parseAsync([
        "node",
        "plan",
        "--output",
        "json",
        "Create something",
      ]),
    ).rejects.toThrow("unexpected pipeline crash");

    const parsed = JSON.parse(stdoutCaptured.join("").trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("UNKNOWN_ERROR");
    expect(parsed.error.message).toBe("unexpected pipeline crash");
    expect(parsed.error.hint).toBe("Run with --verbose for full stack trace.");
  });

  it("stdout is a single parseable JSON value on error (no NDJSON / no plaintext leak)", async () => {
    const { runCommand } = await import("../utils/command-runner.js");
    const { AssigneeError } = await import("@assignee/core");

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
      throw new AssigneeError("Plan generation failed", "PLAN_FAILED");
    });

    const { planCommand } = await import("./plan.js");
    await expect(
      planCommand.parseAsync([
        "node",
        "plan",
        "--output",
        "json",
        "Create something",
      ]),
    ).rejects.toThrow("Plan generation failed");

    const joined = stdoutCaptured.join("").trim();
    // Single parse must succeed: no NDJSON, no prefix/suffix text.
    const parsed = JSON.parse(joined);
    expect(parsed.ok).toBe(false);
    // No "}\n{" boundary anywhere — that would mean two root values.
    expect(joined.includes("}\n{")).toBe(false);
    // No [ERROR] / [CONTEXT] / [FIX] plaintext blocks leaked onto stdout
    // (they belong on stderr via renderError).
    expect(joined).not.toContain("[ERROR]");
    expect(joined).not.toContain("[CONTEXT]");
    expect(joined).not.toContain("[FIX]");
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

// ── W5-S0 — --target-account help description clean of internal trackers ─────
// Verifies that the --target-account option description rendered by --help
// (stdout) contains no internal tracker strings such as "Epic 101".

describe("planCommand — --target-account help description (W5-S0)", () => {
  it("--help stdout for --target-account does not contain Epic/story tracker strings", async () => {
    const { planCommand } = await import("./plan.js");
    const helpText = captureFullPlanHelp(planCommand);
    // The option must be present in the help output.
    expect(helpText).toContain("--target-account");
    // Must NOT expose internal tracker names in user-facing output.
    expect(helpText).not.toMatch(/Epic\s+\d+/i);
    expect(helpText).not.toMatch(/story\s+\d+-W\d+/i);
  });
});

// ── W4-S5 — --target-account user-facing message (M-β-01) ───────────────────
// Verifies that --target-account exits NOT_IMPLEMENTED without leaking
// internal tracker strings ("Epic 101", "story", "W3-04") in stderr.

describe("planCommand — --target-account NOT_IMPLEMENTED message (W4-S5)", () => {
  it("exits NOT_IMPLEMENTED (12) for a valid 12-digit account ID", async () => {
    const stderrCalls: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown): boolean => {
        stderrCalls.push(String(chunk));
        return true;
      },
    );
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    const { planCommand } = await import("./plan.js");
    await planCommand.parseAsync([
      "node",
      "plan",
      "--target-account",
      "112233445566",
      "Create an S3 bucket",
    ]);

    const stderrText = stderrCalls.join("");
    // Must contain user-facing intent keywords.
    expect(stderrText).toContain("cross-account");
    expect(stderrText).toContain("not yet available");
    // Must NOT leak internal tracker names.
    expect(stderrText).not.toMatch(/Epic\s+\d+/i);
    expect(stderrText).not.toMatch(/story\s+\d+-W\d+/i);
    // Exit code must be NOT_IMPLEMENTED (12).
    expect(process.exit).toHaveBeenCalledWith(12);
  });
});
