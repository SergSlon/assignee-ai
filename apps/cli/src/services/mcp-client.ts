import { MultiServerMCPClient, type ClientConfig } from '@langchain/mcp-adapters';
import { MCP_SERVER_CONFIGS } from '../config/mcp-servers.js';
import type { StructuredTool } from '@langchain/core/tools';

let client: MultiServerMCPClient | null = null;

/**
 * Creates and initializes a MultiServerMCPClient connecting to all configured MCP servers.
 * Acts as a singleton: subsequent calls return the already-initialized client.
 * Server connection is deferred until this factory is called.
 *
 * @returns {Promise<MultiServerMCPClient>} An initialized client with connections to all MCP servers.
 */
export async function createMcpClient(): Promise<MultiServerMCPClient> {
  if (client) return client;

  const clientConfig: ClientConfig = {
    mcpServers: Object.fromEntries(
      Object.entries(MCP_SERVER_CONFIGS).map(([name, config]) => [
        name,
        {
          transport: 'stdio' as const,
          command: config.command,
          args: config.args,
          env: config.env,
        },
      ])
    ),
  };

  client = new MultiServerMCPClient(clientConfig);

  await client.initializeConnections();
  return client;
}

/**
 * Retrieves all registered tools from the connected MCP servers,
 * formatted as LangChain-compatible StructuredTools.
 *
 * @param {MultiServerMCPClient} mcpClient - The initialized MCP client.
 * @returns {Promise<StructuredTool[]>} Array of tools ready for use by a LangGraph node.
 */
export async function getMcpTools(mcpClient: MultiServerMCPClient): Promise<StructuredTool[]> {
  return mcpClient.getTools();
}
