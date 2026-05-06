/**
 * Graph context type definition and factory for MCP server tools.
 * Provides the shared GraphContext type and createGraphContext() factory
 * that compiles the LangGraph agent graph at server startup.
 *
 * Story 50-4 Wave 5 Pass I: `createGraph` is now a top-of-file static
 * import from `@assignee/core/graph`. The previous dynamic import from
 * `assignee/dist/services/graph.js` (and the corresponding
 * `"assignee": "workspace:*"` dep in `apps/mcp-server/package.json`)
 * have been removed. The monorepo now has zero `app → app` runtime
 * dependencies — all shared code flows through `@assignee/core`.
 *
 * Credential resolution remains LAZY (preserves
 * `feedback_lazy_credential_resolution_in_mcp`): the static import at
 * module load does NOT touch the AWS SDK credential chain. Operator
 * credentials are resolved only when an MCP tool handler invokes the
 * graph and the graph's node calls
 * `requireAssigneeCredentials("operator")` / `createCloudControlClient()` on-demand.
 *
 * BLOCKER 2 fix (feature-query-intent-classifier): wire the MCP server's
 * existing `fetchManagedResources` implementation as the `resourceFetcher`
 * injected into `createGraph`. Without this, every MCP query intent hits
 * `if (!resourceFetcher)` in query-handler.ts and returns "not available in
 * this context" rather than resolving live AWS resources. The MCP service
 * at `apps/mcp-server/src/services/list-resources.ts` already has the same
 * RGTA pagination loop as the CLI — reused here, not duplicated.
 *
 * @see Epic 20, Story 20.1, Story 20.2
 * @see Story 50-4 Wave 5 Pass I handoff
 */

import { createGraph } from "@assignee/core/graph";
import { fetchManagedResources } from "./list-resources.js";

/**
 * Compiled LangGraph graph interface — minimal surface needed by tool handlers.
 * Uses a structural type so tools don't depend on a concrete LangGraph import.
 */
export interface CompiledGraph {
  invoke(
    input: Record<string, unknown> | null,
    config: {
      configurable: { thread_id: string };
      recursionLimit?: number;
    },
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
 * BLOCKER 2 fix: injects `fetchManagedResources` from the MCP server's
 * existing list-resources service as the `resourceFetcher` option.
 * Credential resolution stays LAZY — `fetchManagedResources` calls
 * `requireAssigneeCredentials` per invocation, not at graph-construction time.
 */
export async function createGraphContext(): Promise<GraphContext> {
  const graph = createGraph([], {
    // Wire the MCP-side RGTA fetcher so kind=query intents resolve live AWS
    // resources in the query_handler node. The service accepts an optional
    // region (first arg) which we leave undefined to fall back to the
    // per-invocation region resolution in resolveDefaultRegion().
    resourceFetcher: (resourceTypeFilter) =>
      fetchManagedResources(undefined, resourceTypeFilter),
  }) as unknown as CompiledGraph;
  return {
    graph,
    cleanup: async () => {
      // No cleanup needed for in-memory graph; placeholder for future use.
    },
  };
}
