/**
 * EFS file system default-CMK pre-provision (Wave D-5, epic-104-demo-dryrun).
 *
 * When the apply path receives an EFS file system whose desiredState
 * has `Encrypted: true` but does NOT specify a `KmsKeyId`, this
 * pre-hook resolves the alias-CMK from Wave D-0
 * (`alias/assignee-default-encryption`) and substitutes its
 * **alias name** into `KmsKeyId` before the CCAPI CreateResource call.
 *
 * EFS's `KmsKeyId` accepts an alias-name form (`alias/...`), an alias
 * ARN, a key ID, or a key ARN — the plugin's validate
 * (`efs-file-system.ts:194-225`) accepts all four forms. This module
 * threads `result.aliasName` so the substituted value matches the
 * alias convention operators see in plan output and the wizard hint.
 *
 * # Discriminator: Encrypted === true
 *
 * The EFS plugin's `defaults` block (`efs-file-system.ts:230`) sets
 * `Encrypted: true`, so EVERY bare-intent EFS apply will trigger this
 * hook. If an operator explicitly opts out via `Encrypted: false`
 * (rare — the configHint warns BP-EFS-001 will block), the hook is a
 * no-op because EFS uses no KMS key at all when unencrypted. Mirrors
 * the D-1 implicit "SSE-S3 (AES256) skip via SSEAlgorithm
 * discriminator" pattern.
 *
 * # Invariants
 *
 *   I-D5-1 — DEFAULT, NEVER HIJACK: any explicit non-empty `KmsKeyId`
 *     (ARN, key id, alias) is preserved verbatim. Same contract as
 *     Wave C's primitive: explicit user value > default.
 *   I-D5-2 — KEY FORM = ALIAS: substitutes `result.aliasName`, never
 *     `result.keyArn`. EFS accepts alias-form so the substituted value
 *     stays human-readable and aligns with the `aws/elasticfilesystem`
 *     convention operators already know.
 *   I-D5-3 — FAIL CLOSED: when the resolver throws, the pre-hook
 *     returns `{ ok: false, errorMessage }` carrying the underlying
 *     error AND mentioning `aws/elasticfilesystem` so the operator
 *     sees the AWS-managed escape hatch. We never silently fall back —
 *     operators learn about account-level KMS issues now, not at the
 *     next epic-04 audit.
 *   I-D5-4 — POLLUTION DISCIPLINE: this module emits no audit records
 *     directly; the underlying `resolveDefaultKmsKeyForApply`
 *     (alias-resolver create-path) does, but it's gated by D-0's mock
 *     boundary in tests.
 *   I-D5-5 — CACHE REUSE: two EFS file systems in the same apply call
 *     share one STS round-trip + one `kms:ListAliases` per region (the
 *     upstream alias-resolver caches by (accountId, region)).
 *   I-D5-6 — ENCRYPTED-ONLY: when `Encrypted !== true` is present on
 *     the desiredState, this hook is a no-op. EFS uses no KMS key at
 *     all when unencrypted; injecting one would be wasted (CCAPI
 *     ignores KmsKeyId on unencrypted file systems). Mirrors D-1's
 *     implicit SSE-S3 (AES256) skip via the `SSEAlgorithm`
 *     discriminator.
 *
 * # Pre-hook contract
 *
 *   - No-op for any non-EFS-FileSystem resource type (returns
 *     `{ ok: true }` with zero AWS calls).
 *   - No-op when `desiredState["Encrypted"] !== true` (I-D5-6 — EFS
 *     uses no KMS when unencrypted).
 *   - No-op when `desiredState["KmsKeyId"]` is a non-empty trimmed
 *     string (user value preserved verbatim — including any AWS-managed
 *     `aws/elasticfilesystem` literal or alias-ARN escape hatch).
 *   - Otherwise calls `resolveDefaultKmsKeyForApply` and substitutes
 *     `result.aliasName`.
 *   - On resolver error, returns `{ ok: false, errorMessage }`. CCAPI
 *     is NEVER called in this case (orchestrator returns FAILED).
 *
 * # Why apply-time and not plan-time
 *
 * Same rationale as D-1/D-2/D-3/D-4: the wizard / plan formatter still
 * surfaces whatever the user authored (placeholder, alias name, or
 * explicit ARN) so plan output is readable / stable across runs. The
 * actual alias substitution happens once per (apply, EFS file system)
 * at provision time.
 *
 * SRP: this module changes when EFS default-CMK injection rules change.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-default-efs-d5.md
 * @see packages/core/src/graph/nodes/resource-provisioner/sqs-encryption.ts (parent pattern, Wave D-2)
 * @see packages/core/src/services/apply-time-kms-resolver.ts
 */

import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { resolveDefaultKmsKeyForApply } from "@/services/apply-time-kms-resolver.js";

/**
 * Result of the EFS default-CMK pre-hook. Mirrors `EnsureS3DefaultKmsResult`
 * shape so the orchestrator wires the failure path identically.
 */
export type EnsureEfsDefaultKmsResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/**
 * Resolve the default CMK alias for an EFS file system whose
 * desiredState lacks an explicit `KmsKeyId` AND has `Encrypted: true`.
 * Mutates `desiredState` in place.
 *
 * Idempotent across multiple file systems in the same apply: the
 * upstream alias-resolver caches by (accountId, region) so a second
 * call returns the same aliasName with zero additional STS / KMS
 * round-trips.
 */
export async function ensureEfsDefaultKms(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<EnsureEfsDefaultKmsResult> {
  if (state.resourceType !== RESOURCE_TYPES.EFS_FILE_SYSTEM) {
    return { ok: true };
  }

  if (desiredState[CfnKey.ENCRYPTED] !== true) {
    // I-D5-6: EFS uses no KMS key at all when unencrypted. The plugin
    // defaults `Encrypted: true` (efs-file-system.ts:231); only operators
    // who explicitly opted into unencrypted EFS reach this skip path.
    // Mirrors D-1's implicit SSE-S3 (AES256) skip via the `SSEAlgorithm`
    // discriminator.
    return { ok: true };
  }

  const explicit = desiredState[CfnKey.KMS_KEY_ID];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    // I-D5-1: user value preserved verbatim (any non-empty trimmed
    // string — ARN, key ID, alias, including any AWS-managed
    // `aws/elasticfilesystem` literal or alias-ARN escape hatch).
    return { ok: true };
  }

  let resolvedAlias: string;
  try {
    const result = await resolveDefaultKmsKeyForApply({
      region: AWS_REGION,
      ...(state.runId ? { runId: state.runId } : {}),
    });
    // I-D5-2: aliasName (e.g. "alias/assignee-default-encryption") —
    // EFS accepts alias-form so we keep desiredState human-readable.
    resolvedAlias = result.aliasName;
  } catch (err) {
    // I-D5-3: fail closed. Surface the underlying error message + an
    // actionable hint so the operator sees the `aws/elasticfilesystem`
    // escape hatch and the explicit-key path.
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to resolve default Assignee KMS CMK for EFS file system encryption (${cause}). ` +
        "Either supply an explicit KmsKeyId (the AWS-managed " +
        "alias/aws/elasticfilesystem, an alias of the form alias/<name>, or a CMK ARN) " +
        "or fix the underlying credential / KMS access issue and retry. " +
        "If you intended to disable encryption entirely, set Encrypted: false " +
        "(WARNING: BP-EFS-001 will block this; only do so on explicit request).",
    };
  }

  desiredState[CfnKey.KMS_KEY_ID] = resolvedAlias;
  return { ok: true };
}
