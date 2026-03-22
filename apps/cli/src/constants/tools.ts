/**
 * MCP tool name constants — single source of truth for all tool identifiers.
 *
 * Groups by MCP server:
 *   aws-iac-mcp-server            → schema fetching
 *   aws-pricing-mcp-server        → cost estimation
 *   aws-documentation-mcp-server  → contextual field help
 */

export const ToolName = {
  // ── aws-iac-mcp-server ──────────────────────────────────────────────────────
  GET_RESOURCE_SCHEMA: "get_resource_schema_information",

  // ── aws-pricing-mcp-server ─────────────────────────────────────────────────
  GET_PRICING: "get_pricing",

  // ── aws-documentation-mcp-server ───────────────────────────────────────────
  SEARCH_DOCUMENTATION: "search_documentation",
  READ_SECTIONS: "read_sections",
  READ_DOCUMENTATION: "read_documentation",

  // ── iam-mcp-server ────────────────────────────────────────────────────────
  SIMULATE_PRINCIPAL_POLICY: "simulate_principal_policy",

  // ── well-architected-security-mcp-server ──────────────────────────────────
  ANALYZE_SECURITY_POSTURE: "AnalyzeSecurityPosture",

  // ── aws-cost-management-mcp-server ──────────────────────────────────────
  GET_COST_AND_USAGE: "get_cost_and_usage",
  GET_COST_FORECAST: "get_cost_forecast",
} as const;

export type ToolNameType = (typeof ToolName)[keyof typeof ToolName];
