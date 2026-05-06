/**
 * Graph-node name constants shared between the agent graph (in core) and
 * CLI/MCP callers that need to refer to a specific node by string.
 *
 * Story 50-4 Wave 5 Pass I: moved here from `apps/cli/src/constants/graph.ts`
 * so the in-core `createGraph` + routing functions can reference node names
 * without a back-import into the CLI.
 */
export const GraphNode = {
  INTENT_PARSER: "intent_parser",
  SCHEMA_FETCHER: "schema_fetcher",
  OPTION_ELICITOR: "option_elicitor",
  COMPOUND_DISPATCHER: "compound_dispatcher",
  PLAN_GENERATOR: "plan_generator",
  VALIDATE_DESIRED_STATE: "validate_desired_state",
  ADVICE_GENERATOR: "advice_generator",
  PREFLIGHT_GUARD: "preflight_guard",
  HUMAN_APPROVAL: "human_approval",
  RESOURCE_PROVISIONER: "resource_provisioner",
  STATUS_POLLER: "status_poller",
  BP_EVALUATOR: "bp_evaluator",
  FIX_APPLICATOR: "fix_applicator",
  RESULT_FORMATTER: "result_formatter",
  /**
   * Query handler node — dispatched when intentKind="query".
   * Resolves the user's read-only question against managed resources
   * and populates queryResult for the result-formatter to render.
   * Bypasses the heavy creation pipeline (zero AWS writes).
   */
  QUERY_HANDLER: "query_handler",
} as const;

export type GraphNodeType = (typeof GraphNode)[keyof typeof GraphNode];
