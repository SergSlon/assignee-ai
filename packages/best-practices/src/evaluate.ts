/**
 * Thin re-export barrel preserving the `./evaluate.js` import surface after
 * the W6d F3 split into ./evaluate/. All logic lives in the folder modules
 * (context-builder, rule-runner, severity-router, compound-suppressor-link,
 * result-formatter, barrel).
 */

export { getField, type EvalContext } from "./evaluate/context-builder.js";
export { checkPasses } from "./evaluate/rule-runner.js";
export { matchesTrigger } from "./evaluate/severity-router.js";
export { shouldSkipForPattern } from "./evaluate/compound-suppressor-link.js";
export { buildFinding } from "./evaluate/result-formatter.js";
export { evaluateTriggers } from "./evaluate/barrel.js";
