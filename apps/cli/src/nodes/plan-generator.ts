/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/graph/nodes/plan-generator.js`
 * (Story 50-4 Wave 5 Pass H).
 */
export {
  createPlanGeneratorNode,
  redactResourceId,
  safeCloneDesiredState,
  applyToCfnTransforms,
  assembleS3Composites,
  assembleEc2Storage,
  isTemplatePlaceholder,
  collectPluginPlaceholders,
  stripPlaceholderArns,
  defaultAzLookup,
  resolveCompoundMarkers,
  __resetAzCacheForTests,
  type AzLookup,
} from "@assignee/core/graph/nodes/plan-generator.js";
