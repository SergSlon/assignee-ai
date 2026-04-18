/**
 * Unit tests for command-runner.ts
 * Story 9.9 — T3: command-runner.ts tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { ExecutionStatus } from "@assignee/core";

// ── Module-level mocks ──────────────────────────────────────────────────────

// NOTE: Default impls for these mocks are re-installed in beforeEach because
// mockReset:true wipes vi.fn implementations between tests.
vi.mock("../services/mcp-client.js", () => ({
  createMcpClient: vi.fn(),
  getMcpTools: vi.fn(),
  closeMcpClient: vi.fn(),
}));

vi.mock("../services/graph.js", () => ({
  createGraph: vi.fn(),
}));

vi.mock("./display.js", () => ({
  renderIntro: vi.fn(),
  renderOutro: vi.fn(),
  renderError: vi.fn(),
  startSpinner: vi.fn(),
  updateSpinner: vi.fn(),
  stopSpinner: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    PLAN_STARTED: "plan_started",
    PLAN_COMPLETE: "plan_complete",
    APPLY_STARTED: "apply_started",
    APPLY_COMPLETE: "apply_complete",
  },
}));

vi.mock("./recorder.js", () => ({
  isRecordingEnabled: vi.fn(),
  RecordingInterceptor: vi.fn(),
  wrapToolWithRecorder: vi.fn(),
  RecordingLlmAdapter: vi.fn(),
}));

vi.mock("@assignee/core/llm", () => ({
  LlmAdapter: vi.fn(),
}));

vi.mock("../config/user-config-loader.js", () => ({
  loadUserConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/cleanup.js", () => ({
  runAutoCleanup: vi.fn(),
}));

vi.mock("../services/memory.js", () => ({
  defaultMemoryService: {},
}));

const { createMcpClient, getMcpTools, closeMcpClient } =
  await import("../services/mcp-client.js");
const { createGraph } = await import("../services/graph.js");
const { renderIntro, renderOutro, renderError, stopSpinner } =
  await import("./display.js");
const { runCommand, runProvisioningLoop } = await import("./command-runner.js");
const { runAutoCleanup } = await import("../services/cleanup.js");
const {
  isRecordingEnabled,
  wrapToolWithRecorder,
  RecordingInterceptor: _RI,
} = await import("./recorder.js");
const { LlmAdapter } = await import("@assignee/core/llm");

// ── Test setup ──────────────────────────────────────────────────────────────

let exitSpy: MockInstance;

let origOperatorKey: string | undefined;
let origOperatorSecret: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-install default impls (mockReset wipes them between tests).
  vi.mocked(closeMcpClient).mockResolvedValue(undefined);
  vi.mocked(runAutoCleanup).mockResolvedValue(undefined);
  vi.mocked(isRecordingEnabled).mockReturnValue(false);
  vi.mocked(wrapToolWithRecorder).mockImplementation((t) => t as never);
  vi.mocked(LlmAdapter).mockImplementation(
    () =>
      ({
        generateText: vi.fn(),
        generateStructured: vi.fn(),
      }) as unknown as InstanceType<typeof LlmAdapter>,
  );
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  origOperatorKey = process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
  origOperatorSecret = process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "test-key";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "test-secret";
});

afterEach(() => {
  exitSpy.mockRestore();
  if (origOperatorKey === undefined) {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
  } else {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = origOperatorKey;
  }
  if (origOperatorSecret === undefined) {
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
  } else {
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = origOperatorSecret;
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runCommand", () => {
  it("T3.1: MCP client lifecycle — creates client, gets tools, closes on teardown", async () => {
    const mockClient = { getTools: vi.fn() };
    const mockTools = [{ name: "tool1" }];
    const mockGraph = { invoke: vi.fn(), getState: vi.fn() };

    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue(mockTools as never);
    vi.mocked(createGraph).mockReturnValue(mockGraph as never);

    await runCommand({
      intent: "Create an S3 bucket",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Plan failed",
      errorHint: "Check credentials",
      run: async () => ({ success: true }),
    });

    expect(createMcpClient).toHaveBeenCalledOnce();
    expect(getMcpTools).toHaveBeenCalledWith(mockClient);
    expect(closeMcpClient).toHaveBeenCalled();
  });

  it("T3.2: Graph creation — creates graph with tools from MCP", async () => {
    const mockClient = {};
    const mockTools = [{ name: "schema" }, { name: "pricing" }];
    const mockGraph = { invoke: vi.fn(), getState: vi.fn() };

    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue(mockTools as never);
    vi.mocked(createGraph).mockReturnValue(mockGraph as never);

    await runCommand({
      intent: "Create an S3 bucket",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Plan failed",
      errorHint: "Check credentials",
      run: async (ctx) => {
        expect(ctx.tools).toBe(mockTools);
        expect(ctx.graph).toBe(mockGraph);
        return { success: true };
      },
    });

    expect(createGraph).toHaveBeenCalledWith(mockTools, expect.anything());
  });

  it("T3.3: MCP client fails to connect — renders error and throws", async () => {
    vi.mocked(createMcpClient).mockRejectedValue(
      new Error("Connection refused"),
    );

    await expect(
      runCommand({
        intent: "Create an S3 bucket",
        startAction: "plan_started",
        endAction: "plan_complete",
        errorPrefix: "Plan failed",
        errorHint: "Check MCP servers",
        run: async () => ({ success: true }),
      }),
    ).rejects.toThrow();

    expect(renderError).toHaveBeenCalledWith(
      expect.stringContaining("Connection refused"),
      "Check MCP servers",
    );
    expect(renderOutro).toHaveBeenCalledWith(false);
  });

  it("T3.4a: Success exit code — successful run completes without throwing", async () => {
    const mockClient = {};
    const mockTools: never[] = [];
    const mockGraph = { invoke: vi.fn(), getState: vi.fn() };

    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue(mockTools as never);
    vi.mocked(createGraph).mockReturnValue(mockGraph as never);

    await runCommand({
      intent: "Create an S3 bucket",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Plan failed",
      errorHint: "Check credentials",
      run: async () => ({ success: true }),
    });

    expect(renderOutro).toHaveBeenCalledWith(true);
  });

  it("T3.4b: Failure exit code — renders outro(false) without throwing", async () => {
    const mockClient = {};
    const mockTools: never[] = [];
    const mockGraph = { invoke: vi.fn(), getState: vi.fn() };

    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue(mockTools as never);
    vi.mocked(createGraph).mockReturnValue(mockGraph as never);

    await runCommand({
      intent: "Create an S3 bucket",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Plan failed",
      errorHint: "Check credentials",
      run: async () => ({ success: false }),
    });

    expect(renderOutro).toHaveBeenCalledWith(false);
  });

  it("renders intro on start", async () => {
    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Err",
      errorHint: "hint",
      run: async () => ({ success: true }),
    });

    expect(renderIntro).toHaveBeenCalledOnce();
  });

  it("run callback throws — stops spinner, renders error, throws", async () => {
    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await expect(
      runCommand({
        intent: "test",
        startAction: "plan_started",
        endAction: "plan_complete",
        errorPrefix: "Plan failed",
        errorHint: "Try again",
        run: async () => {
          throw new Error("Graph exploded");
        },
      }),
    ).rejects.toThrow();

    expect(stopSpinner).toHaveBeenCalled();
    expect(renderError).toHaveBeenCalledWith(
      "Plan failed: Graph exploded",
      "Try again",
    );
  });

  it("non-Error throw is stringified in error message", async () => {
    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await expect(
      runCommand({
        intent: "test",
        startAction: "plan_started",
        endAction: "plan_complete",
        errorPrefix: "Plan failed",
        errorHint: "hint",
        run: async () => {
          throw "string error";
        },
      }),
    ).rejects.toThrow();

    expect(renderError).toHaveBeenCalledWith(
      "Plan failed: string error",
      "hint",
    );
  });

  it("closeMcpClient error is swallowed silently", async () => {
    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);
    vi.mocked(closeMcpClient).mockRejectedValue(new Error("close failed"));

    // Should not throw — closeMcpClient error is swallowed
    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Err",
      errorHint: "hint",
      run: async () => ({ success: true }),
    });
  });

  it("recorder enabled — wraps tools and finalizes on success", async () => {
    const { isRecordingEnabled, RecordingInterceptor, wrapToolWithRecorder } =
      await import("./recorder.js");
    vi.mocked(isRecordingEnabled).mockReturnValue(true);
    const mockRecorder = { finalizeSession: vi.fn() };
    vi.mocked(RecordingInterceptor).mockImplementation(
      () => mockRecorder as never,
    );
    vi.mocked(wrapToolWithRecorder).mockImplementation((t) => t as never);

    const mockClient = {};
    const mockTools = [{ name: "tool1" }];
    const mockGraph = { invoke: vi.fn(), getState: vi.fn() };

    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue(mockTools as never);
    vi.mocked(createGraph).mockReturnValue(mockGraph as never);

    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Err",
      errorHint: "hint",
      run: async () => ({ success: true }),
    });

    expect(isRecordingEnabled).toHaveBeenCalled();
    expect(wrapToolWithRecorder).toHaveBeenCalled();
    expect(mockRecorder.finalizeSession).toHaveBeenCalled();

    // Reset
    vi.mocked(isRecordingEnabled).mockReturnValue(false);
  });

  it("recorder enabled + error — still finalizes session", async () => {
    const { isRecordingEnabled, RecordingInterceptor } =
      await import("./recorder.js");
    vi.mocked(isRecordingEnabled).mockReturnValue(true);
    const mockRecorder = { finalizeSession: vi.fn() };
    vi.mocked(RecordingInterceptor).mockImplementation(
      () => mockRecorder as never,
    );

    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await expect(
      runCommand({
        intent: "test",
        startAction: "plan_started",
        endAction: "plan_complete",
        errorPrefix: "Err",
        errorHint: "hint",
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow();

    expect(mockRecorder.finalizeSession).toHaveBeenCalled();

    // Reset
    vi.mocked(isRecordingEnabled).mockReturnValue(false);
  });
});

// ── Story 33.4: Auto-cleanup hook ──────────────────────────────────────────

describe("runCommand — auto-cleanup hook", () => {
  it("calls runAutoCleanup after successful command", async () => {
    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Err",
      errorHint: "hint",
      run: async () => ({ success: true }),
    });

    expect(runAutoCleanup).toHaveBeenCalled();
  });

  it("calls runAutoCleanup after failed command", async () => {
    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await expect(
      runCommand({
        intent: "test",
        startAction: "plan_started",
        endAction: "plan_complete",
        errorPrefix: "Err",
        errorHint: "hint",
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow();

    expect(runAutoCleanup).toHaveBeenCalled();
  });

  it("runAutoCleanup error does not affect command exit", async () => {
    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);
    vi.mocked(runAutoCleanup).mockRejectedValueOnce(
      new Error("cleanup failed"),
    );

    // Should not throw — cleanup error is swallowed
    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Err",
      errorHint: "hint",
      run: async () => ({ success: true }),
    });

    expect(runAutoCleanup).toHaveBeenCalled();
  });
});

describe("runProvisioningLoop", () => {
  it("single resource — one iteration, returns success", async () => {
    const mockGraph = {
      invoke: vi.fn().mockResolvedValue(undefined),
      getState: vi
        .fn()
        .mockResolvedValueOnce({ next: [] }) // after invoke: no more interrupts
        .mockResolvedValueOnce({
          values: { executionStatus: ExecutionStatus.SUCCESS },
        }), // finalState query
    };
    const config = { configurable: { thread_id: "test-run" } };
    const phase1State = { executionStatus: ExecutionStatus.PENDING } as never;

    const result = await runProvisioningLoop(
      mockGraph as never,
      config,
      phase1State,
    );

    expect(result.success).toBe(true);
    expect(result.finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(mockGraph.invoke).toHaveBeenCalledTimes(1);
  });

  it("compound resource — loops through multiple resources", async () => {
    const mockGraph = {
      invoke: vi.fn().mockResolvedValue(undefined),
      getState: vi
        .fn()
        .mockResolvedValueOnce({ next: ["resource_provisioner"] }) // first resource done, more to go
        .mockResolvedValueOnce({ next: [] }) // second resource done, no more
        .mockResolvedValueOnce({
          values: {
            executionStatus: ExecutionStatus.SUCCESS,
            completedResources: [{ resourceId: "r1" }, { resourceId: "r2" }],
          },
        }),
    };
    const config = { configurable: { thread_id: "test-run" } };
    const phase1State = {
      resourcePattern: { patternId: "test" },
      resourceQueue: [
        { displayName: "Resource 1" },
        { displayName: "Resource 2" },
      ],
    } as never;

    const result = await runProvisioningLoop(
      mockGraph as never,
      config,
      phase1State,
    );

    expect(result.success).toBe(true);
    expect(mockGraph.invoke).toHaveBeenCalledTimes(2);
  });

  it("compound — success when completedResources matches total", async () => {
    const mockGraph = {
      invoke: vi.fn().mockResolvedValue(undefined),
      getState: vi
        .fn()
        .mockResolvedValueOnce({ next: [] })
        .mockResolvedValueOnce({
          values: {
            executionStatus: ExecutionStatus.PENDING, // not SUCCESS per se
            completedResources: [{ resourceId: "r1" }],
          },
        }),
    };
    const config = { configurable: { thread_id: "test-run" } };
    const phase1State = {
      resourcePattern: { patternId: "test" },
      resourceQueue: [{ displayName: "Resource 1" }],
    } as never;

    const result = await runProvisioningLoop(
      mockGraph as never,
      config,
      phase1State,
    );

    // Compound success: completedResources.length === totalResources
    expect(result.success).toBe(true);
  });

  it("failure — executionStatus is FAILED", async () => {
    const mockGraph = {
      invoke: vi.fn().mockResolvedValue(undefined),
      getState: vi
        .fn()
        .mockResolvedValueOnce({ next: [] })
        .mockResolvedValueOnce({
          values: { executionStatus: ExecutionStatus.FAILED },
        }),
    };
    const config = { configurable: { thread_id: "test-run" } };
    const phase1State = { executionStatus: ExecutionStatus.PENDING } as never;

    const result = await runProvisioningLoop(
      mockGraph as never,
      config,
      phase1State,
    );

    expect(result.success).toBe(false);
  });
});

// ── Story 29.5 / NFR-05: cold-start timing wiring ──────────────────────────
//
// Purpose: lock in the contract that runCommand records the cold-start
// budgets defined in `constants/time-budget.ts`. The timing infrastructure
// (telemetry/timing.ts) was added in Story 29.1 but was not wired into any
// command until this change. These tests catch the regression where someone
// removes the startTimer/endTimer/persistTimings calls from runCommand and
// the warning loses its source signal.

describe("runCommand — Story 29.5 / NFR-05 cold-start timings", () => {
  it("records the total + credential-check + mcp-startup phases on a successful run", async () => {
    const { resetTimings, getTimings } = await import("../telemetry/timing.js");
    resetTimings();

    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await runCommand({
      intent: "Create an S3 bucket",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Plan failed",
      errorHint: "hint",
      run: async () => ({ success: true }),
    });

    const timings = getTimings();
    // The three phases runCommand owns directly. first-llm-call + total are
    // checked separately so a future first-llm-call wiring doesn't have to
    // touch this assertion.
    expect(timings).toMatchObject({
      total: expect.any(Number),
      "credential-check": expect.any(Number),
      "mcp-startup": expect.any(Number),
    });
    // Sanity: total >= sum of (credential-check + mcp-startup) within ~5ms
    // slack for the small uninstrumented gap between phases.
    const total = timings["total"]!;
    const cred = timings["credential-check"]!;
    const mcp = timings["mcp-startup"]!;
    expect(total).toBeGreaterThanOrEqual(Math.max(0, cred + mcp - 5));
  });

  it("still records the total timer when the credential check throws ConfigurationError", async () => {
    const { resetTimings, getTimings } = await import("../telemetry/timing.js");
    resetTimings();

    // Strip operator credentials so the early credential gate fires.
    const savedKey = process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    const savedSecret = process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
    delete process.env["AWS_ACCESS_KEY_ID"];
    delete process.env["AWS_SECRET_ACCESS_KEY"];
    delete process.env["AWS_PROFILE"];

    try {
      await expect(
        runCommand({
          intent: "test",
          startAction: "plan_started",
          endAction: "plan_complete",
          errorPrefix: "Plan failed",
          errorHint: "hint",
          run: async () => ({ success: true }),
        }),
      ).rejects.toThrow(/No AWS credentials/);

      // The finally block should have closed the total timer even though we
      // bailed out before reaching the inner try. credential-check is also
      // closed (the throw path explicitly calls endTimer).
      const timings = getTimings();
      expect(timings).toHaveProperty("total");
      expect(timings).toHaveProperty("credential-check");
      // mcp-startup never started — that phase was unreachable.
      expect(timings).not.toHaveProperty("mcp-startup");
    } finally {
      if (savedKey !== undefined)
        process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = savedKey;
      if (savedSecret !== undefined)
        process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = savedSecret;
    }
  });

  it("persists timings via persistTimings on every run (success path)", async () => {
    // Spy on persistTimings by re-importing the module after a mock is in
    // place. We use vi.spyOn rather than vi.mock so the rest of the timing
    // module (startTimer/endTimer state) keeps working — we only care that
    // the persist call happens.
    const timingModule = await import("../telemetry/timing.js");
    const persistSpy = vi
      .spyOn(timingModule, "persistTimings")
      .mockImplementation(() => {});

    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Err",
      errorHint: "hint",
      run: async () => ({ success: true }),
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
    // The runId argument is the canonical UUID generated by runCommand.
    // Assert it's a non-empty string rather than the literal value, since
    // crypto.randomUUID() is non-deterministic.
    const callArg = persistSpy.mock.calls[0]![0];
    expect(typeof callArg).toBe("string");
    expect(callArg.length).toBeGreaterThan(0);

    persistSpy.mockRestore();
  });
});
