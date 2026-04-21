/**
 * LLM-plan phase 3: schema sanitisation + required-field repair.
 *
 * Responsible for:
 *   - Stripping extraneous keys + coercing types against the CFN schema
 *     (recursive). MUST run AFTER `mergeElicitedOptions` since plugins may add
 *     non-schema keys (e.g., DynamoDB PointInTimeRecoveryEnabled).
 *   - Generic required-field repair — fills missing required fields from
 *     plugin defaults (Story E2E.3 replaced the Lambda-Code one-off with this
 *     generic repairer).
 *
 * SRP: one reason to change — the schema conformance + required-field
 * contract between LLM output and CloudControl.
 */
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { sanitizeDesiredState } from "@/services/desired-state-sanitizer.js";
import { repairRequiredFields } from "@/services/required-field-repairer.js";

export interface SanitizeOutput {
  desiredState: Record<string, unknown>;
  injectedFields: ReturnType<typeof repairRequiredFields>["injectedFields"];
}

/**
 * Strips extraneous keys + coerces types against the CFN schema. No-op when
 * `schemaKeys` is empty (can't sanitize without schema metadata).
 *
 * When `resourceType` is a non-empty CFN type name (e.g.
 * `AWS::DynamoDB::Table`), the sanitizer ALSO applies the resource-aware
 * CCAPI-shape rules added in story e92.1.a (DDB PAY_PER_REQUEST drops
 * ProvisionedThroughput, ECS key-as-name → {Name,Value}, CloudFront
 * origin-config disambiguation, CF list canonicalisation). Threading
 * `state.resourceType` through this hookup is what activates those rules
 * at plan-generation time (story e92.1.a-followup).
 *
 * Logs a structured `PLAN_GENERATED` entry when any keys were stripped or
 * coerced so operators can trace LLM drift.
 */
export function sanitizeAgainstSchema(
  desiredState: Record<string, unknown>,
  resourceSchema: Record<string, unknown>,
  schemaKeys: string[],
  runId: string,
  resourceType: string,
): Record<string, unknown> {
  if (schemaKeys.length === 0) return desiredState;

  const { sanitized, strippedKeys, coercedKeys } = sanitizeDesiredState(
    desiredState,
    resourceSchema,
    resourceType || undefined,
  );
  if (strippedKeys.length > 0 || coercedKeys.length > 0) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_GENERATED,
      extras: {
        sanitized: true,
        strippedKeys,
        coercedKeys: coercedKeys.map((c) => `${c.path}: ${c.from}→${c.to}`),
      },
    });
  }
  return sanitized;
}

/**
 * Generic required-field repairer — fills missing required fields from plugin
 * defaults. Returns the (possibly repaired) desired state and the list of
 * injected fields (for the downstream `PLAN_GENERATED` log entry).
 *
 * Story E2E.3 — replaced the one-off Lambda Code repair with this generic path.
 */
export function repairRequired(
  desiredState: Record<string, unknown>,
  resourceType: string,
  requiredKeys: string[],
): SanitizeOutput {
  const { repaired, injectedFields } = repairRequiredFields(
    desiredState,
    resourceType,
    requiredKeys,
  );
  return { desiredState: repaired, injectedFields };
}
