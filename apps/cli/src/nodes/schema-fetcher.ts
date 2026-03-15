import { ExecutionStatus } from '@assignee/core'
import type { StructuredTool } from '@langchain/core/tools'
import type { AgentState } from '../services/graph.js'

export async function schemaFetcherNode(state: AgentState, tools?: StructuredTool[]): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {}  // skip if already failed

  const getResourceSchema = tools?.find(t => t.name === 'aws_cfn_get_resource_schema')
  if (!getResourceSchema) {
    return { executionStatus: ExecutionStatus.FAILED, errorMessage: 'cfn-mcp-server not available' }
  }

  try {
    const schemaStr = await getResourceSchema.invoke({ type_name: state.resourceType })
    // The MCP tool usually returns JSON stringified content
    const schema = typeof schemaStr === 'string' ? JSON.parse(schemaStr) : schemaStr
    return { resourceSchema: schema }
  } catch (err: unknown) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Failed to fetch schema for ${state.resourceType}. Check cfn-mcp-server is running. Error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
