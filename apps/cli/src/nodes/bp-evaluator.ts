/**
 * bp_evaluator node — evaluates best practice rules against the planned
 * resource configuration and stores findings in graph state.
 *
 * Wave-6c F3: SOLID refactor. Thin façade over SRP sub-modules in
 * `./bp-evaluator/`.
 *
 * Story 50-3: the integrity-enforcement surface
 * (BpIntegrityError/BpIntegrityMode/resolveBpIntegrityMode/
 * _listBpManifestCandidates) was removed along with the GPG signing
 * layer — BP loading is now a straightforward cached load.
 *
 * @see Story 12.3, ADR-009
 */

export { resetBPCache } from "./bp-evaluator/rule-loader.js";
export { bpEvaluatorNode } from "./bp-evaluator/orchestrator.js";
