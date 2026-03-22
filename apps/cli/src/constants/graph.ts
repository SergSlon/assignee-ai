export const GraphNode = {
  INTENT_PARSER: "intent_parser",
  SCHEMA_FETCHER: "schema_fetcher",
  OPTION_ELICITOR: "option_elicitor",
  COMPOUND_DISPATCHER: "compound_dispatcher",
  PLAN_GENERATOR: "plan_generator",
  PREFLIGHT_GUARD: "preflight_guard",
  HUMAN_APPROVAL: "human_approval",
  RESOURCE_PROVISIONER: "resource_provisioner",
  STATUS_POLLER: "status_poller",
  BP_EVALUATOR: "bp_evaluator",
  RESULT_FORMATTER: "result_formatter",
} as const;

export type GraphNodeType = (typeof GraphNode)[keyof typeof GraphNode];
