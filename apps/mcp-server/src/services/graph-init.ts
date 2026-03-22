/**
 * Graph context type definition and factory for MCP server tools.
 * Provides the shared GraphContext type and createGraphContext() factory
 * that compiles the LangGraph agent graph at server startup.
 *
 * @see Epic 20, Story 20.1, Story 20.2
 */

/**
 * Compiled LangGraph graph interface — minimal surface needed by tool handlers.
 * Uses a structural type so tools don't depend on a concrete LangGraph import.
 */
export interface CompiledGraph {
  invoke(
    input: Record<string, unknown> | null,
    config: { configurable: { thread_id: string } },
  ): Promise<Record<string, unknown>>;

  getState(config: {
    configurable: { thread_id: string };
  }): Promise<{ values: Record<string, unknown>; next: string[] }>;
}

/**
 * Shared context passed to all MCP tool handlers.
 * Created once at server startup and shared across all tool invocations.
 */
export interface GraphContext {
  graph: CompiledGraph;
  cleanup: () => Promise<void>;
}

/**
 * Create a GraphContext by compiling the LangGraph agent graph.
 * Called once at MCP server boot; the context is shared across all tool invocations.
 *
 * Dynamically imports the CLI's `createGraph` to avoid hard coupling at the module level.
 */
export async function createGraphContext(): Promise<GraphContext> {
  const { createGraph } = await import(
    /* webpackIgnore: true */
    "assignee/dist/services/graph.js"
  );
  const graph = (createGraph as () => CompiledGraph)();
  return {
    graph,
    cleanup: async () => {
      // No cleanup needed for in-memory graph; placeholder for future use.
    },
  };
}
