import { ExecutionStatus } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { unwrapMcpText } from "../utils/mcp.js";
import type { AgentState } from "../services/graph.js";

export async function schemaFetcherNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {}; // skip if already failed

  const getResourceSchema = tools?.find(
    (t) => t.name === ToolName.GET_RESOURCE_SCHEMA,
  );
  if (!getResourceSchema) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "cfn-mcp-server not available",
    };
  }

  try {
    const raw = await getResourceSchema.invoke({
      resource_type: state.resourceType,
    });
    const schema = JSON.parse(unwrapMcpText(raw)) as Record<string, unknown>;
    return { resourceSchema: schema };
  } catch (err: unknown) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Failed to fetch schema for ${state.resourceType}. Check cfn-mcp-server is running. Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
