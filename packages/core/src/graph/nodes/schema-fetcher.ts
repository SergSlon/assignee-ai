import {
  ExecutionStatus,
  CloudFormationSchemaService,
  SchemaFetchError,
  adaptDescribeTypeToMcpFormat,
} from "../../index.js";
import type { AgentState } from "../graph-state.js";

/**
 * Factory that returns a graph-node function bound to the supplied
 * `CloudFormationSchemaService` instance.
 *
 * Each call to `createGraph` constructs its own `CloudFormationSchemaService`
 * and passes it here, ensuring the service instance is scoped to a single
 * graph (and therefore a single tenant in a SaaS deployment). No
 * module-level mutable state is involved, so concurrent requests from
 * different tenants cannot share credentials or a cached schema service.
 *
 * The returned function has the same signature as the former
 * `schemaFetcherNode` export so callers (create-graph.ts, tests) need only
 * minimal changes.
 */
export function createSchemaFetcherNode(
  service: CloudFormationSchemaService,
): (state: AgentState) => Promise<Partial<AgentState>> {
  return async function schemaFetcherNode(
    state: AgentState,
  ): Promise<Partial<AgentState>> {
    if (state.resourcePattern) return {}; // compound pattern path — schema_fetcher is single-resource only; compound-dispatcher handles this
    if (state.executionStatus !== ExecutionStatus.PENDING) return {}; // skip if already failed
    if (!state.resourceType) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: "Missing resource type",
      };
    }

    try {
      const rawSchema = await service.getSchema(state.resourceType);
      const schema = adaptDescribeTypeToMcpFormat(
        rawSchema as Record<string, unknown>,
      );
      return { resourceSchema: schema };
    } catch (err: unknown) {
      const message =
        err instanceof SchemaFetchError
          ? `Schema fetch failed for ${err.typeName}: ${err.rootCause.message}`
          : `Failed to fetch schema for ${state.resourceType}: ${err instanceof Error ? err.message : String(err)}`;
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: message,
      };
    }
  };
}
