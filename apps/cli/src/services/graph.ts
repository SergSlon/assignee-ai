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
import { preflightGuardNode } from "../nodes/preflight-guard.js";
import { humanApprovalNode } from "../nodes/human-approval.js";
import { resourceProvisionerNode } from "../nodes/resource-provisioner.js";
import { statusPollerNode } from "../nodes/status-poller.js";
import { resultFormatterNode } from "../nodes/result-formatter.js";
import { bpEvaluatorNode } from "../nodes/bp-evaluator.js";
import { createCloudControlClient } from "./cloudcontrol-client.js";
import { CloudControlAdapter } from "./cloudcontrol-adapter.js";
import { SDKFallbackDispatcher } from "./sdk-fallback-dispatcher.js";
import { BedrockLlmAdapter } from "./bedrock-llm-adapter.js";
import { BEDROCK_MODEL_ID, AWS_REGION } from "../config/constants.js";

export function createGraph(tools: StructuredTool[] = []) {
  const cloudClient = createCloudControlClient({
    accessKeyId: process.env["MCP_AWS_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: process.env["MCP_AWS_SECRET_ACCESS_KEY"] ?? "",
    region: process.env["AWS_REGION"] ?? "",
  });
  const provisioner = new CloudControlAdapter(cloudClient);

  let fallbackDispatcher: SDKFallbackDispatcher | undefined;
  try {
    fallbackDispatcher = new SDKFallbackDispatcher({
      accessKeyId: process.env["MCP_AWS_ACCESS_KEY_ID"] ?? "",
      secretAccessKey: process.env["MCP_AWS_SECRET_ACCESS_KEY"] ?? "",
      region: process.env["AWS_REGION"] ?? "",
    });
  } catch {
    // SDK fallback unavailable (missing credentials) — graph works without it
  }

  const llmAdapter = new BedrockLlmAdapter({
    modelId: BEDROCK_MODEL_ID,
    region: AWS_REGION,
    guardrailId: process.env["BEDROCK_GUARDRAIL_ID"],
    guardrailVersion: process.env["BEDROCK_GUARDRAIL_VERSION"],
  });

  const intentParserNode = createIntentParserNode({ llmClient: llmAdapter });
  const planGeneratorNode = createPlanGeneratorNode({ llmClient: llmAdapter });

  const workflow = new StateGraph(graphAnnotation)
    .addNode(GraphNode.INTENT_PARSER, (state) => intentParserNode(state))
    .addNode(GraphNode.SCHEMA_FETCHER, (state) =>
      schemaFetcherNode(state, tools),
    )
    .addNode(GraphNode.OPTION_ELICITOR, (state) =>
      optionElicitorNode(state, tools, llmAdapter),
    )
    .addNode(GraphNode.COMPOUND_DISPATCHER, (state) =>
      compoundDispatcherNode(state),
    )
    .addNode(GraphNode.PLAN_GENERATOR, (state) => planGeneratorNode(state))
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
    .addNode(GraphNode.BP_EVALUATOR, (state) => bpEvaluatorNode(state))
    .addNode(GraphNode.RESULT_FORMATTER, (state) => resultFormatterNode(state))
    .addConditionalEdges(START, routeCheckpointEntry, {
      [GraphNode.INTENT_PARSER]: GraphNode.INTENT_PARSER,
      [GraphNode.HUMAN_APPROVAL]: GraphNode.HUMAN_APPROVAL,
    })
    .addEdge(GraphNode.INTENT_PARSER, GraphNode.SCHEMA_FETCHER)
    .addEdge(GraphNode.SCHEMA_FETCHER, GraphNode.OPTION_ELICITOR)
    .addEdge(GraphNode.OPTION_ELICITOR, GraphNode.COMPOUND_DISPATCHER)
    .addEdge(GraphNode.COMPOUND_DISPATCHER, GraphNode.PLAN_GENERATOR)
    .addEdge(GraphNode.PLAN_GENERATOR, GraphNode.BP_EVALUATOR)
    .addEdge(GraphNode.BP_EVALUATOR, GraphNode.PREFLIGHT_GUARD)
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
