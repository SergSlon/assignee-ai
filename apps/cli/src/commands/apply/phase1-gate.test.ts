/**
 * Unit tests for phase1-gate — the Phase 1 outcome handler that classifies
 * terminal graph state and either early-exits or signals Phase 2 continuation.
 *
 * Covers all five branch families exercised by the refactor (Story 53-it1-11):
 *   - CANCELLED
 *   - FAILED / UNSUPPORTED_RESOURCE / POLICY_BLOCKED with clarifier bypass
 *   - PENDING + preflightPassed=false (BP findings) — block & fix-and-continue
 *   - Catch-all unexpected status
 *   - Budget guard (blocked / warning / ok)
 *
 * Mocks I/O only (logger, display, clarifier, budget-guard) per testing
 * rules — graph.invoke is a vi.fn the test controls. All mock payloads
 * use realistic AgentState fields (resourceType, desiredState, cost
 * strings, appliedFixes, bpFindings with `blocking: boolean`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ExecutionMode,
  ExecutionStatus,
  BPEnforcementLevel,
} from "@assignee/core";
import type { BPFinding } from "@assignee/best-practices";
import type { AgentState } from "../../services/graph.js";
import type { Phase1Context, Phase1Deps } from "./phase1-planner.js";

vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    APPLY_COMPLETE: "apply_complete",
  },
}));

vi.mock("../../utils/display.js", () => ({
  renderError: vi.fn(),
  resolveSetKey: vi.fn((k: string) => k),
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
}));

vi.mock("../../services/clarifier.js", () => ({
  askClarifyingQuestion: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../services/budget-guard.js", () => ({
  checkBudget: vi.fn().mockReturnValue({ status: "ok" }),
}));

const { handlePhase1Outcome, buildContinueInvocation } =
  await import("./phase1-gate.js");
const { log } = await import("../../utils/logger.js");
const { renderError } = await import("../../utils/display.js");
const { askClarifyingQuestion } = await import("../../services/clarifier.js");
const { checkBudget } = await import("../../services/budget-guard.js");

// ── Helpers ────────────────────────────────────────────────────────────

function makeCtx(invokeResult?: Partial<AgentState>): Phase1Context {
  const graph = {
    invoke: vi.fn().mockResolvedValue({
      executionStatus: ExecutionStatus.IN_PROGRESS,
      preflightPassed: true,
      ...invokeResult,
    }),
    getState: vi.fn(),
  };
  return {
    intent: "Create an S3 bucket for analytics exports",
    runId: "run-abc-123",
    startTs: Date.now() - 1234,
    tools: [],
    graph,
  } as unknown as Phase1Context;
}

function makeDeps(overrides: Partial<Phase1Deps> = {}): Phase1Deps {
  return {
    intent: "Create an S3 bucket for analytics exports",
    opts: { yes: false, quick: false } as unknown as Phase1Deps["opts"],
    resolvedCheckpoint: null,
    resolvedSourceDir: undefined,
    sourceFileCount: undefined,
    userConfig: undefined,
    orgConfig: undefined,
    resolvedConfig: undefined,
    graphConfig: { configurable: { thread_id: "run-abc-123" } },
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create an S3 bucket for analytics exports",
    runId: "run-abc-123",
    executionStatus: ExecutionStatus.IN_PROGRESS,
    preflightPassed: true,
    resourceType: "AWS::S3::Bucket",
    desiredState: { BucketName: "analytics-exports-prod" },
    estimatedMonthlyCost: "$2.30/mo",
    bpEnforcementLevel: BPEnforcementLevel.ENFORCE,
    ...overrides,
  } as AgentState;
}

function makeBpFinding(overrides: Partial<BPFinding> = {}): BPFinding {
  return {
    practiceId: "BP-S3-001",
    title: "Block S3 Public Access",
    severity: "CRITICAL",
    category: "security",
    message: "S3 bucket allows public access",
    remediation: "Enable PublicAccessBlockConfiguration on the bucket",
    blocking: true,
    autoFixable: true,
    propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
    desiredStatePatch: {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  (checkBudget as ReturnType<typeof vi.fn>).mockReturnValue({ status: "ok" });
  (askClarifyingQuestion as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

// ── CANCELLED ──────────────────────────────────────────────────────────

describe("handlePhase1Outcome — CANCELLED", () => {
  it("returns success=true and logs apply_complete when user cancels at HITL", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({ executionStatus: ExecutionStatus.CANCELLED });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "done", result: { success: true } });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "apply_complete",
        level: "info",
        result: ExecutionStatus.CANCELLED,
      }),
    );
    expect(renderError).not.toHaveBeenCalled();
    expect(askClarifyingQuestion).not.toHaveBeenCalled();
  });
});

// ── FAILED / UNSUPPORTED / POLICY_BLOCKED ─────────────────────────────

describe("handlePhase1Outcome — failure class", () => {
  it("FAILED with no clarifier retry → renderError + success=false", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "LLM could not map intent",
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "done", result: { success: false } });
    expect(askClarifyingQuestion).toHaveBeenCalledTimes(1);
    expect(renderError).toHaveBeenCalledWith(
      "LLM could not map intent",
      expect.stringContaining("rephrasing"),
    );
  });

  it("UNSUPPORTED_RESOURCE uses the supported-types hint", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
      errorMessage: "Resource type not supported",
    });

    await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(renderError).toHaveBeenCalledWith(
      "Resource type not supported",
      expect.stringContaining("What you can create"),
    );
  });

  it("POLICY_BLOCKED skips the clarifier (policy is not an intent problem)", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.POLICY_BLOCKED,
      errorMessage: "SSE-S3 required by org policy",
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "done", result: { success: false } });
    expect(askClarifyingQuestion).not.toHaveBeenCalled();
    expect(renderError).toHaveBeenCalledWith(
      "SSE-S3 required by org policy",
      expect.any(String),
    );
  });

  it("clarifier bypassed when --yes is set (autoApprove=true)", async () => {
    const ctx = makeCtx();
    const deps = makeDeps({
      opts: { yes: true, quick: false } as unknown as Phase1Deps["opts"],
    });
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "intent ambiguity",
    });

    await handlePhase1Outcome(ctx, deps, state, "intent");

    // Clarifier IS called but must be told autoApprove=true so it bypasses.
    expect(askClarifyingQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ autoApprove: true, quick: false }),
    );
  });

  it("clarifier bypassed when --quick is set", async () => {
    const ctx = makeCtx();
    const deps = makeDeps({
      opts: { yes: false, quick: true } as unknown as Phase1Deps["opts"],
    });
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "intent ambiguity",
    });

    await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(askClarifyingQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ autoApprove: false, quick: true }),
    );
  });

  it("clarifier success → re-invokes graph with clarified intent and falls through on IN_PROGRESS", async () => {
    const rephrased = "Create an S3 bucket named analytics-exports-prod";
    (askClarifyingQuestion as ReturnType<typeof vi.fn>).mockResolvedValue(
      rephrased,
    );

    const reinvokedState = makeState({
      executionStatus: ExecutionStatus.IN_PROGRESS,
      preflightPassed: true,
    });
    const ctx = makeCtx();
    (ctx.graph.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      reinvokedState,
    );

    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "ambiguous intent",
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(ctx.graph.invoke).toHaveBeenCalledTimes(1);
    expect(ctx.intent).toBe(rephrased);
    expect(result.kind).toBe("continue");
  });

  it("clarifier success but still FAILED on re-check → renders error", async () => {
    (askClarifyingQuestion as ReturnType<typeof vi.fn>).mockResolvedValue(
      "clarified intent",
    );
    const ctx = makeCtx();
    (ctx.graph.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeState({
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: "still ambiguous",
      }),
    );

    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "ambiguous intent",
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "done", result: { success: false } });
    expect(renderError).toHaveBeenCalledWith(
      "still ambiguous",
      expect.any(String),
    );
  });
});

// ── BP-findings gate (PENDING + preflightPassed=false) ────────────────

describe("handlePhase1Outcome — BP findings gate", () => {
  it("blocking findings remain → bp_blocked, success=false, no re-invoke", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      preflightPassed: false,
      bpFindings: [makeBpFinding({ blocking: true })],
      appliedFixes: [],
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "done", result: { success: false } });
    expect(ctx.graph.invoke).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ result: "bp_blocked" }),
    );
  });

  it("no fixes applied → bp_blocked even when no blocking findings remain", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      preflightPassed: false,
      bpFindings: [],
      appliedFixes: [],
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "done", result: { success: false } });
    expect(ctx.graph.invoke).not.toHaveBeenCalled();
  });

  it("fixes applied + no blocking remaining → re-invokes graph (fix-and-continue)", async () => {
    const ctx = makeCtx();
    (ctx.graph.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeState({
        executionStatus: ExecutionStatus.IN_PROGRESS,
        preflightPassed: true,
      }),
    );
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      preflightPassed: false,
      bpFindings: [makeBpFinding({ blocking: false })],
      appliedFixes: [
        {
          findingId: "bp-s3-public-access",
          description: "Block public access",
        } as unknown as NonNullable<AgentState["appliedFixes"]>[number],
      ],
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(ctx.graph.invoke).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ result: "bp_fixed_continuing" }),
    );
    expect(result.kind).toBe("continue");
  });

  it("fix-and-continue then user cancels at HITL → success=true", async () => {
    const ctx = makeCtx();
    (ctx.graph.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeState({
        executionStatus: ExecutionStatus.CANCELLED,
      }),
    );
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      preflightPassed: false,
      bpFindings: [],
      appliedFixes: [
        {
          findingId: "bp-s3-public-access",
          description: "Block public access",
        } as unknown as NonNullable<AgentState["appliedFixes"]>[number],
      ],
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "done", result: { success: true } });
  });
});

// ── Catch-all unexpected status ───────────────────────────────────────

describe("handlePhase1Outcome — unexpected status", () => {
  it("status SUCCESS after Phase 1 is unexpected → renders catch-all error", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      errorMessage: undefined,
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "done", result: { success: false } });
    expect(renderError).toHaveBeenCalledWith(
      expect.stringContaining("unexpected state"),
      expect.stringContaining("full node trace"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        result: ExecutionStatus.SUCCESS,
      }),
    );
  });
});

// ── Budget guard ─────────────────────────────────────────────────────

describe("handlePhase1Outcome — budget guard", () => {
  it("blocked budget → renders error and success=false", async () => {
    (checkBudget as ReturnType<typeof vi.fn>).mockReturnValue({
      status: "blocked",
      message: "Estimated $150/mo exceeds panic limit of $100/mo",
    });
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      preflightPassed: true,
      estimatedMonthlyCost: "$150/mo",
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "done", result: { success: false } });
    expect(renderError).toHaveBeenCalledWith(
      "Estimated $150/mo exceeds panic limit of $100/mo",
    );
  });

  it("warning budget → writes yellow warning to stderr and continues", async () => {
    (checkBudget as ReturnType<typeof vi.fn>).mockReturnValue({
      status: "warning",
      message: "Nearing budget limit",
    });
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.IN_PROGRESS,
      preflightPassed: true,
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result.kind).toBe("continue");
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Nearing budget limit"),
    );
  });

  it("unparseable cost → writes warning and continues", async () => {
    (checkBudget as ReturnType<typeof vi.fn>).mockReturnValue({
      status: "unparseable",
      message: "Could not parse cost string",
    });
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      preflightPassed: true,
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result.kind).toBe("continue");
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it("ok budget → returns continue with phase1State", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const state = makeState({
      executionStatus: ExecutionStatus.IN_PROGRESS,
      preflightPassed: true,
    });

    const result = await handlePhase1Outcome(ctx, deps, state, "intent");

    expect(result).toEqual({ kind: "continue", phase1State: state });
    expect(renderError).not.toHaveBeenCalled();
  });
});

// ── buildContinueInvocation (Story 58-it1-02) ─────────────────────────

describe("buildContinueInvocation — arg shape for graph.invoke", () => {
  const effectiveIntent =
    "Create an S3 bucket for analytics exports with SSE-S3 encryption";

  it("all 6 conditional branches OFF → minimal arg shape, bpFindings forwarded, enforcement defaults to ENFORCE", () => {
    const ctx = makeCtx();
    const deps = makeDeps({
      opts: { yes: false, quick: false } as unknown as Phase1Deps["opts"],
      userConfig: undefined,
      orgConfig: undefined,
      resolvedSourceDir: undefined,
      sourceFileCount: undefined,
    });
    const phase1State = makeState({
      executionStatus: ExecutionStatus.PENDING,
      preflightPassed: false,
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "analytics-exports-prod" },
      estimatedMonthlyCost: "$2.30/mo",
      appliedFixes: [
        {
          findingId: "bp-s3-public-access",
          description: "Block public access",
        } as unknown as NonNullable<AgentState["appliedFixes"]>[number],
      ],
      elicitedOptions: { encryption: "SSE-S3" },
      resourceQueue: [
        {
          resourceType: "AWS::S3::Bucket",
          resourceId: "bucket",
          displayName: "S3 Bucket",
        },
      ],
      resourcePattern: undefined,
    });
    const residualFindings: AgentState["bpFindings"] = [];

    const arg = buildContinueInvocation(
      ctx,
      deps,
      phase1State,
      residualFindings,
      effectiveIntent,
    );

    // Required keys always present
    expect(arg).toMatchObject({
      checkpointResumed: true,
      userIntent: effectiveIntent,
      runId: ctx.runId,
      executionMode: ExecutionMode.APPLY,
      projectDir: process.cwd(),
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "analytics-exports-prod" },
      estimatedMonthlyCost: "$2.30/mo",
      preflightPassed: true,
      bpFindings: [],
      appliedFixes: phase1State.appliedFixes,
      elicitedOptions: { encryption: "SSE-S3" },
      resourceQueue: [
        {
          resourceType: "AWS::S3::Bucket",
          resourceId: "bucket",
          displayName: "S3 Bucket",
        },
      ],
      bpEnforcementLevel: BPEnforcementLevel.ENFORCE,
    });
    expect(typeof arg["startedAt"]).toBe("number");

    // All 4 conditional spreads OMITTED when their guards are falsy
    expect(arg).not.toHaveProperty("autoApprove");
    expect(arg).not.toHaveProperty("userConfig");
    expect(arg).not.toHaveProperty("orgConfig");
    expect(arg).not.toHaveProperty("sourceDir");
    expect(arg).not.toHaveProperty("sourceFileCount");
  });

  it("all 6 conditional branches ON → full arg shape, findings forwarded, user-configured enforcement wins", () => {
    const ctx = makeCtx();
    const userConfig = {
      bestPractices: { enforcement: BPEnforcementLevel.WARN },
    } as unknown as NonNullable<Phase1Deps["userConfig"]>;
    const orgConfig = { requireEncryption: true };
    const deps = makeDeps({
      opts: { yes: true, quick: false } as unknown as Phase1Deps["opts"],
      userConfig,
      orgConfig,
      resolvedSourceDir: "/project/infra",
      sourceFileCount: 17,
    });
    const phase1State = makeState({
      executionStatus: ExecutionStatus.PENDING,
      preflightPassed: false,
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "analytics-exports-prod" },
      appliedFixes: [
        {
          findingId: "bp-s3-public-access",
          description: "Block public access",
        } as unknown as NonNullable<AgentState["appliedFixes"]>[number],
      ],
    });
    const residualFindings: AgentState["bpFindings"] = [
      makeBpFinding({ blocking: false, severity: "HIGH" }),
    ];

    const arg = buildContinueInvocation(
      ctx,
      deps,
      phase1State,
      residualFindings,
      effectiveIntent,
    );

    // All 4 conditional-spread keys present
    expect(arg).toMatchObject({
      autoApprove: true,
      userConfig,
      orgConfig,
      sourceDir: "/project/infra",
      sourceFileCount: 17,
      // And user-level enforcement overrides the ENFORCE default
      bpEnforcementLevel: BPEnforcementLevel.WARN,
      // Findings passed through (non-empty branch)
      bpFindings: residualFindings,
    });
    expect((arg["bpFindings"] as unknown[]).length).toBe(1);
  });

  it("residualFindings=undefined → forwarded as undefined (not defaulted); effectiveIntent still propagates", () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const phase1State = makeState({
      executionStatus: ExecutionStatus.PENDING,
      preflightPassed: false,
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "analytics-exports-prod" },
      appliedFixes: [
        {
          findingId: "bp-s3-public-access",
          description: "Block public access",
        } as unknown as NonNullable<AgentState["appliedFixes"]>[number],
      ],
    });

    const arg = buildContinueInvocation(
      ctx,
      deps,
      phase1State,
      undefined,
      effectiveIntent,
    );

    expect(arg["bpFindings"]).toBeUndefined();
    expect(arg["userIntent"]).toBe(effectiveIntent);
    // checkpointResumed: true is always set — the whole point of this
    // builder is the fix-and-continue re-invocation.
    expect(arg["checkpointResumed"]).toBe(true);
  });
});
