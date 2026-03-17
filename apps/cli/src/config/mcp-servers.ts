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
 *   - IAC (cfn-mcp-server): us-east-1 — provides get_resource_schema_information for schema fetching.
 *     NOTE: cfn-mcp-server is deprecated by AWS in favour of aws-iac-mcp-server, but aws-iac-mcp-server
 *     v3+ dropped get_resource_schema_information (replaced by text-search tool search_cloudformation_documentation).
 *     Retained until schema-fetcher is migrated to CloudFormation Registry direct HTTP/SDK fetch (follow-up story).
 *   - Pricing: us-east-1 — AWS Pricing API only available in us-east-1
 *   - Knowledge: no AWS creds — public remote API via fastmcp
 *   - Docs:    no AWS creds — public documentation API via uvx subprocess
 */
export function getMcpServerConfigs(): Record<string, McpServerConfig> {
  return {
    [McpServerName.IAC]: {
      command: McpCommand.UVX,
      args: ["awslabs.cfn-mcp-server@latest"],
      env: mcpEnv("us-east-1"),
    },
    // Knowledge server: yanked uvx package — use remote API via fastmcp instead
    // Matches .gemini/antigravity/mcp_config.json "aws-knowledge-mcp-server"
    [McpServerName.KNOWLEDGE]: {
      command: McpCommand.UVX,
      args: ["fastmcp", "run", "https://knowledge-mcp.global.api.aws"],
    },
    // Pricing API is only available in us-east-1
    // --with "botocore[crt]" is required for the pricing server's AWS credential chain
    [McpServerName.PRICING]: {
      command: McpCommand.UVX,
      args: [
        "--with",
        "botocore[crt]",
        "awslabs.aws-pricing-mcp-server@latest",
      ],
      env: mcpEnv("us-east-1"),
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
