import {
  MultiServerMCPClient,
  type ClientConfig,
} from "@langchain/mcp-adapters";
import {
  getMcpServerConfigs,
  getOptionalMcpServerConfigs,
} from "../config/mcp-servers.js";
import { ProcessExitCode } from "../constants/errors.js";
import { ToolName } from "../constants/tools.js";
import type { StructuredTool } from "@langchain/core/tools";

let client: MultiServerMCPClient | null = null;
let optionalClient: MultiServerMCPClient | null = null;

/**
 * Creates and initializes a MultiServerMCPClient connecting to all configured MCP servers.
 * Acts as a singleton: subsequent calls return the already-initialized client.
 * Server connection is deferred until this factory is called.
 *
 * @returns {Promise<MultiServerMCPClient>} An initialized client with connections to all MCP servers.
 */
export async function createMcpClient(): Promise<MultiServerMCPClient> {
  if (client) return client;

  const serverConfigs = getMcpServerConfigs();
  const clientConfig: ClientConfig = {
    mcpServers: Object.fromEntries(
      Object.entries(serverConfigs).map(([name, config]) => [
        name,
        {
          transport: "stdio" as const,
          command: config.command,
          args: config.args,
          env: config.env,
          stderr: "pipe" as const,
        },
      ]),
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
    const failedServer = Object.keys(serverConfigs).find((key) =>
      errMsg.includes(key),
    );

    if (failedServer) {
      const config = serverConfigs[failedServer];
      // Ensure config is defined before accessing properties
      if (config) {
        const installCmd = `${config.command} ${config.args.join(" ")}`;
        console.error(
          `\n✖ MCP server '${failedServer}' failed to start.\n  Is it installed? Run: ${installCmd}\n`,
        );
      } else {
        console.error(
          `\n✖ MCP server '${failedServer}' failed to start.\n  Please check your installation.\n`,
        );
      }
    } else {
      console.error(
        `\n✖ An unknown MCP server failed to start.\n  Error details: ${errMsg}\n`,
      );
    }

    process.exit(ProcessExitCode.MCP_STARTUP_FAILED);
  }

  // Story 19.1: Initialize optional intelligence servers (IAM, WA Security, Billing).
  // These use ASSIGNEE_AUDITOR_* or ASSIGNEE_READER_* credentials (mapped to AWS_* in subprocess env).
  // Spawned as a separate client so failures don't crash the core servers.
  const optionalConfigs = getOptionalMcpServerConfigs();
  if (Object.keys(optionalConfigs).length > 0) {
    const optionalClientConfig: ClientConfig = {
      mcpServers: Object.fromEntries(
        Object.entries(optionalConfigs).map(([name, config]) => [
          name,
          {
            transport: "stdio" as const,
            command: config.command,
            args: config.args,
            env: config.env,
            stderr: "pipe" as const,
          },
        ]),
      ),
    };

    try {
      optionalClient = new MultiServerMCPClient(optionalClientConfig);
      await optionalClient.initializeConnections();
    } catch {
      // Graceful degradation: optional servers failed, continue without them.
      // The tools simply won't appear in the tools[] array.
      if (optionalClient) {
        try {
          await optionalClient.close();
        } catch {
          // Ignore close errors
        }
      }
      optionalClient = null;
    }
  }

  return client;
}

/**
 * Retrieves all registered tools from the connected MCP servers,
 * formatted as LangChain-compatible StructuredTools.
 * Includes tools from both core and optional (gracefully degraded) servers.
 *
 * @param {MultiServerMCPClient} mcpClient - The initialized core MCP client.
 * @returns {Promise<StructuredTool[]>} Array of tools ready for use by a LangGraph node.
 */
export async function getMcpTools(
  mcpClient: MultiServerMCPClient,
): Promise<StructuredTool[]> {
  const coreTools = await mcpClient.getTools();
  if (optionalClient) {
    try {
      const optTools = await optionalClient.getTools();
      return [...coreTools, ...optTools];
    } catch {
      // Optional tools unavailable — continue with core tools only
    }
  }
  return coreTools;
}

/**
 * Retrieves billing MCP tools from the optional client.
 * Returns undefined if the optional client is not initialized or server failed.
 *
 * @see Story 19.7
 */
export async function getBillingMcpToolsAsync(): Promise<
  StructuredTool[] | undefined
> {
  if (!optionalClient) return undefined;

  try {
    const allTools = await optionalClient.getTools();
    const billingToolNames = new Set<string>([
      ToolName.GET_COST_AND_USAGE,
      ToolName.GET_COST_FORECAST,
    ]);
    const billingTools = allTools.filter((t) => billingToolNames.has(t.name));
    return billingTools.length > 0 ? billingTools : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Closes the MCP client connections gracefully.
 */
export async function closeMcpClient(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  if (client) {
    closePromises.push(client.close());
    client = null;
  }
  if (optionalClient) {
    closePromises.push(optionalClient.close());
    optionalClient = null;
  }
  await Promise.allSettled(closePromises);
}
