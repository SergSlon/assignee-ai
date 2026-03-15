/**
 * MCP Server configurations for the Assignee.ai CLI.
 * These configs are used by @langchain/mcp-adapters to spawn MCP server processes.
 *
 * Credential separation:
 *   - Bedrock calls use the standard AWS_* env vars (bedrock-dev-user)
 *   - MCP server processes use MCP_AWS_* env vars (aws-mcp-user)
 *   Both sets live in .env — see .env.example.
 *
 * @see architecture.md — MCP Servers Catalog section
 * @see Story 1.1 — imports this constant to wire MCP tools into LangGraph
 */
import { McpServerName, McpCommand } from "../constants/mcp.js";

export interface McpServerConfig {
  /** The command to execute (e.g. 'uvx', 'npx') */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Optional environment variables for the server process */
  env?: Record<string, string>;
}

/** AWS credential env block forwarded to AWS MCP server subprocesses. */
function mcpEnv(
  region = process.env["AWS_REGION"] ?? "eu-west-1",
): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: process.env["MCP_AWS_ACCESS_KEY_ID"] ?? "",
    AWS_SECRET_ACCESS_KEY: process.env["MCP_AWS_SECRET_ACCESS_KEY"] ?? "",
    AWS_DEFAULT_REGION: region,
    FASTMCP_LOG_LEVEL: "ERROR",
  };
}

/**
 * Single source of truth for MCP server process configurations.
 * Must match the MCP server configs used in .gemini/antigravity/mcp_config.json.
 *
 * Region notes:
 *   - CCAPI: eu-west-1 — provisioning is regional, must match target region
 *   - CFN:   eu-west-1 — schema fetches are global but region arg required
 *   - Pricing: us-east-1 — AWS Pricing API only available in us-east-1
 *   - Knowledge: no AWS creds — public remote API via fastmcp
 */
export const MCP_SERVER_CONFIGS: Record<string, McpServerConfig> = {
  [McpServerName.CCAPI]: {
    command: McpCommand.UVX,
    args: ["awslabs.ccapi-mcp-server@latest"],
    env: mcpEnv("eu-west-1"),
  },
  [McpServerName.CFN]: {
    command: McpCommand.UVX,
    args: ["awslabs.cfn-mcp-server@latest"],
    env: mcpEnv("eu-west-1"),
  },
  // Knowledge server: yanked uvx package — use remote API via fastmcp instead
  // Matches .gemini/antigravity/mcp_config.json "aws-knowledge-mcp-server"
  [McpServerName.KNOWLEDGE]: {
    command: McpCommand.UVX,
    args: ["fastmcp", "run", "https://knowledge-mcp.global.api.aws"],
  },
  // Pricing API is only available in us-east-1
  [McpServerName.PRICING]: {
    command: McpCommand.UVX,
    args: ["awslabs.aws-pricing-mcp-server@latest"],
    env: mcpEnv("us-east-1"),
  },
} as const;
