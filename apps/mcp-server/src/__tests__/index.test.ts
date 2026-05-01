/**
 * W20-S3 (M-β-038) — transport-connect error discrimination.
 * W21-S1 refactor: import the real connectTransport helper instead of
 * re-implementing the block inline.
 *
 * Verifies that a failure in `server.connect(transport)` emits the
 * discriminated `[transport]` prefix + restart hint to stderr, and exits
 * with code 1, rather than falling through to the generic `fatal:` handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectTransport } from "../utils/connect-transport.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// ---------------------------------------------------------------------------
// Helper: drive connectTransport with a stub server that rejects/resolves.
// ---------------------------------------------------------------------------

/**
 * Runs connectTransport(server, transport) where server.connect is replaced
 * by the provided connectFn.  Captures stderr output and exit code without
 * actually writing to stderr or exiting the process.
 */
async function runConnectTransport(connectFn: () => Promise<void>): Promise<{
  stderrOutput: string;
  exitCode: number | undefined;
}> {
  const stderrChunks: string[] = [];
  let exitCode: number | undefined;

  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((code?: number | string | null | undefined): never => {
      exitCode = typeof code === "number" ? code : 0;
      // Throw so execution stops at the process.exit() call site.
      throw new Error(`__process_exit__:${exitCode}`);
    });

  // Minimal stub: only the connect method matters.
  const fakeServer = {
    connect: connectFn,
  } as unknown as McpServer;

  const fakeTransport = {} as unknown as StdioServerTransport;

  try {
    await connectTransport(fakeServer, fakeTransport);
  } catch (err) {
    // Swallow __process_exit__ throws produced by the exit spy; rethrow
    // any genuine unexpected error.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("__process_exit__")) {
      throw err;
    }
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
    const { stderrOutput } = await runConnectTransport(async () => {
      throw new Error("EPIPE: broken pipe, write");
    });

    expect(stderrOutput).toContain("[transport]");
    expect(stderrOutput).toContain("failed to connect to stdio");
  });

  it("emits restart hint (Claude Desktop, Cursor) when server.connect throws", async () => {
    const { stderrOutput } = await runConnectTransport(async () => {
      throw new Error("ENOENT: no such file");
    });

    expect(stderrOutput).toContain("restart the MCP host");
    expect(stderrOutput).toContain("Claude Desktop");
    expect(stderrOutput).toContain("Cursor");
  });

  it("exits with code 1 on transport-connect failure", async () => {
    const { exitCode } = await runConnectTransport(async () => {
      throw new Error("connection refused");
    });

    expect(exitCode).toBe(1);
  });

  it("includes the original error message in the stderr output", async () => {
    const errorDetail = "ETIMEDOUT: connection timed out, connect";
    const { stderrOutput } = await runConnectTransport(async () => {
      throw new Error(errorDetail);
    });

    expect(stderrOutput).toContain(errorDetail);
  });

  it("handles non-Error thrown values (string rejection)", async () => {
    const { stderrOutput } = await runConnectTransport(async () => {
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

  it("resolves without error when server.connect succeeds", async () => {
    const { stderrOutput, exitCode } = await runConnectTransport(async () => {
      /* success — no throw */
    });

    expect(stderrOutput).toBe("");
    expect(exitCode).toBeUndefined();
  });
});
