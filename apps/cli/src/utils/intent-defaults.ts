/**
 * Intent-aware smart defaults for the option elicitor.
 *
 * Maps keyword patterns in the user's intent string to field default overrides.
 * Uses simple case-insensitive substring matching — no LLM calls required.
 * First matching rule per field wins (no conflicting overrides).
 *
 * @see Story 10.5
 *
 * This file is a thin facade over the decomposed module at
 * ./intent-defaults/. Rules are grouped by resource type into separate
 * files (rules-ec2, rules-s3, rules-lambda, rules-rds, rules-misc) and
 * aggregated in ./intent-defaults/registry.ts.
 */

export type {
  IntentDefaultOverride,
  IntentRule,
} from "./intent-defaults/index.js";
export {
  INTENT_RULES,
  getIntentDefaults,
  applyIntentOverrides,
} from "./intent-defaults/index.js";
