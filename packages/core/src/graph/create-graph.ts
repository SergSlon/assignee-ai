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
import type { CheckpointerPort } from "../ports/checkpoint-port.js";
import type { TelemetryPort } from "../ports/telemetry-port.js";
import { emitFiltered } from "../ports/telemetry-port.js";
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
import { tryAssigneeCredentials } from "../config/aws-credentials.js";
import { AWS_REGION } from "../config/constants/aws.js";
import { EnvVar } from "../constants/env-vars.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";
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
  /**
   * W4-01 (Epic 100 Round 3): optional LangGraph-compatible saver.
   * Defaults to a fresh MemorySaver (in-memory). Epic 102 will supply
   * a Postgres/DDB saver.
   */
  checkpointSaver?: InstanceType<typeof MemorySaver>;
  /**
   * W4-01: optional plan-checkpoint port (PlanCheckpoint read/write,
   * distinct from the LangGraph HITL saver above).
   */
  checkpointerPort?: CheckpointerPort;
  /**
   * W4-05 (Epic 100 Round 3): optional TelemetryPort adapter.
   * When provided AND ASSIGNEE_TELEMETRY_ADAPTER is set (L1-F52 opt-in),
   * each graph node emits entry + exit TelemetryEvents. HUMAN_APPROVAL
   * is excluded. Absent -> no-op (telemetry off by default).
   */
  telemetryAdapter?: TelemetryPort;
  /**
   * MASTER-009: optional ConfigPort. SaaS callers can supply a
   * tenant-scoped configuration adapter; CLI callers may omit and
   * the factory will fall back to a fresh `ProcessEnvConfigAdapter`.
   */
  config?: ConfigPort;
}

// W4-05 telemetry node wrapper
async function withTelemetry<S extends { runId: string }, R>(
  nodeId: string,
  adapter: TelemetryPort | undefined,
  fn: (state: S) => Promise<R> | R,
  state: S,
): Promise<R> {
  void emitFiltered(adapter, {
    event_name: `${nodeId}.entry`,
    timestamp: new Date().toISOString(),
    node_id: nodeId,
    tenant_id: "local",
    extras: { node: nodeId, nodeEntry: true, runId: state.runId },
  });
  try {
    const result = await fn(state);
    void emitFiltered(adapter, {
      event_name: `${nodeId}.exit`,
      timestamp: new Date().toISOString(),
      node_id: nodeId,
      tenant_id: "local",
      extras: {
        node: nodeId,
        nodeExit: true,
        result: "success",
        runId: state.runId,
      },
    });
    return result;
  } catch (err) {
    const errorClass =
      err instanceof Error ? err.constructor.name : "UnknownError";
    void emitFiltered(adapter, {
      event_name: `${nodeId}.exit`,
      timestamp: new Date().toISOString(),
      node_id: nodeId,
      tenant_id: "local",
      extras: {
        node: nodeId,
        nodeExit: true,
        result: "failure",
        errorClass,
        runId: state.runId,
      },
    });
    throw err;
  }
}

export function createGraph(
  tools: StructuredTool[] = [],
  options: CreateGraphOptions = {},
) {
  // MASTER-009: ConfigPort threading — tenant-scoped lookup when supplied,
  // else fall back to a fresh process-env adapter for legacy single-tenant
  // CLI / test behaviour.
  const effectiveConfig = options.config ?? new ProcessEnvConfigAdapter();

  // R10a-03 follow-up (per `feedback_lazy_credential_resolution_in_mcp`):
  // graph construction MUST use lazy credential resolution. The earlier
  // `operatorCredentials()` returned empty-string fallbacks + a one-time
  // stderr warning when env vars were missing — graph-integration tests
  // rely on that lenient shape (they construct graphs without setting
  // env vars and stub the SDK clients). R10a-03 swapped in
  // `requireAssigneeCredentials` which throws, breaking 50 tests.
  // Restore lenient semantics here; downstream SDK calls fail fast on
  // actual use, which is the correct blast-radius for missing creds —
  // not at graph construction time.
  const tryCreds = tryAssigneeCredentials("operator", effectiveConfig);
  const opCreds = {
    accessKeyId: tryCreds?.accessKeyId ?? "",
    secretAccessKey: tryCreds?.secretAccessKey ?? "",
    ...(tryCreds?.sessionToken ? { sessionToken: tryCreds.sessionToken } : {}),
    region: AWS_REGION,
  };
  const cloudClient = createCloudControlClient(opCreds);

  // Story 9.7: Attach recording middleware to CloudControl client when recording enabled
  if (options.recorder && isRecordingEnabled(effectiveConfig)) {
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
        effectiveConfig.get(EnvVar.ASSIGNEE_LLM_DEFAULT) ??
        // Back-compat: read legacy ASSIGNEE_MODEL env var (deprecated alias).
        effectiveConfig.get("ASSIGNEE_MODEL"),
      guardrailId: effectiveConfig.get(EnvVar.BEDROCK_GUARDRAIL_ID),
      guardrailVersion: effectiveConfig.get(EnvVar.BEDROCK_GUARDRAIL_VERSION),
    });

  const intentParserNode = createIntentParserNode({ llmClient: llmAdapter });
  const planGeneratorNode = createPlanGeneratorNode({ llmClient: llmAdapter });
  const adviceGeneratorNode = createAdviceGeneratorNode({
    llmClient: llmAdapter,
  });

  // W4-05: telemetry adapter (undefined = no-op via emitFiltered).
  const tel = options.telemetryAdapter;

  const workflow = new StateGraph(graphAnnotation)
    .addNode(GraphNode.INTENT_PARSER, (state) =>
      withTelemetry(GraphNode.INTENT_PARSER, tel, intentParserNode, state),
    )
    .addNode(GraphNode.SCHEMA_FETCHER, (state) =>
      withTelemetry(GraphNode.SCHEMA_FETCHER, tel, schemaFetcherNode, state),
    )
    .addNode(GraphNode.OPTION_ELICITOR, (state) =>
      withTelemetry(
        GraphNode.OPTION_ELICITOR,
        tel,
        (s) => optionElicitorNode(s, tools, llmAdapter),
        state,
      ),
    )
    .addNode(GraphNode.COMPOUND_DISPATCHER, (state) =>
      withTelemetry(
        GraphNode.COMPOUND_DISPATCHER,
        tel,
        compoundDispatcherNode,
        state,
      ),
    )
    .addNode(GraphNode.PLAN_GENERATOR, (state) =>
      withTelemetry(GraphNode.PLAN_GENERATOR, tel, planGeneratorNode, state),
    )
    .addNode(GraphNode.VALIDATE_DESIRED_STATE, (state) =>
      withTelemetry(
        GraphNode.VALIDATE_DESIRED_STATE,
        tel,
        validateDesiredStateNode,
        state,
      ),
    )
    .addNode(GraphNode.ADVICE_GENERATOR, (state) =>
      withTelemetry(
        GraphNode.ADVICE_GENERATOR,
        tel,
        (s) => adviceGeneratorNode(s, tools),
        state,
      ),
    )
    .addNode(GraphNode.PREFLIGHT_GUARD, (state) =>
      withTelemetry(
        GraphNode.PREFLIGHT_GUARD,
        tel,
        (s) => preflightGuardNode(s, tools),
        state,
      ),
    )
    // HUMAN_APPROVAL excluded from telemetry (blocks on user input -- W4-05 AC).
    .addNode(GraphNode.HUMAN_APPROVAL, (state) => humanApprovalNode(state))
    .addNode(GraphNode.RESOURCE_PROVISIONER, (state) =>
      withTelemetry(
        GraphNode.RESOURCE_PROVISIONER,
        tel,
        (s) => resourceProvisionerNode(s, provisioner),
        state,
      ),
    )
    .addNode(GraphNode.STATUS_POLLER, (state) =>
      withTelemetry(
        GraphNode.STATUS_POLLER,
        tel,
        (s) => statusPollerNode(s, provisioner),
        state,
      ),
    )
    .addNode(GraphNode.BP_EVALUATOR, (state) =>
      withTelemetry(
        GraphNode.BP_EVALUATOR,
        tel,
        (s) => bpEvaluatorNode(s, tools),
        state,
      ),
    )
    .addNode(GraphNode.FIX_APPLICATOR, (state) =>
      withTelemetry(GraphNode.FIX_APPLICATOR, tel, fixApplicatorNode, state),
    )
    .addNode(GraphNode.RESULT_FORMATTER, (state) =>
      withTelemetry(
        GraphNode.RESULT_FORMATTER,
        tel,
        (s) => resultFormatterNode(s, tools),
        state,
      ),
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

  // W4-01: accept an optional LangGraph-compatible saver; fall back to MemorySaver.
  const lgCheckpointer = options.checkpointSaver ?? new MemorySaver();

  return workflow.compile({
    interruptBefore: [GraphNode.RESOURCE_PROVISIONER],
    checkpointer: lgCheckpointer,
  });
}
