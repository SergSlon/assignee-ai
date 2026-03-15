/**
 * MCP tool name constants — single source of truth for all tool identifiers.
 *
 * Groups by MCP server:
 *   aws-iac-mcp-server      → schema fetching
 *   aws-pricing-mcp-server  → cost estimation
 *   ccapi-mcp-server        → Cloud Control API provisioning workflow
 */

export const ToolName = {
  // ── aws-iac-mcp-server ──────────────────────────────────────────────────────
  GET_RESOURCE_SCHEMA: "get_resource_schema_information",

  // ── aws-pricing-mcp-server ─────────────────────────────────────────────────
  GET_PRICING: "get_pricing",

  // ── ccapi-mcp-server ───────────────────────────────────────────────────────
  /** State guard (FR-15 Read-Before-Write): check resource existence */
  GET_RESOURCE: "get_resource",
  /** Step 1: validate credentials → credentials_token */
  GET_AWS_ACCOUNT_INFO: "get_aws_account_info",
  /** Step 2: generate IaC code → generated_code_token */
  GENERATE_INFRASTRUCTURE_CODE: "generate_infrastructure_code",
  /** Step 3: explain the plan → explained_token */
  EXPLAIN: "explain",
  /** Step 4: security scan → security_scan_token */
  RUN_CHECKOV: "run_checkov",
  /** Step 5: create resource async → request_token */
  CREATE_RESOURCE: "create_resource",
  /** Poll async operation status */
  GET_RESOURCE_REQUEST_STATUS: "get_resource_request_status",
} as const;

export type ToolNameType = (typeof ToolName)[keyof typeof ToolName];
