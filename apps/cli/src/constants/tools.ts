/**
 * MCP tool name constants — single source of truth for all tool identifiers.
 *
 * Groups by MCP server:
 *   aws-iac-mcp-server      → schema fetching
 *   aws-pricing-mcp-server  → cost estimation
 */

export const ToolName = {
  // ── aws-iac-mcp-server ──────────────────────────────────────────────────────
  GET_RESOURCE_SCHEMA: "get_resource_schema_information",

  // ── aws-pricing-mcp-server ─────────────────────────────────────────────────
  GET_PRICING: "get_pricing",
} as const;

export type ToolNameType = (typeof ToolName)[keyof typeof ToolName];
