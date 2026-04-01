/**
 * MCP Server configurations for the Assignee.ai CLI.
 * These configs are used by @langchain/mcp-adapters to spawn MCP server processes.
 *
 * Credential separation (3-user model — Story 18.8):
 *   - Operator (ASSIGNEE_OPERATOR_*): used directly by CLI for Bedrock + CloudControl
 *   - Reader (ASSIGNEE_READER_*): passed to MCP servers needing schema/pricing/billing
 *   - Auditor (ASSIGNEE_AUDITOR_*): passed to MCP servers needing IAM/SecurityHub access
 *   All sets live in .env — see .env.example.
 *
 * IMPORTANT: getMcpServerConfigs() is a factory function (not a const) so that
 * process.env is read at call time, after process.loadEnvFile() has run in index.ts.
 * ESM static imports execute before the module body, so a top-level const would
 * capture empty env vars on startup.
 *
 * @see architecture.md — MCP Servers Catalog section
 */
import { McpServerName, McpCommand } from "../constants/mcp.js";
import { AWS_REGION } from "./constants.js";

export interface McpServerConfig {
  /** The command to execute (e.g. 'uvx', 'npx') */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Optional environment variables for the server process */
  env?: Record<string, string>;
}

/**
 * Reader credential env block — maps ASSIGNEE_READER_* to standard AWS_* for MCP subprocess.
 * Used by: aws-pricing-mcp-server, aws-cost-management-mcp-server.
 */
function readerEnv(region = AWS_REGION): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] ?? "",
    AWS_SECRET_ACCESS_KEY:
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] ?? "",
    AWS_DEFAULT_REGION: region,
    FASTMCP_LOG_LEVEL: "ERROR",
  };
}

/**
 * Auditor credential env block — maps ASSIGNEE_AUDITOR_* to standard AWS_* for MCP subprocess.
 * Used by: iam-mcp-server, well-architected-security-mcp-server.
 */
function auditorEnv(region = AWS_REGION): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] ?? "",
    AWS_SECRET_ACCESS_KEY:
      process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] ?? "",
    AWS_DEFAULT_REGION: region,
    FASTMCP_LOG_LEVEL: "ERROR",
  };
}

/**
 * Factory that returns the 3 core MCP server process configurations.
 * Called at runtime (not module load) so credential env vars are available.
 *
 * Region notes:
 *   - Pricing: us-east-1 — AWS Pricing API only available in us-east-1
 *   - Knowledge: no AWS creds — public remote API via fastmcp
 *   - Docs:    no AWS creds — public documentation API via uvx subprocess
 *
 * Note: Schema fetching is handled
 * by CloudFormationSchemaService (direct SDK) — see Story 31.3.
 */
export function getMcpServerConfigs(): Record<string, McpServerConfig> {
  return {
    // Pricing API is only available in us-east-1
    // --with "botocore[crt]" is required for the pricing server's AWS credential chain
    [McpServerName.PRICING]: {
      command: McpCommand.UVX,
      args: [
        "--with",
        "botocore[crt]",
        "awslabs.aws-pricing-mcp-server@latest",
      ],
      env: readerEnv("us-east-1"),
    },
    // Documentation server: targeted section-level access to AWS official docs via read_sections.
    // Complements the Knowledge server (which adds blogs/What's New/Builder Center/regional data).
    // No AWS credentials needed — public documentation API.
    [McpServerName.DOCS]: {
      command: McpCommand.UVX,
      args: ["awslabs.aws-documentation-mcp-server@latest"],
    },
  };
}

/**
 * Factory that returns MCP server configs for optional intelligence servers.
 * These servers are non-critical — if they fail to start, provisioning continues without them.
 * Spawned as a separate MultiServerMCPClient instance so failures don't crash core servers.
 *
 * @see Story 19.1 — IAM MCP server (read-only)
 * @see Story 19.2 — Well-Architected Security MCP server
 */
export function getOptionalMcpServerConfigs(): Record<string, McpServerConfig> {
  return {
    // Knowledge server: remote API via fastmcp — non-critical, used for doc lookup
    [McpServerName.KNOWLEDGE]: {
      command: McpCommand.UVX,
      args: ["fastmcp", "run", "https://knowledge-mcp.global.api.aws"],
    },
    [McpServerName.IAM]: {
      command: McpCommand.UVX,
      args: ["awslabs.iam-mcp-server@latest", "--readonly"],
      env: auditorEnv(),
    },
    // Well-Architected Security server: post-provision security posture analysis.
    // Aggregates findings from SecurityHub, GuardDuty, Inspector, IAM Access Analyzer.
    // Needs auditor-level AWS creds for security service API access.
    [McpServerName.WELL_ARCHITECTED_SECURITY]: {
      command: McpCommand.UVX,
      args: ["awslabs.well-architected-security-mcp-server@latest"],
      env: auditorEnv(),
    },
    // Cost Management server: live billing data for cost estimates and savings display.
    // Provides get_cost_and_usage, get_cost_forecast tools.
    // Needs reader-level AWS creds with ce:GetCostAndUsage, ce:GetCostForecast permissions.
    [McpServerName.BILLING]: {
      command: McpCommand.UVX,
      args: ["awslabs.cost-management-mcp-server@latest"],
      env: readerEnv(),
    },
  };
}
