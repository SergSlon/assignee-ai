/**
 * Barrel for intent-defaults. Preserves the public surface of the
 * pre-decomposition monolith at apps/cli/src/utils/intent-defaults.ts.
 */

export type { IntentDefaultOverride, IntentRule } from "./types.js";
export { INTENT_RULES } from "./registry.js";
export { getIntentDefaults, applyIntentOverrides } from "./resolver.js";
