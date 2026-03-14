/**
 * MCP Server configurations for the Assignee.ai CLI.
 * These configs are used by @langchain/mcp-adapters to spawn MCP server processes.
 *
 * @see architecture.md — MCP Servers Catalog section
 * @see Story 1.1 — imports this constant to wire MCP tools into LangGraph
 */
import { McpServerName, McpCommand } from '../constants/mcp.js'

export interface McpServerConfig {
  /** The command to execute (e.g. 'uvx', 'npx') */
  command: string
  /** Arguments to pass to the command */
  args: string[]
  /** Optional environment variables for the server process */
  env?: Record<string, string>
}

/**
 * Single source of truth for MCP server process configurations.
 * Must match the MCP server configs used in .gemini/mcp_config.json.
 */
export const MCP_SERVER_CONFIGS: Record<string, McpServerConfig> = {
  // Install: uvx awslabs.ccapi-mcp-server@latest
  [McpServerName.CCAPI]: {
    command: McpCommand.UVX,
    args: ['awslabs.ccapi-mcp-server@latest'],
  },
  // Install: uvx awslabs.cfn-mcp-server@latest
  [McpServerName.CFN]: {
    command: McpCommand.UVX,
    args: ['awslabs.cfn-mcp-server@latest'],
  },
  // Install: uvx awslabs.aws-knowledge-mcp-server@latest
  [McpServerName.KNOWLEDGE]: {
    command: McpCommand.UVX,
    args: ['awslabs.aws-knowledge-mcp-server@latest'],
  },
  // Install: uvx awslabs.aws-pricing-mcp-server@latest
  [McpServerName.PRICING]: {
    command: McpCommand.UVX,
    args: ['awslabs.aws-pricing-mcp-server@latest'],
  },
} as const
