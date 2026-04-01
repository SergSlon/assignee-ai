import {
  MultiServerMCPClient,
  type ClientConfig,
} from "@langchain/mcp-adapters";
import {
  getMcpServerConfigs,
  getOptionalMcpServerConfigs,
} from "../config/mcp-servers.js";
import { McpError } from "@assignee/core";
import { MCP_SHUTDOWN_DELAY_MS } from "../config/constants.js";
import { ToolName } from "../constants/tools.js";
import type { McpServerNameType } from "../constants/mcp.js";
import type { StructuredTool } from "@langchain/core/tools";
import { log, LOG_ACTIONS } from "../utils/logger.js";

let client: MultiServerMCPClient | null = null;
let optionalClient: MultiServerMCPClient | null = null;
let optionalInitPromise: Promise<void> | null = null;

/**
 * Creates and initializes a MultiServerMCPClient connecting to configured MCP servers.
 * Acts as a singleton: subsequent calls return the already-initialized client.
 * Server connection is deferred until this factory is called.
 *
 * @param requiredServers - When provided, only start servers whose names are in this list.
 *   Pass an empty array to skip all servers. Pass null/undefined to start all (legacy behavior).
 *   Unknown commands should pass null to get the safe fallback of starting all servers.
 * @returns {Promise<MultiServerMCPClient>} An initialized client with connections to MCP servers.
 * @see Story 29.3 — MCP Server Lazy Loading
 */
export async function createMcpClient(
  requiredServers?: McpServerNameType[] | null,
): Promise<MultiServerMCPClient> {
  if (client) return client;

  const allServerConfigs = getMcpServerConfigs();

  // Story 29.3: Filter server configs to only those required by the current command.
  // null/undefined = start all (safe fallback for unknown commands).
  const serverConfigs =
    requiredServers != null
      ? Object.fromEntries(
          Object.entries(allServerConfigs).filter(([name]) =>
            requiredServers.includes(name as McpServerNameType),
          ),
        )
      : allServerConfigs;

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
    // The <3s budget begins AFTER all 3 core MCP servers have responded to tools/list.
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
        process.stderr.write(
          `\n✖ MCP server '${failedServer}' failed to start.\n  Is it installed? Run: ${installCmd}\n`,
        );
      } else {
        process.stderr.write(
          `\n✖ MCP server '${failedServer}' failed to start.\n  Please check your installation.\n`,
        );
      }
    } else {
      process.stderr.write(
        `\n✖ An unknown MCP server failed to start.\n  Error details: ${errMsg}\n`,
      );
    }

    throw new McpError(
      failedServer
        ? `MCP server '${failedServer}' failed to start.`
        : `An unknown MCP server failed to start: ${errMsg}`,
      "MCP_STARTUP_FAILED",
    );
  }

  // Story 9.14: Initialize optional intelligence servers IN PARALLEL with core.
  // These use ASSIGNEE_AUDITOR_* or ASSIGNEE_READER_* credentials.
  // Spawned as a separate client so failures don't crash the core servers.
  // Story 29.3: Filter optional configs by requiredServers when provided.
  const allOptionalConfigs = getOptionalMcpServerConfigs();
  const optionalConfigs =
    requiredServers != null
      ? Object.fromEntries(
          Object.entries(allOptionalConfigs).filter(([name]) =>
            requiredServers.includes(name as McpServerNameType),
          ),
        )
      : allOptionalConfigs;
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

    // Non-blocking: don't await — let optional init run while caller proceeds.
    // Tools from optional servers are merged in getMcpTools() when ready.
    const pendingOptional = new MultiServerMCPClient(optionalClientConfig);
    optionalInitPromise = pendingOptional
      .initializeConnections()
      .then(() => {
        optionalClient = pendingOptional;
      })
      .catch(async (err) => {
        // Graceful degradation: optional servers failed, continue without them.
        log({
          ts: new Date().toISOString(),
          runId: "",
          level: "warn",
          action: LOG_ACTIONS.MCP_OPTIONAL_INIT_FAILED,
          extras: { error: err instanceof Error ? err.message : String(err) },
        });
        try {
          await pendingOptional.close();
        } catch {
          // Ignore close errors
        }
        optionalClient = null;
      });
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

  // Await the optional client initialization with a timeout to avoid a race
  // where getMcpTools() is called before the optional client finishes connecting.
  if (optionalInitPromise && !optionalClient) {
    try {
      await Promise.race([
        optionalInitPromise,
        new Promise<void>((resolve) =>
          setTimeout(resolve, MCP_SHUTDOWN_DELAY_MS),
        ),
      ]);
    } catch {
      // Timeout or init error — proceed with core tools only
    }
  }

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
  optionalInitPromise = null;
  await Promise.allSettled(closePromises);
}
