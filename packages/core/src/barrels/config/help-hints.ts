// Config sub-barrel — help-hints SSO renderers. Split from
// `barrels/config.ts` per Story 56-it2-01 (L4-008).
//
// Single source of truth for CLI + MCP + graph-node hint strings.
// Registry-derived counts; never hardcode. (Story 54-it1-04)
//
// Story e92-3a: `buildSupportedTypesBlock` + `getTypeHint` are NEW
// public accessors for the grouped grid / short breadcrumb that error
// surfaces and help surfaces need. Implementations live in
// `supported-types-block.ts`; re-exported here so the CLI / MCP
// shims keep importing from `@assignee/core` without a path change.
export {
  BEGINNER_EXAMPLE_TYPES,
  HINT_MAX_COLUMNS,
  type HintStyle,
  buildSupportedTypesBlock,
  getCompoundPatterns,
  getPatternCount,
  getSupportedResourceTypes,
  getSupportedTypeCount,
  getTypeHint,
  renderClarifierExampleList,
  renderPatternsHint,
  renderSupportedTypesHint,
} from "../../config/help-hints.js";
