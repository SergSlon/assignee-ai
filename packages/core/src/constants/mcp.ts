export const McpServerName = {
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
