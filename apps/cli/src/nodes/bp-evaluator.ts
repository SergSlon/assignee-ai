/**
 * bp_evaluator node — evaluates best practice rules against the planned
 * resource configuration and stores findings in graph state.
 *
 * Wave-6c F3: SOLID refactor. Thin façade over SRP sub-modules in
 * `./bp-evaluator/`. All previously-exported names remain accessible
 * here for back-compat with tests and intra-repo imports.
 *
 * @see Story 12.3, ADR-009
 */

export {
  BpIntegrityMode,
  type BpIntegrityModeType,
  BpIntegrityError,
  resolveBpIntegrityMode,
} from "./bp-evaluator/integrity-mode.js";
export { _listBpManifestCandidates } from "./bp-evaluator/manifest-path.js";
export { resetBPCache } from "./bp-evaluator/rule-loader.js";
export { bpEvaluatorNode } from "./bp-evaluator/orchestrator.js";
