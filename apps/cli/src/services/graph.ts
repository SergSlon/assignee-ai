/**
 * LangGraph agent graph — wiring only.
 * State definition lives in graph-state.ts, routing in graph-routing.ts.
 */

import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import type { StructuredTool } from "@langchain/core/tools";
import { GraphNode } from "../constants/graph.js";
import { graphAnnotation } from "./graph-state.js";
import {
  routeCheckpointEntry,
  routePreflightGuard,
  routeResourceProvisioner,
  routeStatusPoller,
  routeResultFormatter,
} from "./graph-routing.js";

// Re-export for consumers that import AgentState from graph.ts
export { graphAnnotation } from "./graph-state.js";
export type { AgentState } from "./graph-state.js";

import { createIntentParserNode } from "../nodes/intent-parser.js";
import { schemaFetcherNode } from "../nodes/schema-fetcher.js";
import { optionElicitorNode } from "../nodes/option-elicitor.js";
import { compoundDispatcherNode } from "../nodes/compound-dispatcher.js";
import { createPlanGeneratorNode } from "../nodes/plan-generator.js";
import { createAdviceGeneratorNode } from "../nodes/advice-generator.js";
import { preflightGuardNode } from "../nodes/preflight-guard.js";
import { humanApprovalNode } from "../nodes/human-approval.js";
import { resourceProvisionerNode } from "../nodes/resource-provisioner.js";
import { statusPollerNode } from "../nodes/status-poller.js";
import { resultFormatterNode } from "../nodes/result-formatter.js";
import { bpEvaluatorNode } from "../nodes/bp-evaluator.js";
import { fixApplicatorNode } from "../nodes/fix-applicator.js";
import { createCloudControlClient } from "./cloudcontrol-client.js";
import { CloudControlAdapter } from "./cloudcontrol-adapter.js";
import { SDKFallbackDispatcher } from "./sdk-fallback-dispatcher.js";
import { LlmAdapter, RoutingLlmAdapter } from "./llm-adapter.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import { EnvVar } from "../constants/env-vars.js";
import type { LlmPort, ResolvedGlobalConfig } from "@assignee/core";
import {
  isRecordingEnabled,
  addRecordingMiddleware,
  type RecordingInterceptor,
} from "../utils/recorder.js";

export interface CreateGraphOptions {
  /** Optional pre-built LLM adapter (used for recording wrapper). */
  llmClient?: LlmPort;
  /** Optional recording interceptor for SDK middleware. */
  recorder?: RecordingInterceptor;
  /** Resolved global config — used for per-node LLM routing (Story 44.1). */
  resolvedConfig?: ResolvedGlobalConfig;
}

export function createGraph(
  tools: StructuredTool[] = [],
  options: CreateGraphOptions = {},
) {
  const opCreds = operatorCredentials();
  const cloudClient = createCloudControlClient(opCreds);

  // Story 9.7: Attach recording middleware to CloudControl client when recording enabled
  if (options.recorder && isRecordingEnabled()) {
    addRecordingMiddleware(cloudClient, options.recorder, "CloudControl");
  }

  const provisioner = new CloudControlAdapter(cloudClient);

  // A10 (2026-04-09): SDKFallbackDispatcher is now a pure in-memory
  // redirect classifier — it no longer needs credentials after the
  // SNS Subscription promotion removed the last SDK write path. The
  // try/catch that used to tolerate missing credentials is therefore
  // dead, but we keep the dispatcher as an always-constructed gate
  // so resource_provisioner can check isRedirect() for the two
  // remaining CCAPI-gap types (Lambda::Permission, ElastiCache::RG).
  const fallbackDispatcher: SDKFallbackDispatcher = new SDKFallbackDispatcher();

  // Story 44.1: when resolvedConfig.llm has entries, use RoutingLlmAdapter
  // so each callsite (intent_parser, plan_generator, etc.) can target a
  // different provider/model. Falls back to plain LlmAdapter when no
  // routing config is present — fully backward compatible.
  const llmBaseConfig = {
    guardrailId: process.env[EnvVar.BEDROCK_GUARDRAIL_ID],
    guardrailVersion: process.env[EnvVar.BEDROCK_GUARDRAIL_VERSION],
  };
  const llmRouting = options.resolvedConfig?.llm;
  const llmAdapter: LlmPort =
    options.llmClient ??
    (llmRouting && Object.keys(llmRouting).length > 0
      ? new RoutingLlmAdapter(llmRouting, llmBaseConfig)
      : new LlmAdapter({
          modelString: process.env[EnvVar.ASSIGNEE_MODEL],
          ...llmBaseConfig,
        }));

  const intentParserNode = createIntentParserNode({ llmClient: llmAdapter });
  const planGeneratorNode = createPlanGeneratorNode({ llmClient: llmAdapter });
  const adviceGeneratorNode = createAdviceGeneratorNode({
    llmClient: llmAdapter,
  });

  const workflow = new StateGraph(graphAnnotation)
    .addNode(GraphNode.INTENT_PARSER, (state) => intentParserNode(state))
    .addNode(GraphNode.SCHEMA_FETCHER, (state) => schemaFetcherNode(state))
    .addNode(GraphNode.OPTION_ELICITOR, (state) =>
      optionElicitorNode(state, tools, llmAdapter),
    )
    .addNode(GraphNode.COMPOUND_DISPATCHER, (state) =>
      compoundDispatcherNode(state),
    )
    .addNode(GraphNode.PLAN_GENERATOR, (state) => planGeneratorNode(state))
    .addNode(GraphNode.ADVICE_GENERATOR, (state) =>
      adviceGeneratorNode(state, tools),
    )
    .addNode(GraphNode.PREFLIGHT_GUARD, (state) =>
      preflightGuardNode(state, tools),
    )
    .addNode(GraphNode.HUMAN_APPROVAL, (state) => humanApprovalNode(state))
    .addNode(GraphNode.RESOURCE_PROVISIONER, (state) =>
      resourceProvisionerNode(state, provisioner, fallbackDispatcher),
    )
    .addNode(GraphNode.STATUS_POLLER, (state) =>
      statusPollerNode(state, provisioner),
    )
    .addNode(GraphNode.BP_EVALUATOR, (state) => bpEvaluatorNode(state, tools))
    .addNode(GraphNode.FIX_APPLICATOR, (state) => fixApplicatorNode(state))
    .addNode(GraphNode.RESULT_FORMATTER, (state) =>
      resultFormatterNode(state, tools),
    )
    .addConditionalEdges(START, routeCheckpointEntry, {
      [GraphNode.INTENT_PARSER]: GraphNode.INTENT_PARSER,
      [GraphNode.HUMAN_APPROVAL]: GraphNode.HUMAN_APPROVAL,
    })
    .addEdge(GraphNode.INTENT_PARSER, GraphNode.SCHEMA_FETCHER)
    .addEdge(GraphNode.SCHEMA_FETCHER, GraphNode.OPTION_ELICITOR)
    .addEdge(GraphNode.OPTION_ELICITOR, GraphNode.COMPOUND_DISPATCHER)
    .addEdge(GraphNode.COMPOUND_DISPATCHER, GraphNode.PLAN_GENERATOR)
    .addEdge(GraphNode.PLAN_GENERATOR, GraphNode.ADVICE_GENERATOR)
    .addEdge(GraphNode.ADVICE_GENERATOR, GraphNode.BP_EVALUATOR)
    .addEdge(GraphNode.BP_EVALUATOR, GraphNode.FIX_APPLICATOR)
    .addEdge(GraphNode.FIX_APPLICATOR, GraphNode.PREFLIGHT_GUARD)
    .addConditionalEdges(GraphNode.PREFLIGHT_GUARD, routePreflightGuard, {
      [GraphNode.HUMAN_APPROVAL]: GraphNode.HUMAN_APPROVAL,
      [GraphNode.RESULT_FORMATTER]: GraphNode.RESULT_FORMATTER,
      [GraphNode.RESOURCE_PROVISIONER]: GraphNode.RESOURCE_PROVISIONER,
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
    .addConditionalEdges(GraphNode.STATUS_POLLER, routeStatusPoller, {
      [GraphNode.STATUS_POLLER]: GraphNode.STATUS_POLLER,
      [GraphNode.RESULT_FORMATTER]: GraphNode.RESULT_FORMATTER,
    })
    .addConditionalEdges(GraphNode.RESULT_FORMATTER, routeResultFormatter, {
      [GraphNode.PLAN_GENERATOR]: GraphNode.PLAN_GENERATOR,
      [END]: END,
    });

  return workflow.compile({
    interruptBefore: [GraphNode.RESOURCE_PROVISIONER],
    checkpointer: new MemorySaver(),
  });
}
