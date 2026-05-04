/**
 * connectTransport — wraps server.connect(transport) with discriminated
 * error handling introduced by W20-S3 (M-β-038).
 *
 * On failure emits a structured JSON error envelope (matching the canonical
 * MCP server error-envelope shape used by all tool handlers) to stderr, then
 * exits with code 1.  The envelope shape is:
 *
 *   { error: true, code: "TRANSPORT_CONNECT_FAILED", message: "…", hint: "…" }
 *
 * F036 (full-audit-2026-05-02): the previous plain-text write was inconsistent
 * with the rest of the MCP server, which always emits
 * `{error: true, message, hint?, code?}` JSON in its error paths.
 *
 * Extracted from index.ts main() by W21-S1 so tests can import the real
 * implementation instead of re-implementing the block inline.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Error code for transport-connection failures (mirrored from destroy-resource DESTROY_ERROR_CODES pattern). */
export const TRANSPORT_ERROR_CODES = {
  CONNECT_FAILED: "TRANSPORT_CONNECT_FAILED",
} as const;

export async function connectTransport(
  server: McpServer,
  transport: StdioServerTransport,
): Promise<void> {
  try {
    await server.connect(transport);
  } catch (err) {
    const envelope = {
      error: true,
      code: TRANSPORT_ERROR_CODES.CONNECT_FAILED,
      // [transport] discriminator token preserved for operator grep / log triage.
      message: "[transport] failed to connect to stdio transport",
      hint: "restart the MCP host (e.g. Claude Desktop, Cursor) to re-establish the connection. If reconnect loops, check ~/.assignee/logs/cli-…jsonl for the actual error.",
      detail: err instanceof Error ? err.message : String(err),
    };
    process.stderr.write(JSON.stringify(envelope) + "\n");
    process.exit(1);
  }
}
