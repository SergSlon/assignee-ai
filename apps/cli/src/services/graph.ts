/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/graph` (Story 50-4 Wave 5 Pass I). The MCP server now
 * imports `createGraph` directly from `@assignee/core/graph`; the CLI
 * continues to import it through this path for back-compat.
 */

export { createGraph, type CreateGraphOptions } from "@assignee/core/graph";
export {
  graphAnnotation,
  type AgentState,
  type AppliedFix,
  type SecurityFinding,
} from "@assignee/core/graph";
