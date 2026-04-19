// Config sub-barrel — help-hints SSO renderers. Split from
// `barrels/config.ts` per Story 56-it2-01 (L4-008).
//
// Single source of truth for CLI + MCP + graph-node hint strings.
// Registry-derived counts; never hardcode. (Story 54-it1-04)
export {
  HINT_MAX_COLUMNS,
  type HintStyle,
  getCompoundPatterns,
  getPatternCount,
  getSupportedResourceTypes,
  getSupportedTypeCount,
  renderPatternsHint,
  renderSupportedTypesHint,
} from "../../config/help-hints.js";
