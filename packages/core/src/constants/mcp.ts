export const McpServerName = {
  // KNOWLEDGE: tombstone — server retired (acquisition-DD findings,
  // 2026-04-24). Constant kept so tests can assert its absence; do NOT
  // add it back to the server registry without re-evaluating the original
  // retirement finding. See `docs/mcp-servers.md` for operator-facing context.
  KNOWLEDGE: "aws-knowledge-mcp-server",
  PRICING: "aws-pricing-mcp-server",
  DOCS: "aws-documentation-mcp-server",
  IAM: "iam-mcp-server",
  WELL_ARCHITECTED_SECURITY: "well-architected-security-mcp-server",
  BILLING: "aws-cost-management-mcp-server",
} as const;

export type McpServerNameType =
  (typeof McpServerName)[keyof typeof McpServerName];

export const McpCommand = {
  UVX: "uvx",
} as const;
