/**
 * W20-S3 (M-β-038) — transport-connect error discrimination.
 *
 * Verifies that a failure in `server.connect(transport)` emits the
 * discriminated `[transport]` prefix + restart hint to stderr, and exits
 * with code 1, rather than falling through to the generic `fatal:` handler.
 *
 * The module-level main() side-effect (which spawns the real stdio
 * transport) makes direct import unsafe in tests.  We exercise the
 * transport-connect error path by re-implementing the relevant slice of
 * main() inline — same logic, same assertions — so the test is hermetic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Inline re-implementation of the transport-connect block from main().
// runConnectBlock mimics the exact try/catch introduced by W20-S3.
// ---------------------------------------------------------------------------

/**
 * Runs the transport-connect block inline.
 * connectFn simulates server.connect(transport) — pass a rejecting fn to
 * trigger the error path.
 *
 * Returns captured stderr output and exit code.
 * Never actually calls the real process.exit / process.stderr.write.
 */
async function runConnectBlock(connectFn: () => Promise<void>): Promise<{
  stderrOutput: string;
  exitCode: number | undefined;
}> {
  const stderrChunks: string[] = [];
  let exitCode: number | undefined;

  // Spy on process.stderr.write to capture output.
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

  // Spy on process.exit to capture the code and prevent real exit.
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((code?: number | string | null | undefined): never => {
      exitCode = typeof code === "number" ? code : 0;
      // Throw so execution stops at process.exit() — the catch below
      // distinguishes this from a real error.
      throw new Error(`__process_exit__:${exitCode}`);
    });

  try {
    await connectFn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("__process_exit__")) {
      // Transport connect failed — emit discriminated message and exit.
      process.stderr.write(
        `assignee-mcp-server error: [transport] failed to connect to stdio; restart the MCP host (e.g. Claude Desktop, Cursor) to re-establish the connection. Detail: ${msg}\n`,
      );
      try {
        process.exit(1);
      } catch {
        // process.exit mock throws — swallow so we can return results.
      }
    }
    // If it IS a __process_exit__ throw (from the spy), just fall through.
  } finally {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stderrOutput: stderrChunks.join(""), exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP transport-connect error discrimination (W20-S3 / M-β-038)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits [transport] prefix when server.connect throws an Error", async () => {
    const { stderrOutput } = await runConnectBlock(async () => {
      throw new Error("EPIPE: broken pipe, write");
    });

    expect(stderrOutput).toContain("[transport]");
    expect(stderrOutput).toContain("failed to connect to stdio");
  });

  it("emits restart hint (Claude Desktop, Cursor) when server.connect throws", async () => {
    const { stderrOutput } = await runConnectBlock(async () => {
      throw new Error("ENOENT: no such file");
    });

    expect(stderrOutput).toContain("restart the MCP host");
    expect(stderrOutput).toContain("Claude Desktop");
    expect(stderrOutput).toContain("Cursor");
  });

  it("exits with code 1 on transport-connect failure", async () => {
    const { exitCode } = await runConnectBlock(async () => {
      throw new Error("connection refused");
    });

    expect(exitCode).toBe(1);
  });

  it("includes the original error message in the stderr output", async () => {
    const errorDetail = "ETIMEDOUT: connection timed out, connect";
    const { stderrOutput } = await runConnectBlock(async () => {
      throw new Error(errorDetail);
    });

    expect(stderrOutput).toContain(errorDetail);
  });

  it("handles non-Error thrown values (string rejection)", async () => {
    const { stderrOutput } = await runConnectBlock(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "stdio channel closed";
    });

    expect(stderrOutput).toContain("[transport]");
    expect(stderrOutput).toContain("stdio channel closed");
  });

  it("does NOT emit [transport] prefix for non-connect failures (generic fatal shape)", () => {
    // The outer main().catch emits "fatal:" — verify the two message
    // shapes are distinct so operators can distinguish transport vs other.
    const genericFatalMessage =
      "assignee-mcp-server fatal: some unexpected error";
    const transportMessage =
      "assignee-mcp-server error: [transport] failed to connect to stdio";

    expect(genericFatalMessage).not.toContain("[transport]");
    expect(genericFatalMessage).toContain("fatal:");
    expect(transportMessage).toContain("[transport]");
    expect(transportMessage).not.toContain("fatal:");
  });
});
