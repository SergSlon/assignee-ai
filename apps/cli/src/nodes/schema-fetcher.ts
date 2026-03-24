import {
  ExecutionStatus,
  CloudFormationSchemaService,
  SchemaFetchError,
  adaptDescribeTypeToMcpFormat,
} from "@assignee/core";
import type { AgentState } from "../services/graph.js";

/** Module-level singleton — lazily initialised on first use. */
let schemaService: CloudFormationSchemaService | null = null;

function getSchemaService(): CloudFormationSchemaService {
  if (!schemaService) {
    schemaService = new CloudFormationSchemaService();
  }
  return schemaService;
}

export async function schemaFetcherNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (state.resourcePattern) return {}; // compound pattern path — schema_fetcher is single-resource only; compound-dispatcher handles this
  if (state.executionStatus !== ExecutionStatus.PENDING) return {}; // skip if already failed

  try {
    const service = getSchemaService();
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
}

/** Reset the singleton — exposed for testing only. */
export function _resetSchemaService(): void {
  schemaService = null;
}
