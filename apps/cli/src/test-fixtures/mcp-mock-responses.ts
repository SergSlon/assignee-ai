/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/test-fixtures/mcp-mock-responses` (Story 50-4 Wave 5
 * Pass H.2). The full fixture tree was lifted into core alongside the
 * preflight-guard test relocation so core coverage restored above floor.
 *
 * Usage in CLI tests (unchanged):
 *   import { McpMocks, createMockTool } from "../test-fixtures/mcp-mock-responses.js";
 */
export * from "@assignee/core/test-fixtures/mcp-mock-responses.js";
