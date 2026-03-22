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

async function main() {
  const server = new McpServer({
    name: "assignee-ai",
    version: "0.1.0",
  });

  // Initialize the LangGraph agent graph (Story 20.2)
  let ctx;
  try {
    ctx = await createGraphContext();
  } catch (err) {
    process.stderr.write(
      `assignee-mcp-server warning: graph init failed (${err instanceof Error ? err.message : String(err)}). Tools will return NOT_READY until graph is available.\n`,
    );
  }

  // Register all 4 MCP tools
  registerTools(server, ctx);

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `assignee-mcp-server fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
