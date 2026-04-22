/**
 * LangGraph agent graph — wiring only.
 *
 * State definition lives in graph-state.ts, routing in graph-routing.ts.
 *
 * Story 50-4 Wave 5 Pass I: lifted from `apps/cli/src/services/graph.ts`
 * into `@assignee/core/graph` so the MCP server can construct the agent
 * graph without a runtime dependency on `apps/cli`. All 13 node
 * implementations were already lifted in Passes D/E/E.2/H; this pass
 * lifts the final wiring + routing + factory + the MCP-server rewire
 * (removing `"assignee": "workspace:*"` from mcp-server's package.json).
 */

import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import type { StructuredTool } from "@langchain/core/tools";
import { GraphNode } from "../constants/graph-node.js";
import { graphAnnotation } from "./graph-state.js";
import {
  routeCheckpointEntry,
  routePreflightGuard,
  routeResourceProvisioner,
  routeStatusPoller,
  routeResultFormatter,
  routeValidateDesiredState,
} from "./graph-routing.js";

import { createIntentParserNode } from "./nodes/intent-parser.js";
import { schemaFetcherNode } from "./nodes/schema-fetcher.js";
import { optionElicitorNode } from "./nodes/option-elicitor.js";
import { compoundDispatcherNode } from "./nodes/compound-dispatcher.js";
import { createPlanGeneratorNode } from "./nodes/plan-generator.js";
import { validateDesiredStateNode } from "./nodes/validate-desired-state.js";
import { createAdviceGeneratorNode } from "./nodes/advice-generator.js";
import { preflightGuardNode } from "./nodes/preflight-guard.js";
import { humanApprovalNode } from "./nodes/human-approval.js";
import { resourceProvisionerNode } from "./nodes/resource-provisioner.js";
import { statusPollerNode } from "./nodes/status-poller.js";
import { resultFormatterNode } from "./nodes/result-formatter.js";
import { bpEvaluatorNode } from "./nodes/bp-evaluator.js";
import { fixApplicatorNode } from "./nodes/fix-applicator/orchestrator.js";
import { createCloudControlClient } from "../services/cloudcontrol-client.js";
import { CloudControlAdapter } from "../aws/cloudcontrol-adapter.js";
import { LlmAdapter } from "../llm/adapter.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import { EnvVar } from "../constants/env-vars.js";
import type { LlmPort } from "../index.js";
import {
  isRecordingEnabled,
  addRecordingMiddleware,
  type RecordingInterceptor,
} from "../utils/recorder/index.js";

export interface CreateGraphOptions {
  /** Optional pre-built LLM adapter (used for recording wrapper). */
  llmClient?: LlmPort;
  /** Optional recording interceptor for SDK middleware. */
  recorder?: RecordingInterceptor;
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

  // Story 50-7: SDKFallbackDispatcher deleted (A10 removed every SDK
  // write path; the redirect classifier moved inline into
  // resource-provisioner.ts). Story 50-7 also dropped the
  // RoutingLlmAdapter branch — no in-repo YAML used the `llm:` key.
  const llmAdapter: LlmPort =
    options.llmClient ??
    new LlmAdapter({
      modelString:
        process.env[EnvVar.ASSIGNEE_LLM_DEFAULT] ??
        process.env[EnvVar.ASSIGNEE_MODEL],
      guardrailId: process.env[EnvVar.BEDROCK_GUARDRAIL_ID],
      guardrailVersion: process.env[EnvVar.BEDROCK_GUARDRAIL_VERSION],
    });

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
    .addNode(GraphNode.VALIDATE_DESIRED_STATE, (state) =>
      validateDesiredStateNode(state),
    )
    .addNode(GraphNode.ADVICE_GENERATOR, (state) =>
      adviceGeneratorNode(state, tools),
    )
    .addNode(GraphNode.PREFLIGHT_GUARD, (state) =>
      preflightGuardNode(state, tools),
    )
    .addNode(GraphNode.HUMAN_APPROVAL, (state) => humanApprovalNode(state))
    .addNode(GraphNode.RESOURCE_PROVISIONER, (state) =>
      resourceProvisionerNode(state, provisioner),
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
    // Epic 94 R1 (A-01): wire validateDesiredStateNode between
    // PLAN_GENERATOR and ADVICE_GENERATOR. Epic 92 u.c.1 shipped the node
    // + 28 tests but left this edge unconnected — every S3 bucket-name
    // rule (length, IPv4 shape, xn--, sthree-, -s3alias, adjacent dots,
    // charset) silently passed through to CloudControl at APPLY time
    // instead of failing fast at PLAN time with an actionable
    // `[ERROR] / [FIX]` triple. The conditional edge short-circuits to
    // RESULT_FORMATTER on validation failure so advice / BP / fix /
    // preflight don't burn tokens on a payload that cannot provision.
    .addEdge(GraphNode.PLAN_GENERATOR, GraphNode.VALIDATE_DESIRED_STATE)
    .addConditionalEdges(
      GraphNode.VALIDATE_DESIRED_STATE,
      routeValidateDesiredState,
      {
        [GraphNode.ADVICE_GENERATOR]: GraphNode.ADVICE_GENERATOR,
        [GraphNode.RESULT_FORMATTER]: GraphNode.RESULT_FORMATTER,
      },
    )
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
      // Retry path: CloudFront S3 origin DNS propagation failure
      [GraphNode.RESOURCE_PROVISIONER]: GraphNode.RESOURCE_PROVISIONER,
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
