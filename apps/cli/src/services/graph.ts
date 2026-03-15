import { StateGraph, START, END, Annotation, MemorySaver } from '@langchain/langgraph'
import { type GraphState, ExecutionMode, type ExecutionModeType, ExecutionStatus, type ExecutionStatusType, PreflightMode, type PreflightModeType } from '@assignee/core'
import type { StructuredTool } from '@langchain/core/tools'
import { GraphNode } from '../constants/graph.js'

// Convert Zod schema fields to LangGraph reducers to create the true State Annotation
// Defaults match the GraphStateSchema defaults in @assignee/core
export const graphAnnotation = Annotation.Root({
  userIntent:           Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  runId:                Annotation<string>({ reducer: (_, b) => b, default: () => crypto.randomUUID() }),
  executionMode:        Annotation<ExecutionModeType>({ reducer: (_, b) => b, default: () => ExecutionMode.APPLY }),
  resourceType:         Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  resourceSchema:       Annotation<Record<string, unknown> | undefined>({ reducer: (_, b) => b }),
  desiredState:         Annotation<Record<string, unknown> | undefined>({ reducer: (_, b) => b }),
  estimatedMonthlyCost: Annotation<string | undefined>({ reducer: (_, b) => b }),
  preflightPassed:      Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  preflightErrors:      Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  preflightMode:        Annotation<PreflightModeType>({ reducer: (_, b) => b, default: () => PreflightMode.LOCAL }),
  requestToken:         Annotation<string | undefined>({ reducer: (_, b) => b }),
  resourceArn:          Annotation<string | undefined>({ reducer: (_, b) => b }),
  executionStatus:      Annotation<ExecutionStatusType>({ reducer: (_, b) => b, default: () => ExecutionStatus.PENDING }),
  errorMessage:         Annotation<string | undefined>({ reducer: (_, b) => b }),
  startedAt:            Annotation<number | undefined>({ reducer: (_, b) => b }),
  messages:             Annotation<unknown[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
})

export type AgentState = typeof graphAnnotation.State

// Node signature — ALL nodes must match this LangGraph Runnable contract
type NodeFn = (state: AgentState, tools?: StructuredTool[]) => Promise<Partial<AgentState>>

import { intentParserNode } from '../nodes/intent-parser.js'
import { schemaFetcherNode } from '../nodes/schema-fetcher.js'

// All node stubs — return empty partial (LangGraph merges into state)
export const planGeneratorStub: NodeFn  = async () => ({})
export const preflightGuardStub: NodeFn = async () => ({ preflightPassed: true })
export const humanApprovalStub: NodeFn  = async () => ({})
export const resourceProvisionerStub: NodeFn = async () => ({})
export const statusPollerStub: NodeFn   = async () => ({ executionStatus: ExecutionStatus.SUCCESS })
export const resultFormatterStub: NodeFn = async () => ({})

// Conditional routing for preflight_guard
function routePreflightGuard(state: AgentState): typeof GraphNode.HUMAN_APPROVAL | typeof GraphNode.RESULT_FORMATTER {
  return state.preflightPassed ? GraphNode.HUMAN_APPROVAL : GraphNode.RESULT_FORMATTER
}

// Conditional routing for status_poller (self-loop — see Story 2.3)
function routeStatusPoller(state: AgentState): typeof GraphNode.STATUS_POLLER | typeof GraphNode.RESULT_FORMATTER {
  return state.executionStatus === ExecutionStatus.IN_PROGRESS ? GraphNode.STATUS_POLLER : GraphNode.RESULT_FORMATTER
}

export function createGraph(tools: StructuredTool[] = []) {
  const workflow = new StateGraph(graphAnnotation)
    .addNode(GraphNode.INTENT_PARSER,       (state) => intentParserNode(state))
    .addNode(GraphNode.SCHEMA_FETCHER,      (state) => schemaFetcherNode(state, tools))
    .addNode(GraphNode.PLAN_GENERATOR,      (state) => planGeneratorStub(state, tools))
    .addNode(GraphNode.PREFLIGHT_GUARD,     (state) => preflightGuardStub(state, tools))
    .addNode(GraphNode.HUMAN_APPROVAL,      (state) => humanApprovalStub(state, tools))
    .addNode(GraphNode.RESOURCE_PROVISIONER,(state) => resourceProvisionerStub(state, tools))
    .addNode(GraphNode.STATUS_POLLER,       (state) => statusPollerStub(state, tools))
    .addNode(GraphNode.RESULT_FORMATTER,    (state) => resultFormatterStub(state, tools))
    .addEdge(START, GraphNode.INTENT_PARSER)
    .addEdge(GraphNode.INTENT_PARSER, GraphNode.SCHEMA_FETCHER)
    .addEdge(GraphNode.SCHEMA_FETCHER, GraphNode.PLAN_GENERATOR)
    .addEdge(GraphNode.PLAN_GENERATOR, GraphNode.PREFLIGHT_GUARD)
    .addConditionalEdges(GraphNode.PREFLIGHT_GUARD, routePreflightGuard, {
      [GraphNode.HUMAN_APPROVAL]:    GraphNode.HUMAN_APPROVAL,
      [GraphNode.RESULT_FORMATTER]:  GraphNode.RESULT_FORMATTER,
    })
    .addEdge(GraphNode.HUMAN_APPROVAL, GraphNode.RESOURCE_PROVISIONER)
    .addEdge(GraphNode.RESOURCE_PROVISIONER, GraphNode.STATUS_POLLER)
    // Self-loop: poller node routes to itself when IN_PROGRESS (Story 2.3)
    .addConditionalEdges(GraphNode.STATUS_POLLER, routeStatusPoller, {
      [GraphNode.STATUS_POLLER]:    GraphNode.STATUS_POLLER,
      [GraphNode.RESULT_FORMATTER]: GraphNode.RESULT_FORMATTER,
    })
    .addEdge(GraphNode.RESULT_FORMATTER, END)

  return workflow.compile({
    interruptBefore: [GraphNode.RESOURCE_PROVISIONER],  // HITL pause (Story 2.1)
    checkpointer: new MemorySaver(),
  })
}
