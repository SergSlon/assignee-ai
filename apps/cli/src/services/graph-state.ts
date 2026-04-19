/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/graph/graph-state` (Story 50-4 Wave 5 Pass D).
 *
 * Pass E will rewire the remaining `createGraph` + routing imports so
 * this file can be removed in favor of the direct core import.
 */

export {
  graphAnnotation,
  type AgentState,
  type AppliedFix,
  type SecurityFinding,
} from "@assignee/core/graph";
