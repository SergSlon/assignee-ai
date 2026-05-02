/**
 * connectTransport — wraps server.connect(transport) with discriminated
 * error handling introduced by W20-S3 (M-β-038).
 *
 * On failure emits:
 *   assignee-mcp-server error: [transport] … restart hint … Detail: <msg>
 * then exits with code 1.
 *
 * Extracted from index.ts main() by W21-S1 so tests can import the real
 * implementation instead of re-implementing the block inline.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function connectTransport(
  server: McpServer,
  transport: StdioServerTransport,
): Promise<void> {
  try {
    await server.connect(transport);
  } catch (err) {
    process.stderr.write(
      `assignee-mcp-server error: [transport] failed to connect to stdio; restart the MCP host (e.g. Claude Desktop, Cursor) to re-establish the connection. → host should respawn this process; if reconnect loops, check ~/.assignee/logs/cli-…jsonl for the actual error. Detail: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
