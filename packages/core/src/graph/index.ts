/**
 * `@assignee/core/graph` barrel.
 *
 * Story 50-4 Wave 5 Pass I: `createGraph` and `graph-routing` now live in
 * `@assignee/core` alongside the 13 graph nodes + graph-state. The MCP
 * server imports `createGraph` from here directly, eliminating the
 * previous `apps/mcp-server → apps/cli` runtime dependency.
 */

export {
  graphAnnotation,
  type AgentState,
  type AppliedFix,
  type SecurityFinding,
} from "./graph-state.js";

// Routing functions (Story 50-4 Wave 5 Pass I).
export {
  routeCheckpointEntry,
  routePreflightGuard,
  routeResourceProvisioner,
  routeStatusPoller,
  routeResultFormatter,
} from "./graph-routing.js";

// createGraph factory (Story 50-4 Wave 5 Pass I).
export { createGraph, type CreateGraphOptions } from "./create-graph.js";

// All 13 graph-node implementations (Story 50-4 Wave 5 Passes D/E/E.2/H).
export {
  schemaFetcherNode,
  _resetSchemaService,
} from "./nodes/schema-fetcher.js";
export { humanApprovalNode } from "./nodes/human-approval.js";
export { statusPollerNode } from "./nodes/status-poller.js";
export { compoundDispatcherNode } from "./nodes/compound-dispatcher.js";
export { createIntentParserNode } from "./nodes/intent-parser.js";
export { bpEvaluatorNode, resetBPCache } from "./nodes/bp-evaluator.js";
export { isRetryableCloudFrontS3Error } from "./nodes/status-poller.js";
export { fixApplicatorNode } from "./nodes/fix-applicator/orchestrator.js";
export { resultFormatterNode } from "./nodes/result-formatter.js";
export { preflightGuardNode } from "./nodes/preflight-guard.js";
export { resourceProvisionerNode } from "./nodes/resource-provisioner.js";
export { createPlanGeneratorNode } from "./nodes/plan-generator.js";
export { optionElicitorNode } from "./nodes/option-elicitor.js";
export { createAdviceGeneratorNode } from "./nodes/advice-generator.js";

// Cost-optimizer (Story 58-it1-05): exported here so CLI shims
// `apps/cli/src/nodes/advice/cost-optimizer/{orchestrator,types}.ts` can
// consume the canonical implementation from `@assignee/core/graph` instead
// of the wildcard `@assignee/core/graph/nodes/*` path.
export { analyzeResource } from "./nodes/advice/cost-optimizer/orchestrator.js";
export {
  HOURS_PER_MONTH,
  parseHourly,
  buildRecommendation,
  type CostOptRecommendation,
  type OptimizationConfidence,
} from "./nodes/advice/cost-optimizer/types.js";
