/**
 * Security-sensitive constants. Domain sub-module of the former
 * `config/constants.ts` coupling hub (Story 49.5).
 */

/** Prototype pollution keys to reject in deep-merge and patch operations. */
export const PROTO_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
