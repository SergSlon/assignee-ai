/**
 * MCP Server configurations for the Assignee.ai CLI.
 * These configs are used by @langchain/mcp-adapters to spawn MCP server processes.
 *
 * @see architecture.md — MCP Servers Catalog section
 * @see Story 1.1 — imports this constant to wire MCP tools into LangGraph
 */

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
  'ccapi-mcp-server': {
    command: 'uvx',
    args: ['awslabs.ccapi-mcp-server@latest'],
  },
  'cfn-mcp-server': {
    command: 'uvx',
    args: ['awslabs.cfn-mcp-server@latest'],
  },
  'aws-knowledge-mcp-server': {
    command: 'uvx',
    args: ['awslabs.aws-knowledge-mcp-server@latest'],
  },
  'aws-pricing-mcp-server': {
    command: 'uvx',
    args: ['awslabs.aws-pricing-mcp-server@latest'],
  },
} as const
