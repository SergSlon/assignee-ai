#!/usr/bin/env node
/**
 * Assignee.ai MCP Server — exposes plan/apply/list/estimate as MCP tools.
 * Uses stdio transport for compatibility with Cursor, Claude Code, Windsurf.
 *
 * @see Epic 20, ADR-008
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { createGraphContext } from "./services/graph-init.js";
import { clearAllApplies } from "./tools/apply-plan/active-applies.js";
import { connectTransport } from "./utils/connect-transport.js";
// W24b-S4: read version from package.json at module load; no more literal drift.
import { MCP_SERVER_VERSION } from "./utils/package-version.js";

// Story 50-2: graceful-shutdown parity with the CLI host. The stdio
// transport normally exits on stream close, but cloud hosts (tmux, ECS,
// nohup) deliver SIGHUP/SIGTERM before closing pipes, and Windows
// supervisors deliver SIGBREAK — installing handlers guarantees the
// child emits a terminal diagnostic before Node tears the event loop
// down. Re-entrancy guard mirrors the CLI.
//
// Story W6-S1 (M-β-14 + M-β-16): replaced synchronous process.exit with
// an async graceful-shutdown sequence:
//   1. Emit the diagnostic message to stderr.
//   2. Call clearAllApplies() to release any in-flight apply locks before
//      the event loop is torn down (prevents stale-lock on restart).
//   3. Await server.close() with a 5-second timeout so the MCP transport
//      has a chance to flush pending frames.
//   4. Call process.exit(code).
// A second signal during shutdown re-enters the mcpShuttingDown=true
// branch and exits immediately without waiting (bail-out guard).
let mcpShuttingDown = false;

// Holds the McpServer instance once main() has created it, so signal
// handlers can close the transport.  Undefined during the brief window
// before main() runs or if main() fails before constructing the server.
let mcpServerInstance: McpServer | undefined;

// How long (ms) to wait for server.close() before forcing exit.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;

export type McpShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK";

export function installMcpSignalHandler(
  signal: McpShutdownSignal,
  code: number,
): void {
  process.on(signal, () => {
    if (mcpShuttingDown) {
      // Second signal during shutdown — bail out immediately.
      process.exit(code);
    }
    mcpShuttingDown = true;

    try {
      process.stderr.write(`assignee-mcp-server: shutting down (${signal}).\n`);
    } catch {
      /* stderr may already be gone */
    }

    // Release all in-flight apply locks so a subsequent process start
    // does not see a stale "Active-applies cap reached" error (M-β-16).
    clearAllApplies();

    // Attempt graceful transport close with a timeout, then exit.
    const doShutdown = async (): Promise<void> => {
      if (mcpServerInstance !== undefined) {
        await Promise.race([
          mcpServerInstance.close(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, GRACEFUL_SHUTDOWN_TIMEOUT_MS),
          ),
        ]);
      }
      process.exit(code);
    };

    doShutdown().catch(() => {
      process.exit(code);
    });
  });
}
installMcpSignalHandler("SIGINT", 128 + 2);
installMcpSignalHandler("SIGTERM", 128 + 15);
installMcpSignalHandler("SIGHUP", 128 + 1);
if (process.platform === "win32") {
  installMcpSignalHandler("SIGBREAK", 128 + 21);
}

async function main() {
  const server = new McpServer({
    name: "assignee-ai",
    version: MCP_SERVER_VERSION,
  });

  // Expose the server instance to signal handlers so they can call
  // server.close() for a graceful transport flush before exit (W6-S1).
  mcpServerInstance = server;

  // Initialize the LangGraph agent graph (Story 20.2)
  let ctx;
  try {
    ctx = await createGraphContext();
  } catch (err) {
    process.stderr.write(
      `assignee-mcp-server warning: graph init failed (${err instanceof Error ? err.message : String(err)}). Tools will return NOT_READY until graph is available.\n`,
    );
  }

  // Register all 5 MCP tools
  registerTools(server, ctx);

  // Start stdio transport.
  // W20-S3 (M-β-038): transport-layer failures emit a discriminated
  // [transport] prefix + restart hint via connectTransport helper (W21-S1).
  const transport = new StdioServerTransport();
  await connectTransport(server, transport);
}

main().catch((err) => {
  process.stderr.write(
    `assignee-mcp-server fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
