/**
 * SQS queue default-CMK pre-provision (Wave D-2, epic-104-demo-dryrun).
 *
 * When the apply path receives an SQS queue whose desiredState does NOT
 * specify a `KmsMasterKeyId`, this pre-hook resolves the alias-CMK from
 * Wave D-0 (`alias/assignee-default-encryption`) and substitutes its
 * **alias name** into `KmsMasterKeyId` before the CCAPI CreateResource
 * call.
 *
 * SQS's `KmsMasterKeyId` accepts BOTH key-ARN and alias-name forms (per
 * Wave D-0 roadmap; mirrors the operator-facing escape hatch
 * `alias/aws/sqs` for the AWS-managed key). This module threads
 * `result.aliasName`, NOT `result.keyArn`, so the displayed / audited
 * desiredState stays human-readable AND aligns with the `alias/aws/sqs`
 * convention operators already know.
 *
 * # Invariants
 *
 *   I-D2-1 — DEFAULT, NEVER HIJACK: any explicit non-empty `KmsMasterKeyId`
 *     (ARN, key ID, or alias) is preserved verbatim. Same contract as
 *     Wave C's primitive: explicit user value > default.
 *   I-D2-2 — KEY FORM = ALIAS: substitutes `result.aliasName`, never
 *     `result.keyArn`. This is the load-bearing difference from Wave D-1
 *     (S3) which threads the keyArn — S3's SSE-KMS field rejects
 *     alias-form, SQS accepts it. See feature-kms-default-sqs-queue-d2.md
 *     "Differences from D-1".
 *   I-D2-3 — FAIL CLOSED: when the resolver throws, the pre-hook returns
 *     `{ ok: false, errorMessage }` carrying the underlying error AND
 *     mentioning `alias/aws/sqs` so the operator sees the AWS-managed
 *     escape hatch. We never silently fall back to `alias/aws/sqs` —
 *     operators learn about account-level KMS issues now, not at the
 *     next epic-04 audit.
 *   I-D2-4 — POLLUTION DISCIPLINE: this module emits no audit records
 *     directly; the underlying `resolveDefaultKmsKeyForApply`
 *     (alias-resolver create-path) does, but it's gated by D-0's mock
 *     boundary in tests.
 *   I-D2-5 — CACHE REUSE: two SQS queues in the same apply call share
 *     one STS round-trip + one `kms:ListAliases` per region (the
 *     upstream alias-resolver caches by (accountId, region)).
 *   I-D2-6 — SSE-SQS SKIP: when `SqsManagedSseEnabled === true` is
 *     present on the desiredState, this hook is a no-op. SSE-SQS (free
 *     AWS-managed encryption) is mutually exclusive with `KmsMasterKeyId`
 *     — CCAPI rejects an apply that sets both with InvalidAttributeValue.
 *     Mirrors D-1's implicit SSE-S3 (AES256) skip via the `SSEAlgorithm`
 *     discriminator. The SQS plugin sets `SqsManagedSseEnabled: true` as
 *     a default (sqs-queue.ts:217) so every bare-intent SQS apply takes
 *     this skip path; only operators who explicitly disabled it (or
 *     authored a `KmsMasterKeyId`) reach the resolver.
 *
 * # Pre-hook contract
 *
 *   - No-op for any non-SQS resource type (returns `{ ok: true }` with
 *     zero AWS calls).
 *   - No-op when `desiredState["SqsManagedSseEnabled"] === true` (I-D2-6
 *     — mutually exclusive with `KmsMasterKeyId`; injecting alongside
 *     causes CCAPI InvalidAttributeValue).
 *   - No-op when `desiredState["KmsMasterKeyId"]` is a non-empty trimmed
 *     string (user value preserved verbatim).
 *   - Otherwise calls `resolveDefaultKmsKeyForApply` and substitutes
 *     `result.aliasName`.
 *   - On resolver error, returns `{ ok: false, errorMessage }`. CCAPI is
 *     NEVER called in this case (orchestrator returns FAILED).
 *
 * # Why apply-time and not plan-time
 *
 * The wizard / plan formatter still surfaces whatever the user authored
 * (placeholder, alias name, or explicit ARN) so plan output is readable
 * / stable across runs. The actual alias substitution happens once per
 * (apply, SQS queue) at provision time so the operator's plan output
 * is not polluted with account-specific defaults.
 *
 * SRP: this module changes when SQS default-CMK injection rules change.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-default-sqs-queue-d2.md
 * @see packages/core/src/graph/nodes/resource-provisioner/s3-encryption.ts (parent pattern, Wave D-1)
 * @see packages/core/src/services/apply-time-kms-resolver.ts
 */

import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { resolveDefaultKmsKeyForApply } from "@/services/apply-time-kms-resolver.js";

/**
 * Result of the SQS default-CMK pre-hook. Mirrors `EnsureS3DefaultKmsResult`
 * shape so the orchestrator wires the failure path identically.
 */
export type EnsureSqsDefaultKmsResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/**
 * Resolve the default CMK alias for an SQS queue whose desiredState
 * lacks an explicit `KmsMasterKeyId`. Mutates `desiredState` in place.
 *
 * Idempotent across multiple queues in the same apply: the upstream
 * alias-resolver caches by (accountId, region) so a second call returns
 * the same aliasName with zero additional STS / KMS round-trips.
 */
export async function ensureSqsDefaultKms(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<EnsureSqsDefaultKmsResult> {
  if (state.resourceType !== RESOURCE_TYPES.SQS_QUEUE) {
    return { ok: true };
  }

  if (desiredState[CfnKey.SQS_MANAGED_SSE] === true) {
    // I-D2-6: SSE-SQS (free AWS-managed SSE) is mutually exclusive with
    // KmsMasterKeyId. The SQS plugin defaults this to `true`
    // (sqs-queue.ts:217); injecting a CMK alongside causes CCAPI to
    // reject the apply with InvalidAttributeValue. Mirrors D-1's
    // implicit SSE-S3 (AES256) skip via the `SSEAlgorithm` discriminator.
    return { ok: true };
  }

  const explicit = desiredState[CfnKey.KMS_MASTER_KEY_ID];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    // I-D2-1: user value preserved verbatim (any non-empty trimmed
    // string — ARN, key ID, alias, including the AWS-managed
    // `alias/aws/sqs` escape hatch).
    return { ok: true };
  }

  let resolvedAlias: string;
  try {
    const result = await resolveDefaultKmsKeyForApply({
      region: AWS_REGION,
      ...(state.runId ? { runId: state.runId } : {}),
    });
    // I-D2-2: aliasName (e.g. "alias/assignee-default-encryption") —
    // SQS accepts alias-form so we keep desiredState human-readable.
    resolvedAlias = result.aliasName;
  } catch (err) {
    // I-D2-3: fail closed. Surface the underlying error message + an
    // actionable hint so the operator sees the `alias/aws/sqs` escape
    // hatch and the explicit-key path.
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to resolve default Assignee KMS CMK for SQS queue encryption (${cause}). ` +
        "Either supply an explicit KmsMasterKeyId (the AWS-managed " +
        "alias/aws/sqs, an alias of the form alias/<name>, or a CMK ARN) " +
        "or fix the underlying credential / KMS access issue and retry.",
    };
  }

  desiredState[CfnKey.KMS_MASTER_KEY_ID] = resolvedAlias;
  return { ok: true };
}
