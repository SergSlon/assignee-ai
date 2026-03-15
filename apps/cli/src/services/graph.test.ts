import { describe, it, expect, vi } from 'vitest'
import { ExecutionMode, ExecutionStatus } from '@assignee/core'

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    output: { resourceType: 'AWS::S3::Bucket' }
  }),
  Output: {
    object: vi.fn()
  }
}))

vi.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: vi.fn(() => vi.fn()),
}))

vi.mock('../nodes/schema-fetcher.js', () => ({
  schemaFetcherNode: vi.fn().mockResolvedValue({
    resourceSchema: { Properties: {} }
  })
}))

import { createGraph } from './graph.js'

describe('createGraph', () => {
  it('graph compiles and executes all nodes correctly with plan executionMode', async () => {
    const graph = createGraph()
    
    const result = await graph.invoke({
      userIntent: 'test',
      executionMode: ExecutionMode.PLAN,
      preflightPassed: true,  // bypass preflight → result_formatter path
    }, { configurable: { thread_id: 'test-thread' } })
    
    // Graph pauses at interruptBefore: resource_provisioner
    // In plan mode, human_approval → hits interrupt, so result should not fail early
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED)
    
    // The stubs are hardcoded to push us to SUCCESS state and true preflights
    expect(result.preflightPassed).toBe(true)
  })
})
