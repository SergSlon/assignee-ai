/**
 * intent-parser — re-export shim. The 1531-LOC monolith was decomposed
 * into a focused directory under `intent-parser/` in commit d5be418
 * (RW7 wave 1) + this commit (RW7 merge). All public exports are
 * preserved via re-export from `intent-parser/index.js` so existing
 * import paths (graph/index.ts, plan-generator.ts, preflight-guard.ts,
 * graph-state.ts, result-formatter/formatters/plan.ts, and the
 * intent-parser test suites) keep working unchanged.
 *
 * @see ./intent-parser/index.ts for the orchestrator factory.
 * @see .agents/reviews/rw7-intent-parser-manifest-2026-04-27.md
 */

export * from "./intent-parser/index.js";
