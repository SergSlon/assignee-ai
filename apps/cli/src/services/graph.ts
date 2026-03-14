import { StateGraph, START, END, Annotation, MemorySaver } from '@langchain/langgraph'
import { type GraphState } from '@assignee/core'
import type { StructuredTool } from '@langchain/core/tools'

// Convert Zod schema fields to LangGraph reducers to create the true State Annotation
// Defaults match the GraphStateSchema defaults in @assignee/core
export const graphAnnotation = Annotation.Root({
  userIntent:           Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  runId:                Annotation<string>({ reducer: (_, b) => b, default: () => crypto.randomUUID() }),
  executionMode:        Annotation<'plan' | 'apply'>({ reducer: (_, b) => b, default: () => 'apply' }),
  resourceType:         Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  resourceSchema:       Annotation<Record<string, unknown> | undefined>({ reducer: (_, b) => b }),
  desiredState:         Annotation<Record<string, unknown> | undefined>({ reducer: (_, b) => b }),
  estimatedMonthlyCost: Annotation<string | undefined>({ reducer: (_, b) => b }),
  preflightPassed:      Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  preflightErrors:      Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  preflightMode:        Annotation<'local' | 'saas'>({ reducer: (_, b) => b, default: () => 'local' }),
  requestToken:         Annotation<string | undefined>({ reducer: (_, b) => b }),
  resourceArn:          Annotation<string | undefined>({ reducer: (_, b) => b }),
  executionStatus:      Annotation<GraphState['executionStatus']>({ reducer: (_, b) => b, default: () => 'PENDING' }),
  errorMessage:         Annotation<string | undefined>({ reducer: (_, b) => b }),
  startedAt:            Annotation<number | undefined>({ reducer: (_, b) => b }),
  messages:             Annotation<unknown[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
})

export type AgentState = typeof graphAnnotation.State

// Node signature — ALL nodes must match this LangGraph Runnable contract
type NodeFn = (state: AgentState) => Promise<Partial<AgentState>>

// All node stubs — return empty partial (LangGraph merges into state)
export const intentParserStub: NodeFn   = async () => ({})
export const schemaFetcherStub: NodeFn  = async () => ({})
export const planGeneratorStub: NodeFn  = async () => ({})
export const preflightGuardStub: NodeFn = async () => ({ preflightPassed: true })
export const humanApprovalStub: NodeFn  = async () => ({})
export const resourceProvisionerStub: NodeFn = async () => ({})
export const statusPollerStub: NodeFn   = async () => ({ executionStatus: 'SUCCESS' as const })
export const resultFormatterStub: NodeFn = async () => ({})

// Conditional routing for preflight_guard
function routePreflightGuard(state: AgentState): 'human_approval' | 'result_formatter' {
  return state.preflightPassed ? 'human_approval' : 'result_formatter'
}

// Conditional routing for status_poller (self-loop — see Story 2.3)
function routeStatusPoller(state: AgentState): 'status_poller' | 'result_formatter' {
  return state.executionStatus === 'IN_PROGRESS' ? 'status_poller' : 'result_formatter'
}

export function createGraph(tools: StructuredTool[] = []) {
  const workflow = new StateGraph(graphAnnotation)
    .addNode('intent_parser',       intentParserStub)
    .addNode('schema_fetcher',      schemaFetcherStub)
    .addNode('plan_generator',      planGeneratorStub)
    .addNode('preflight_guard',     preflightGuardStub)
    .addNode('human_approval',      humanApprovalStub)
    .addNode('resource_provisioner',resourceProvisionerStub)
    .addNode('status_poller',       statusPollerStub)
    .addNode('result_formatter',    resultFormatterStub)
    .addEdge(START, 'intent_parser')
    .addEdge('intent_parser', 'schema_fetcher')
    .addEdge('schema_fetcher', 'plan_generator')
    .addEdge('plan_generator', 'preflight_guard')
    .addConditionalEdges('preflight_guard', routePreflightGuard, {
      human_approval:    'human_approval',
      result_formatter:  'result_formatter',
    })
    .addEdge('human_approval', 'resource_provisioner')
    .addEdge('resource_provisioner', 'status_poller')
    // Self-loop: poller node routes to itself when IN_PROGRESS (Story 2.3)
    .addConditionalEdges('status_poller', routeStatusPoller, {
      status_poller:    'status_poller',
      result_formatter: 'result_formatter',
    })
    .addEdge('result_formatter', END)

  return workflow.compile({
    interruptBefore: ['resource_provisioner'],  // HITL pause (Story 2.1)
    checkpointer: new MemorySaver(),
  })
}
