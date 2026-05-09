/**
 * SecretsManager secret default-CMK pre-provision (Wave D-4, epic-104-demo-dryrun).
 *
 * When the apply path receives a SecretsManager secret whose desiredState
 * does NOT specify a `KmsKeyId`, this pre-hook resolves the alias-CMK
 * from Wave D-0 (`alias/assignee-default-encryption`) and substitutes
 * its **alias name** into `KmsKeyId` before the CCAPI CreateResource call.
 *
 * SecretsManager's `KmsKeyId` accepts ARN form, key id, alias name
 * (`alias/...`), and the AWS-managed shorthand literal
 * `aws/secretsmanager`. The plugin's validate (`secretsmanager-secret.ts:77-87`)
 * accepts all four forms; this helper threads `result.aliasName` so the
 * substituted value matches the alias convention operators see in plan
 * output and in the wizard hint.
 *
 * # Why standard pattern (D-2 / SQS), not sentinel-upgrade (D-3 / SNS)
 *
 * The plugin's `defaults` block (line 194) sets only `GenerateSecretString:
 * true` — `KmsKeyId` is NOT populated by default. Bare-intent secrets
 * therefore arrive at apply with `KmsKeyId` ABSENT (CloudControl /
 * SecretsManager apply that with the AWS-managed `aws/secretsmanager`
 * key automatically). So the standard "absent or blank → substitute"
 * discriminator covers every bare-intent case; no sentinel-equality
 * check is required.
 *
 * Operators who explicitly want the AWS-managed key supply the literal
 * `"aws/secretsmanager"` (validate accepts it, helper preserves it
 * verbatim per I-D4-1).
 *
 * # Invariants
 *
 *   I-D4-1 — DEFAULT, NEVER HIJACK: any explicit non-empty `KmsKeyId`
 *     (ARN, key id, alias, or the AWS-managed shorthand `aws/secretsmanager`)
 *     is preserved verbatim. Same contract as Wave C's primitive.
 *   I-D4-2 — KEY FORM = ALIAS: substitutes `result.aliasName`, never
 *     `result.keyArn`. SecretsManager accepts alias-form so the
 *     substituted value stays human-readable and aligns with the
 *     `aws/secretsmanager` convention operators already know.
 *   I-D4-3 — FAIL CLOSED: when the resolver throws, the pre-hook returns
 *     `{ ok: false, errorMessage }` carrying the underlying error AND
 *     mentioning `aws/secretsmanager` so the operator sees the AWS-managed
 *     escape hatch. We never silently fall back — operators learn about
 *     account-level KMS issues now, not at the next epic-04 audit.
 *   I-D4-4 — POLLUTION DISCIPLINE: this module emits no audit records
 *     directly; the underlying `resolveDefaultKmsKeyForApply`
 *     (alias-resolver create-path) does, but it's gated by D-0's mock
 *     boundary in tests.
 *   I-D4-5 — CACHE REUSE: two SecretsManager secrets in the same apply
 *     call share one STS round-trip + one `kms:ListAliases` per region
 *     (the upstream alias-resolver caches by (accountId, region)).
 *
 * # Pre-hook contract
 *
 *   - No-op for any non-SecretsManager-Secret resource type (returns
 *     `{ ok: true }` with zero AWS calls).
 *   - No-op when `desiredState["KmsKeyId"]` is a non-empty trimmed
 *     string (user value preserved verbatim — including the
 *     `"aws/secretsmanager"` AWS-managed escape hatch).
 *   - Otherwise calls `resolveDefaultKmsKeyForApply` and substitutes
 *     `result.aliasName`.
 *   - On resolver error, returns `{ ok: false, errorMessage }`. CCAPI is
 *     NEVER called in this case (orchestrator returns FAILED).
 *
 * # Why apply-time and not plan-time
 *
 * Same rationale as D-1/D-2/D-3: the wizard / plan formatter still
 * surfaces whatever the user authored (or absent if they skipped the
 * field) so plan output is readable / stable across runs. The actual
 * alias substitution happens once per (apply, secret) at provision time.
 *
 * SRP: this module changes when SecretsManager default-CMK injection
 * rules change.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-default-secretsmanager-secret-d4.md
 * @see packages/core/src/graph/nodes/resource-provisioner/sqs-encryption.ts (parent pattern, Wave D-2)
 * @see packages/core/src/services/apply-time-kms-resolver.ts
 */

import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { resolveDefaultKmsKeyForApply } from "@/services/apply-time-kms-resolver.js";

/**
 * Result of the SecretsManager default-CMK pre-hook. Mirrors
 * `EnsureS3DefaultKmsResult` shape so the orchestrator wires the
 * failure path identically.
 */
export type EnsureSecretsManagerDefaultKmsResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/**
 * Resolve the default CMK alias for a SecretsManager secret whose
 * desiredState lacks an explicit `KmsKeyId`. Mutates `desiredState`
 * in place.
 *
 * Idempotent across multiple secrets in the same apply: the upstream
 * alias-resolver caches by (accountId, region) so a second call returns
 * the same aliasName with zero additional STS / KMS round-trips.
 */
export async function ensureSecretsManagerDefaultKms(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<EnsureSecretsManagerDefaultKmsResult> {
  if (state.resourceType !== RESOURCE_TYPES.SECRETSMANAGER_SECRET) {
    return { ok: true };
  }

  const explicit = desiredState[CfnKey.KMS_KEY_ID];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    // I-D4-1: user value preserved verbatim (any non-empty trimmed
    // string — ARN, key id, alias, including the AWS-managed
    // `aws/secretsmanager` escape hatch).
    return { ok: true };
  }

  let resolvedAlias: string;
  try {
    const result = await resolveDefaultKmsKeyForApply({
      region: AWS_REGION,
      ...(state.runId ? { runId: state.runId } : {}),
    });
    // I-D4-2: aliasName (e.g. "alias/assignee-default-encryption") —
    // SecretsManager accepts alias-form so we keep desiredState
    // human-readable.
    resolvedAlias = result.aliasName;
  } catch (err) {
    // I-D4-3: fail closed. Surface the underlying error message + an
    // actionable hint mentioning the `aws/secretsmanager` escape hatch.
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to resolve default Assignee KMS CMK for SecretsManager secret encryption (${cause}). ` +
        "Either supply an explicit KmsKeyId (the AWS-managed shorthand " +
        "'aws/secretsmanager', an alias of the form alias/<name>, or a CMK ARN) " +
        "or fix the underlying credential / KMS access issue and retry.",
    };
  }

  desiredState[CfnKey.KMS_KEY_ID] = resolvedAlias;
  return { ok: true };
}
