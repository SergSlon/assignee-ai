import {
  StateGraph,
  START,
  END,
  Annotation,
  MemorySaver,
} from "@langchain/langgraph";
import {
  type GraphState,
  ExecutionMode,
  type ExecutionModeType,
  ExecutionStatus,
  type ExecutionStatusType,
  PreflightMode,
  type PreflightModeType,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { GraphNode } from "../constants/graph.js";

// Convert Zod schema fields to LangGraph reducers to create the true State Annotation
// Defaults match the GraphStateSchema defaults in @assignee/core
export const graphAnnotation = Annotation.Root({
  userIntent: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  runId: Annotation<string>({
    reducer: (_, b) => b,
    default: () => crypto.randomUUID(),
  }),
  executionMode: Annotation<ExecutionModeType>({
    reducer: (_, b) => b,
    default: () => ExecutionMode.APPLY,
  }),
  resourceType: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  resourceSchema: Annotation<Record<string, unknown> | undefined>({
    reducer: (_, b) => b,
  }),
  desiredState: Annotation<Record<string, unknown> | undefined>({
    reducer: (_, b) => b,
  }),
  estimatedMonthlyCost: Annotation<string | undefined>({
    reducer: (_, b) => b,
  }),
  preflightPassed: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  preflightErrors: Annotation<string[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),
  preflightMode: Annotation<PreflightModeType>({
    reducer: (_, b) => b,
    default: () => PreflightMode.LOCAL,
  }),
  requestToken: Annotation<string | undefined>({ reducer: (_, b) => b }),
  resourceArn: Annotation<string | undefined>({ reducer: (_, b) => b }),
  executionStatus: Annotation<ExecutionStatusType>({
    reducer: (_, b) => b,
    default: () => ExecutionStatus.PENDING,
  }),
  errorMessage: Annotation<string | undefined>({ reducer: (_, b) => b }),
  startedAt: Annotation<number | undefined>({ reducer: (_, b) => b }),
  messages: Annotation<unknown[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  elicitedOptions: Annotation<Record<string, unknown> | undefined>({
    reducer: (_, b) => b,
  }),
});

export type AgentState = typeof graphAnnotation.State;

// Node signature — ALL nodes must match this LangGraph Runnable contract
type NodeFn = (
  state: AgentState,
  tools?: StructuredTool[],
) => Promise<Partial<AgentState>>;

import { intentParserNode } from "../nodes/intent-parser.js";
import { schemaFetcherNode } from "../nodes/schema-fetcher.js";
import { optionElicitorNode } from "../nodes/option-elicitor.js";
import { planGeneratorNode } from "../nodes/plan-generator.js";
import { preflightGuardNode } from "../nodes/preflight-guard.js";
import { humanApprovalNode } from "../nodes/human-approval.js";
import { resourceProvisionerNode } from "../nodes/resource-provisioner.js";
import { statusPollerNode } from "../nodes/status-poller.js";
import { resultFormatterNode } from "../nodes/result-formatter.js";

// Conditional routing for preflight_guard:
// - plan mode  → skip HITL, render plan box via result_formatter
// - apply mode → HITL in human_approval, then pause at resource_provisioner interrupt
function routePreflightGuard(
  state: AgentState,
): typeof GraphNode.HUMAN_APPROVAL | typeof GraphNode.RESULT_FORMATTER {
  if (state.executionMode === ExecutionMode.PLAN || !state.preflightPassed) {
    return GraphNode.RESULT_FORMATTER;
  }
  return GraphNode.HUMAN_APPROVAL;
}

// Conditional routing for resource_provisioner:
// - IN_PROGRESS → status_poller (async poll)
// - FAILED      → result_formatter (state guard abort or provisioning error)
function routeResourceProvisioner(
  state: AgentState,
): typeof GraphNode.STATUS_POLLER | typeof GraphNode.RESULT_FORMATTER {
  return state.executionStatus === ExecutionStatus.IN_PROGRESS
    ? GraphNode.STATUS_POLLER
    : GraphNode.RESULT_FORMATTER;
}

// Conditional routing for status_poller (self-loop — see Story 2.3)
function routeStatusPoller(
  state: AgentState,
): typeof GraphNode.STATUS_POLLER | typeof GraphNode.RESULT_FORMATTER {
  return state.executionStatus === ExecutionStatus.IN_PROGRESS
    ? GraphNode.STATUS_POLLER
    : GraphNode.RESULT_FORMATTER;
}

export function createGraph(tools: StructuredTool[] = []) {
  const workflow = new StateGraph(graphAnnotation)
    .addNode(GraphNode.INTENT_PARSER, (state) => intentParserNode(state))
    .addNode(GraphNode.SCHEMA_FETCHER, (state) =>
      schemaFetcherNode(state, tools),
    )
    .addNode(GraphNode.OPTION_ELICITOR, (state) => optionElicitorNode(state))
    .addNode(GraphNode.PLAN_GENERATOR, (state) => planGeneratorNode(state))
    .addNode(GraphNode.PREFLIGHT_GUARD, (state) =>
      preflightGuardNode(state, tools),
    )
    .addNode(GraphNode.HUMAN_APPROVAL, (state) => humanApprovalNode(state))
    .addNode(GraphNode.RESOURCE_PROVISIONER, (state) =>
      resourceProvisionerNode(state),
    )
    .addNode(GraphNode.STATUS_POLLER, (state) => statusPollerNode(state))
    .addNode(GraphNode.RESULT_FORMATTER, (state) => resultFormatterNode(state))
    .addEdge(START, GraphNode.INTENT_PARSER)
    .addEdge(GraphNode.INTENT_PARSER, GraphNode.SCHEMA_FETCHER)
    .addEdge(GraphNode.SCHEMA_FETCHER, GraphNode.OPTION_ELICITOR)
    .addEdge(GraphNode.OPTION_ELICITOR, GraphNode.PLAN_GENERATOR)
    .addEdge(GraphNode.PLAN_GENERATOR, GraphNode.PREFLIGHT_GUARD)
    .addConditionalEdges(GraphNode.PREFLIGHT_GUARD, routePreflightGuard, {
      [GraphNode.HUMAN_APPROVAL]: GraphNode.HUMAN_APPROVAL,
      [GraphNode.RESULT_FORMATTER]: GraphNode.RESULT_FORMATTER,
    })
    .addEdge(GraphNode.HUMAN_APPROVAL, GraphNode.RESOURCE_PROVISIONER)
    .addConditionalEdges(
      GraphNode.RESOURCE_PROVISIONER,
      routeResourceProvisioner,
      {
        [GraphNode.STATUS_POLLER]: GraphNode.STATUS_POLLER,
        [GraphNode.RESULT_FORMATTER]: GraphNode.RESULT_FORMATTER,
      },
    )
    // Self-loop: poller node routes to itself when IN_PROGRESS (Story 2.3)
    .addConditionalEdges(GraphNode.STATUS_POLLER, routeStatusPoller, {
      [GraphNode.STATUS_POLLER]: GraphNode.STATUS_POLLER,
      [GraphNode.RESULT_FORMATTER]: GraphNode.RESULT_FORMATTER,
    })
    .addEdge(GraphNode.RESULT_FORMATTER, END);

  return workflow.compile({
    interruptBefore: [GraphNode.RESOURCE_PROVISIONER], // HITL pause (Story 2.1)
    checkpointer: new MemorySaver(),
  });
}
