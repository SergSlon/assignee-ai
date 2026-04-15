// Resource Plugins
export {
  defaultPluginRegistry,
  PluginRegistry,
  collectCompanionResources,
  lambdaRuntimes,
} from "../resource-plugins/index.js";

// Pattern Templates (Story 8.1)
export {
  defaultPatternRegistry,
  PatternRegistry,
  PatternId,
  // Item 1 (2026-04-09) + Item 3c (2026-04-10): patterns are exported
  // at the top-level barrel so the CLI test-harness + smoke-trace
  // suites can import them by name instead of reaching into an
  // internal module path. Every first-class compound is listed here
  // so future matrix/smoke expansion doesn't need a re-export step.
  vpcNetworkingPattern,
  vpcPublicOnlyPattern,
  staticWebsitePattern,
  lambdaWithExecRolePattern,
  efsWithVpcPattern,
  scheduledLambdaPattern,
  serverlessApiPattern,
  messageProcessingPattern,
  containerServicePattern,
  threeTierWebPattern,
} from "../pattern-templates/index.js";
export type {
  ArchitecturePattern,
  ResourceSpec,
  ResourceResult,
} from "../pattern-templates/types.js";
export type {
  ResourcePlugin,
  ResourceField,
  FieldQuestion,
  FetcherContext,
  QuestionType,
  ShowIfCondition,
  OptionMetadata,
  CfnOutput,
} from "../resource-plugins/types.js";
export { QuestionTypeName } from "../resource-plugins/types.js";
export type {
  CollectCompanionOptions,
  PlannedResource,
} from "../resource-plugins/companion-resources.js";
