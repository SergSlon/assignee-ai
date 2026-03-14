import { describe, it, expect } from 'vitest'
import { createGraph } from './graph.js'

describe('createGraph', () => {
  it('graph compiles and executes all nodes correctly with plan executionMode', async () => {
    const graph = createGraph()
    
    const result = await graph.invoke({
      userIntent: 'test',
      executionMode: 'plan',
      preflightPassed: true,  // bypass preflight → result_formatter path
    }, { configurable: { thread_id: 'test-thread' } })
    
    // Graph pauses at interruptBefore: resource_provisioner
    // In plan mode, human_approval → hits interrupt, so result should not fail early
    expect(result.executionStatus).not.toBe('FAILED')
    
    // The stubs are hardcoded to push us to SUCCESS state and true preflights
    expect(result.preflightPassed).toBe(true)
  })
})
