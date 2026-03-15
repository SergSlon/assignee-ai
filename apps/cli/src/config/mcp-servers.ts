/**
 * MCP Server configurations for the Assignee.ai CLI.
 * These configs are used by @langchain/mcp-adapters to spawn MCP server processes.
 *
 * Credential separation:
 *   - Bedrock calls use the standard AWS_* env vars (bedrock-dev-user)
 *   - MCP server processes use MCP_AWS_* env vars (aws-mcp-user)
 *   Both sets live in .env — see .env.example.
 *
 * IMPORTANT: getMcpServerConfigs() is a factory function (not a const) so that
 * process.env is read at call time, after process.loadEnvFile() has run in index.ts.
 * ESM static imports execute before the module body, so a top-level const would
 * capture empty env vars on startup.
 *
 * @see architecture.md — MCP Servers Catalog section
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
  region = process.env["AWS_REGION"] ?? "us-east-1",
): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: process.env["MCP_AWS_ACCESS_KEY_ID"] ?? "",
    AWS_SECRET_ACCESS_KEY: process.env["MCP_AWS_SECRET_ACCESS_KEY"] ?? "",
    AWS_DEFAULT_REGION: region,
    FASTMCP_LOG_LEVEL: "ERROR",
  };
}

/**
 * Factory that returns MCP server process configurations.
 * Called at runtime (not module load) so MCP_AWS_* env vars are available.
 *
 * Region notes:
 *   - CCAPI: us-east-1 — provisioning is regional, must match target region
 *   - IAC:   us-east-1 — CloudFormation validation/docs (replaces deprecated cfn-mcp-server)
 *   - Pricing: us-east-1 — AWS Pricing API only available in us-east-1
 *   - Knowledge: no AWS creds — public remote API via fastmcp
 */
export function getMcpServerConfigs(): Record<string, McpServerConfig> {
  return {
    [McpServerName.CCAPI]: {
      command: McpCommand.UVX,
      args: ["awslabs.ccapi-mcp-server@latest"],
      env: mcpEnv("us-east-1"),
    },
    [McpServerName.IAC]: {
      command: McpCommand.UVX,
      args: ["awslabs.aws-iac-mcp-server@latest"],
      env: mcpEnv("us-east-1"),
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
  };
}
