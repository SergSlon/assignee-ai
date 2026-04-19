/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/graph` (barrel) → `./nodes/advice/cost-optimizer/orchestrator.ts`
 * (Story 50-4 Wave 5 Pass H; Story 58-it1-05 moved the import path off the
 * now-removed `@assignee/core/graph/nodes/*` wildcard export).
 */
export { analyzeResource } from "@assignee/core/graph";
