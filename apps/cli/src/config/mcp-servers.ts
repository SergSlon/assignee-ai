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

/** AWS credential env block forwarded to every MCP server subprocess. */
function mcpEnv(): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: process.env["MCP_AWS_ACCESS_KEY_ID"] ?? "",
    AWS_SECRET_ACCESS_KEY: process.env["MCP_AWS_SECRET_ACCESS_KEY"] ?? "",
    AWS_DEFAULT_REGION: process.env["AWS_REGION"] ?? "eu-west-1",
  };
}

/**
 * Single source of truth for MCP server process configurations.
 * Must match the MCP server configs used in .gemini/mcp_config.json.
 */
export const MCP_SERVER_CONFIGS: Record<string, McpServerConfig> = {
  // Install: uvx awslabs.ccapi-mcp-server@latest
  [McpServerName.CCAPI]: {
    command: McpCommand.UVX,
    args: ["awslabs.ccapi-mcp-server@latest"],
    env: mcpEnv(),
  },
  // Install: uvx awslabs.cfn-mcp-server@latest
  [McpServerName.CFN]: {
    command: McpCommand.UVX,
    args: ["awslabs.cfn-mcp-server@latest"],
    env: mcpEnv(),
  },
  // Install: uvx awslabs.aws-knowledge-mcp-server@latest
  [McpServerName.KNOWLEDGE]: {
    command: McpCommand.UVX,
    args: ["awslabs.aws-knowledge-mcp-server@latest"],
    env: mcpEnv(),
  },
  // Install: uvx awslabs.aws-pricing-mcp-server@latest
  [McpServerName.PRICING]: {
    command: McpCommand.UVX,
    args: ["awslabs.aws-pricing-mcp-server@latest"],
    env: mcpEnv(),
  },
} as const;
