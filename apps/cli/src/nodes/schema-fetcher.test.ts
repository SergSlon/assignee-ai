import { describe, it, expect, vi } from 'vitest';
import { schemaFetcherNode } from './schema-fetcher.js';
import { ExecutionStatus } from '@assignee/core';
import type { AgentState } from '../services/graph.js';
import type { StructuredTool } from '@langchain/core/tools';

describe('schemaFetcherNode', () => {
  const mockSchema = {
    TypeName: 'AWS::S3::Bucket',
    Properties: {
      BucketName: { Type: 'string' }
    }
  };

  const createMockSchemaTool = (shouldFail = false): StructuredTool => {
    return {
      name: 'aws_cfn_get_resource_schema',
      invoke: vi.fn().mockImplementation(async () => {
        if (shouldFail) throw new Error('Tool execution failed');
        return JSON.stringify(mockSchema); // Mock MCP returning JSON string
      })
    } as unknown as StructuredTool;
  };

  it('bypasses logic if status is already FAILED', async () => {
    const state = { executionStatus: ExecutionStatus.FAILED, resourceType: 'AWS::S3::Bucket' } as AgentState;
    const result = await schemaFetcherNode(state);
    
    // Empty partial returned if executionStatus isn't PENDING
    expect(result).toEqual({}); 
  });

  it('fails if get_resource_schema tool is not found', async () => {
    const state = { executionStatus: ExecutionStatus.PENDING, resourceType: 'AWS::S3::Bucket' } as AgentState;
    // Empty array means tool is missing
    const result = await schemaFetcherNode(state, []); 

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toBe('cfn-mcp-server not available');
  });

  it('fetches and sets the schema on success', async () => {
    const tool = createMockSchemaTool();
    const state = { executionStatus: ExecutionStatus.PENDING, resourceType: 'AWS::S3::Bucket' } as AgentState;
    const result = await schemaFetcherNode(state, [tool]); 

    expect(result.executionStatus).toBeUndefined();
    expect(result.resourceSchema).toEqual(mockSchema);
  });

  it('sets execution status to FAILED on tool error', async () => {
    const failingTool = createMockSchemaTool(true);
    const state = { executionStatus: ExecutionStatus.PENDING, resourceType: 'AWS::S3::Bucket' } as AgentState;
    const result = await schemaFetcherNode(state, [failingTool]); 

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toBe('Failed to fetch schema for AWS::S3::Bucket. Check cfn-mcp-server is running. Error: Tool execution failed');
  });
});
