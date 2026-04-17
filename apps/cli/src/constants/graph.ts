/**
 * Graph-node name re-export shim.
 *
 * Canonical implementation lives in `@assignee/core` (lifted in
 * Story 50-4 Wave 5 Pass I so the in-core `createGraph` + routing
 * functions can reference node names without a back-import into the CLI).
 */
export { GraphNode, type GraphNodeType } from "@assignee/core";

// Re-export StateField from core — single source of truth for graph state channel names.
export { StateField } from "@assignee/core";
