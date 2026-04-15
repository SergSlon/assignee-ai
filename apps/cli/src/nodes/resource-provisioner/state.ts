/**
 * Deep-clone helper for LangGraph desiredState.
 *
 * Item F invariant: LangGraph nodes must not mutate input state in place.
 * Every mutation inside the provisioner must go through a clone produced
 * here, and the clone is what we return to the reducer.
 *
 * H8 invariant: shallow clone (`{...state.desiredState}`) leaves nested
 * Properties.Tags / PolicyDocument / UserData shared with the caller, so
 * `injectMandatoryTags` would mutate the caller's nested arrays. The clone
 * MUST be fully isolated.
 *
 * P1-R2-8 invariant: enforce the plain-object contract AND surface an
 * actionable `DataCloneError` hint when a test or caller accidentally
 * passes a class instance / function / symbol-bearing object.
 *
 * Today this re-exports from `plan-generator.ts` (F2 has not yet moved
 * safeClone into its own submodule). When F2 lands, flip the import here
 * — every caller in this namespace updates in lockstep.
 */

export { safeCloneDesiredState } from "../plan-generator.js";
