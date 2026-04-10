/**
 * MCP tool name constants — single source of truth for all tool identifiers.
 *
 * Groups by MCP server:
 *   aws-pricing-mcp-server        → cost estimation
 *   aws-documentation-mcp-server  → contextual field help
 *
 * Note: Schema fetching is handled by CloudFormationSchemaService (direct SDK)
 * is now handled by CloudFormationSchemaService (direct SDK) — see Story 31.3.
 */

export const ToolName = {
  // ── aws-pricing-mcp-server ─────────────────────────────────────────────────
  GET_PRICING: "get_pricing",

  // ── aws-documentation-mcp-server ───────────────────────────────────────────
  SEARCH_DOCUMENTATION: "search_documentation",
  READ_SECTIONS: "read_sections",
  READ_DOCUMENTATION: "read_documentation",

  // ── iam-mcp-server ────────────────────────────────────────────────────────
  SIMULATE_PRINCIPAL_POLICY: "simulate_principal_policy",

  // ── well-architected-security-mcp-server (v0.1.7+) ────────────────────────
  CHECK_SECURITY_SERVICES: "CheckSecurityServices",
  GET_SECURITY_FINDINGS: "GetSecurityFindings",
  CHECK_STORAGE_ENCRYPTION: "CheckStorageEncryption",
  CHECK_NETWORK_SECURITY: "CheckNetworkSecurity",

  // ── billing-cost-management-mcp-server ──────────────────────────────────
  COST_EXPLORER: "cost-explorer",
} as const;

export type ToolNameType = (typeof ToolName)[keyof typeof ToolName];
