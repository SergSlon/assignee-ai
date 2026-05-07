/**
 * Core destroy barrel — shared destroy primitives available to both
 * `apps/cli` and `apps/mcp-server`.
 */

export {
  EXCLUSION_ALLOWLIST,
  findExclusion,
  isExcluded,
  type ExclusionEntry,
} from "./exclusion-allowlist.js";
