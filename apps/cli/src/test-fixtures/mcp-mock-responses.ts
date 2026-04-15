/**
 * Comprehensive MCP mock responses for MCP servers and tools, plus raw schema data.
 * ALL response data captured from live servers on 2026-03-22.
 *
 * This file is a thin facade — the actual fixture data lives in
 * ./mcp-mock-responses/ (split per resource type by story 48-10).
 *
 * Usage in tests (unchanged):
 *   import { McpMocks, createMockTool } from "../test-fixtures/mcp-mock-responses.js";
 */
export * from "./mcp-mock-responses/index.js";
