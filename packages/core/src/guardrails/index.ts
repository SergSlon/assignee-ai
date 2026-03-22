/**
 * Guardrails barrel — exports the default engine with all rules registered.
 *
 * To add a new guardrail rule:
 *   1. Create `rules/<rule-name>.ts` implementing GuardrailRule
 *   2. Import and register it here
 *   Zero changes to preflight-guard or display are required.
 *
 * @see Story 10.4, Task 3.2
 */

import { GuardrailEngine } from "./engine.js";
import { s3PublicAccessRule } from "./rules/s3-public-access.js";
import { s3MissingLifecycleRule } from "./rules/s3-missing-lifecycle.js";
import { missingEncryptionRule } from "./rules/missing-encryption.js";
import { iamWildcardActionsRule } from "./rules/iam-wildcard-actions.js";
import { autoscalingNoMaxSizeRule } from "./rules/autoscaling-no-maxsize.js";

/**
 * The default pre-populated guardrail engine for Assignee.ai.
 * Import this in graph nodes — do not instantiate a new GuardrailEngine elsewhere.
 */
export const defaultGuardrailEngine = new GuardrailEngine();
defaultGuardrailEngine.register(s3PublicAccessRule);
defaultGuardrailEngine.register(s3MissingLifecycleRule);
defaultGuardrailEngine.register(missingEncryptionRule);
defaultGuardrailEngine.register(iamWildcardActionsRule);
defaultGuardrailEngine.register(autoscalingNoMaxSizeRule);

export { GuardrailEngine };
export type {
  GuardrailSeverity,
  GuardrailFinding,
  GuardrailRule,
} from "./types.js";
