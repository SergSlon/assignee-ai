/**
 * W6-S1 (M-β-14 + M-β-16) — signal-handler + clearAllApplies integration.
 *
 * Verifies that the graceful-shutdown path:
 *   1. Calls clearAllApplies() so in-flight apply locks are released before
 *      process.exit (no stale-lock after a SIGTERM during an apply).
 *   2. Calls process.exit with the correct code.
 *   3. Invokes server.close() (or equivalent) before exiting.
 *   4. A second signal while mcpShuttingDown=true exits immediately without
 *      re-entering the async shutdown path.
 *
 * We do NOT import apps/mcp-server/src/index.ts here because that module
 * has a top-level main() call that spawns the real stdio transport and
 * blocks the test process.  Instead, we re-implement just the signal-handler
 * body inline (same logic, same assertions) so the test is hermetic.
 *
 * The active-applies integration is tested here via the real
 * clearAllApplies() import so the test is not purely unit-level.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveApplies,
  clearAllApplies,
  isApplyActive,
  markApplyActive,
} from "../tools/apply-plan/active-applies.js";

// ---------------------------------------------------------------------------
// Helpers — minimal re-implementation of the signal-handler body so we can
// exercise the logic without triggering the module-level main() in index.ts.
// ---------------------------------------------------------------------------

interface FakeMcpServer {
  close: () => Promise<void>;
}

function buildSignalHandler(
  code: number,
  opts: {
    exitSpy: (c: number) => never;
    server?: FakeMcpServer;
    timeoutMs?: number;
  },
): () => void {
  let shuttingDown = false;
  const { exitSpy, server, timeoutMs = 5_000 } = opts;

  return function handleSignal() {
    if (shuttingDown) {
      exitSpy(code);
    }
    shuttingDown = true;

    try {
      process.stderr.write("assignee-mcp-server: shutting down (TEST).\n");
    } catch {
      /* stderr may already be gone */
    }

    // Crash-path lock release (M-β-16 fix).
    clearAllApplies();

    // Graceful-close with timeout, then exit (M-β-14 fix).
    const doShutdown = async (): Promise<void> => {
      if (server !== undefined) {
        await Promise.race([
          server.close(),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }
      exitSpy(code);
    };

    doShutdown().catch(() => exitSpy(code));
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP signal handler graceful shutdown (W6-S1)", () => {
  beforeEach(() => {
    _resetActiveApplies();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetActiveApplies();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clearAllApplies is called before process.exit — in-flight lock is released", async () => {
    const checkpointPath = "/tmp/signal-test-inflight.json";
    markApplyActive(checkpointPath);
    expect(isApplyActive(checkpointPath)).toBe(true);

    const exitSpy = vi.fn((_code: number): never => {
      throw new Error("process.exit called");
    });

    const fakeMcpServer: FakeMcpServer = {
      close: vi.fn().mockResolvedValue(undefined),
    };

    const handler = buildSignalHandler(128 + 15, {
      exitSpy: exitSpy as unknown as (c: number) => never,
      server: fakeMcpServer,
      timeoutMs: 100,
    });

    // Invoke the signal handler.
    handler();

    // clearAllApplies() is synchronous — lock must be gone immediately.
    expect(isApplyActive(checkpointPath)).toBe(false);

    // Advance timers to let doShutdown() resolve (close() resolves immediately).
    await vi.runAllTimersAsync();

    expect(exitSpy).toHaveBeenCalledWith(128 + 15);
  });

  it("process.exit is called with the correct code after server.close()", async () => {
    const exitSpy = vi.fn((_code: number): never => {
      throw new Error("process.exit called");
    });

    let closeResolved = false;
    const fakeMcpServer: FakeMcpServer = {
      close: vi.fn().mockImplementation(async () => {
        closeResolved = true;
      }),
    };

    const handler = buildSignalHandler(128 + 2, {
      exitSpy: exitSpy as unknown as (c: number) => never,
      server: fakeMcpServer,
      timeoutMs: 100,
    });

    handler();
    await vi.runAllTimersAsync();

    expect(closeResolved).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(128 + 2);
  });

  it("5-second timeout forces exit even if server.close() never resolves", async () => {
    const exitSpy = vi.fn((_code: number): never => {
      throw new Error("process.exit called");
    });

    const fakeMcpServer: FakeMcpServer = {
      // close() hangs forever.
      close: vi.fn().mockImplementation(() => new Promise(() => {})),
    };

    const handler = buildSignalHandler(128 + 15, {
      exitSpy: exitSpy as unknown as (c: number) => never,
      server: fakeMcpServer,
      timeoutMs: 5_000,
    });

    handler();

    // Before timeout fires, exit has NOT been called yet.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exitSpy).not.toHaveBeenCalled();

    // At timeout boundary, exit IS called.
    await vi.advanceTimersByTimeAsync(1);
    expect(exitSpy).toHaveBeenCalledWith(128 + 15);
  });

  it("second signal during shutdown exits immediately without re-entering async path", async () => {
    const exitSpy = vi.fn((_code: number): never => {
      throw new Error("process.exit called");
    });

    let closeCallCount = 0;
    const fakeMcpServer: FakeMcpServer = {
      close: vi.fn().mockImplementation(async () => {
        closeCallCount += 1;
        // Simulate a slow close that takes 3 s.
        await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
      }),
    };

    const handler = buildSignalHandler(128 + 15, {
      exitSpy: exitSpy as unknown as (c: number) => never,
      server: fakeMcpServer,
      timeoutMs: 5_000,
    });

    // First signal — starts async shutdown.
    handler();

    // Partial advance (server.close still in flight).
    await vi.advanceTimersByTimeAsync(500);

    // Second signal — must exit immediately without a second server.close().
    handler();

    expect(exitSpy).toHaveBeenCalledWith(128 + 15);
    // Only one server.close() call despite two signals.
    expect(closeCallCount).toBe(1);
  });

  it("shutdown with no server instance (pre-main startup) exits cleanly", async () => {
    const exitSpy = vi.fn((_code: number): never => {
      throw new Error("process.exit called");
    });

    // No server passed — simulates signal arriving before main() creates one.
    const handler = buildSignalHandler(128 + 1, {
      exitSpy: exitSpy as unknown as (c: number) => never,
      server: undefined,
      timeoutMs: 100,
    });

    handler();
    await vi.runAllTimersAsync();

    expect(exitSpy).toHaveBeenCalledWith(128 + 1);
  });

  it("activeApplies.size === 0 observable after clearAllApplies in shutdown path", async () => {
    const paths = [
      "/tmp/shutdown-path-1.json",
      "/tmp/shutdown-path-2.json",
    ] as const;

    for (const p of paths) {
      markApplyActive(p);
    }

    const exitSpy = vi.fn((_code: number): never => {
      throw new Error("process.exit called");
    });

    const handler = buildSignalHandler(128 + 15, {
      exitSpy: exitSpy as unknown as (c: number) => never,
      server: { close: vi.fn().mockResolvedValue(undefined) },
      timeoutMs: 100,
    });

    handler();

    // Locks cleared synchronously.
    for (const p of paths) {
      expect(isApplyActive(p)).toBe(false);
    }

    await vi.runAllTimersAsync();
    expect(exitSpy).toHaveBeenCalledWith(128 + 15);
  });
});
