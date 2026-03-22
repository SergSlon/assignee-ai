/**
 * Unit tests for command-runner.ts
 * Story 9.9 — T3: command-runner.ts tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";

// ── Module-level mocks ──────────────────────────────────────────────────────

vi.mock("../services/mcp-client.js", () => ({
  createMcpClient: vi.fn(),
  getMcpTools: vi.fn(),
  closeMcpClient: vi.fn().mockResolvedValue(undefined),
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
  isRecordingEnabled: vi.fn(() => false),
  RecordingInterceptor: vi.fn(),
  wrapToolWithRecorder: vi.fn((t: unknown) => t),
  RecordingLlmAdapter: vi.fn(),
}));

vi.mock("../services/litellm-adapter.js", () => ({
  LiteLLMAdapter: vi.fn().mockImplementation(() => ({
    generateText: vi.fn(),
    generateStructured: vi.fn(),
  })),
}));

const { createMcpClient, getMcpTools, closeMcpClient } =
  await import("../services/mcp-client.js");
const { createGraph } = await import("../services/graph.js");
const { renderIntro, renderOutro, renderError, stopSpinner } =
  await import("./display.js");
const { runCommand, runProvisioningLoop } = await import("./command-runner.js");

// ── Test setup ──────────────────────────────────────────────────────────────

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never) as any;
});

afterEach(() => {
  exitSpy.mockRestore();
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

  it("T3.3: MCP client fails to connect — renders error and exits with code 1", async () => {
    vi.mocked(createMcpClient).mockRejectedValue(
      new Error("Connection refused"),
    );

    await runCommand({
      intent: "Create an S3 bucket",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Plan failed",
      errorHint: "Check MCP servers",
      run: async () => ({ success: true }),
    });

    expect(renderError).toHaveBeenCalledWith(
      expect.stringContaining("Connection refused"),
      "Check MCP servers",
    );
    expect(renderOutro).toHaveBeenCalledWith(false);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("T3.4a: Success exit code — successful run exits 0", async () => {
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
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("T3.4b: Failure exit code — failed run exits 1", async () => {
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
    expect(process.exit).toHaveBeenCalledWith(1);
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

  it("run callback throws — stops spinner, renders error, exits 1", async () => {
    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Plan failed",
      errorHint: "Try again",
      run: async () => {
        throw new Error("Graph exploded");
      },
    });

    expect(stopSpinner).toHaveBeenCalled();
    expect(renderError).toHaveBeenCalledWith(
      "Plan failed: Graph exploded",
      "Try again",
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("non-Error throw is stringified in error message", async () => {
    const mockClient = {};
    vi.mocked(createMcpClient).mockResolvedValue(mockClient as never);
    vi.mocked(getMcpTools).mockResolvedValue([] as never);
    vi.mocked(createGraph).mockReturnValue({ invoke: vi.fn() } as never);

    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Plan failed",
      errorHint: "hint",
      run: async () => {
        throw "string error";
      },
    });

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

    // Should not throw
    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Err",
      errorHint: "hint",
      run: async () => ({ success: true }),
    });

    expect(process.exit).toHaveBeenCalledWith(0);
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

    await runCommand({
      intent: "test",
      startAction: "plan_started",
      endAction: "plan_complete",
      errorPrefix: "Err",
      errorHint: "hint",
      run: async () => {
        throw new Error("boom");
      },
    });

    expect(mockRecorder.finalizeSession).toHaveBeenCalled();

    // Reset
    vi.mocked(isRecordingEnabled).mockReturnValue(false);
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
        }),
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
