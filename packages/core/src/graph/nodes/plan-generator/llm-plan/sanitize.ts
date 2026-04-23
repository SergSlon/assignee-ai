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
 *   - User-stated VolumeSize fidelity (e98.W2.R4, Epic 97 C-R2): when the
 *     user intent literally contains a `<N>GB` / `<N> GiB` span for an EC2
 *     instance, the post-parse patcher overrides the plugin/LLM default
 *     `BlockDeviceMappings[0].Ebs.VolumeSize` with that value.
 *
 * SRP: one reason to change — the schema conformance + required-field
 * contract between LLM output and CloudControl.
 */
import { RESOURCE_TYPES } from "@/index.js";
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

/**
 * e98.W2.R4 (Epic 97 C-R2) — post-parse VolumeSize fidelity patcher.
 *
 * When the user intent mentions a volume size (`100GB`, `50 GiB`, etc.) but
 * the LLM emitted a smaller default (Epic 94 plugin seed of 8GB gp3), the
 * user-stated value must win. Pre-fix the LLM's 8 slipped through to the
 * plan unchanged — the user asked for 100GB and got 8GB without a warning,
 * which is a silent data-capacity drift at apply time.
 *
 * Semantics:
 *   - Scoped to AWS::EC2::Instance only (BlockDeviceMappings schema is
 *     instance-specific; Lambda layers / RDS / FSx use different keys).
 *   - Regex `(\d+)\s*(?:GB|GiB)\b` — case-insensitive, word-boundary anchored
 *     so `100GBP` / `5GBit` / `GB-something` never match.
 *   - Takes the FIRST match in the intent. If no match, no-op.
 *   - Mutates `BlockDeviceMappings[0].Ebs.VolumeSize`. If the array is
 *     missing or empty, seeds a root-volume shell so downstream sanitize +
 *     CFN render produce a real `{DeviceName, Ebs: {...}}` entry.
 *   - If the existing VolumeSize already matches the user-stated value,
 *     no-op silently (no redundant log entry).
 *   - When the LLM emitted a DIFFERENT value, this function OVERRIDES it
 *     and logs a `PLAN_REPAIR` entry so operators can see the mutation.
 *
 * Returns the possibly-mutated desiredState. Not a pure function — mutates
 * in place for symmetry with `postRepairPostProcess`, which sets the
 * architectural precedent for desired-state patches in this phase.
 */
const USER_VOLUME_SIZE_REGEX = /(\d+)\s*(?:GB|GiB)\b/i;

export function applyUserStatedVolumeSize(
  desiredState: Record<string, unknown>,
  resourceType: string,
  userIntent: string,
  runId: string,
): Record<string, unknown> {
  if (resourceType !== RESOURCE_TYPES.EC2_INSTANCE) return desiredState;
  if (!userIntent) return desiredState;

  const match = USER_VOLUME_SIZE_REGEX.exec(userIntent);
  if (!match || !match[1]) return desiredState;
  const userValue = Number.parseInt(match[1], 10);
  if (!Number.isFinite(userValue) || userValue <= 0) return desiredState;

  const existing = desiredState["BlockDeviceMappings"];
  const bdm: Array<Record<string, unknown>> = Array.isArray(existing)
    ? (existing as Array<Record<string, unknown>>)
    : [];
  if (bdm.length === 0) {
    // Seed a root-volume shell when the LLM omitted BDM entirely. The
    // remaining CFN-required fields (DeviceName, VolumeType, Encrypted)
    // are backfilled by the EC2 plugin's defaults in `mergePluginDefaults`
    // — but that phase ran BEFORE us, so the seed here is effectively the
    // only path into BDM when the LLM dropped it. Keep the seed minimal —
    // the EBS encryption/VolumeType defaults already landed via the plugin
    // spread; we only need a skeleton slot to hold the user-stated size.
    bdm.push({ DeviceName: "/dev/xvda", Ebs: { VolumeSize: userValue } });
  } else {
    const first = bdm[0] ?? {};
    const ebs: Record<string, unknown> =
      typeof first["Ebs"] === "object" && first["Ebs"] !== null
        ? (first["Ebs"] as Record<string, unknown>)
        : {};
    const prior = ebs["VolumeSize"];
    if (prior === userValue) return desiredState;
    ebs["VolumeSize"] = userValue;
    first["Ebs"] = ebs;
    bdm[0] = first;
    // Log the override only when we actually changed a present value; a
    // missing -> user-stated write is the expected fidelity path, not a
    // noteworthy repair.
    if (typeof prior === "number" && prior !== userValue) {
      log({
        ts: new Date().toISOString(),
        runId,
        level: "info",
        action: LOG_ACTIONS.PLAN_GENERATED,
        extras: {
          userStatedVolumeSize: true,
          priorVolumeSize: prior,
          overrideVolumeSize: userValue,
        },
      });
    }
  }
  desiredState["BlockDeviceMappings"] = bdm;
  return desiredState;
}
