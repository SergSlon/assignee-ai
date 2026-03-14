import { MultiServerMCPClient, type ClientConfig } from '@langchain/mcp-adapters';
import { MCP_SERVER_CONFIGS } from '../config/mcp-servers.js';
import { ProcessExitCode } from '../constants/errors.js';
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

  try {
    // PERFORMANCE NOTE (NFR-05):
    // MCP stdio process cold-start time is EXCLUDED from the <3s goal.
    // The <3s budget begins AFTER all 4 MCP servers have responded to tools/list.
    // Rationale: MCP servers are infrastructure (like a database connection), not part
    // of the user-facing plan generation pipeline.
    // Typical cold-start: 200–800ms. Optimize with process pooling post-POC if needed.
    await client.initializeConnections();
  } catch (err) {
    // Attempt to extract the failing server name from the error message
    // @langchain/mcp-adapters error thrown format may vary, but typically hints at the server dict key
    const errMsg = err instanceof Error ? err.message : String(err);
    
    // Find matching server name from config keys
    const failedServer = Object.keys(MCP_SERVER_CONFIGS).find((key) => errMsg.includes(key));
    
    if (failedServer) {
        const config = MCP_SERVER_CONFIGS[failedServer];
        // Ensure config is defined before accessing properties
        if (config) {
            const installCmd = `${config.command} ${config.args.join(' ')}`;
            console.error(`\n✖ MCP server '${failedServer}' failed to start.\n  Is it installed? Run: ${installCmd}\n`);
        } else {
            console.error(`\n✖ MCP server '${failedServer}' failed to start.\n  Please check your installation.\n`);
        }
    } else {
        console.error(`\n✖ An unknown MCP server failed to start.\n  Error details: ${errMsg}\n`);
    }

    process.exit(ProcessExitCode.MCP_STARTUP_FAILED);
  }

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

/**
 * Closes the MCP client connections gracefully.
 */
export async function closeMcpClient(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
