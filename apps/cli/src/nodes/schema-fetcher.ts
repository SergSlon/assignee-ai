import { ExecutionStatus } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import type { AgentState } from "../services/graph.js";

export async function schemaFetcherNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {}; // skip if already failed

  const getResourceSchema = tools?.find(
    (t) => t.name === "get_resource_schema_information",
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
    // aws-iac-mcp-server returns { type: "text", text: "<json>" }; unwrap accordingly
    const rawObj = raw as Record<string, unknown>;
    const text =
      typeof rawObj?.["text"] === "string"
        ? rawObj["text"]
        : typeof raw === "string"
          ? raw
          : JSON.stringify(raw);
    const schema = JSON.parse(text) as Record<string, unknown>;
    return { resourceSchema: schema };
  } catch (err: unknown) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Failed to fetch schema for ${state.resourceType}. Check cfn-mcp-server is running. Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
