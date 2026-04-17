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
  ADVICE_GENERATOR: "advice_generator",
  PREFLIGHT_GUARD: "preflight_guard",
  HUMAN_APPROVAL: "human_approval",
  RESOURCE_PROVISIONER: "resource_provisioner",
  STATUS_POLLER: "status_poller",
  BP_EVALUATOR: "bp_evaluator",
  FIX_APPLICATOR: "fix_applicator",
  RESULT_FORMATTER: "result_formatter",
} as const;

export type GraphNodeType = (typeof GraphNode)[keyof typeof GraphNode];
