/**
 * S3 bucket default-CMK pre-provision (Wave D-1, epic-104-demo-dryrun).
 *
 * When the apply path receives an S3 bucket whose desiredState specifies
 * SSE-KMS (`SSEAlgorithm = "aws:kms"`) but does NOT specify a
 * `KMSMasterKeyID`, this pre-hook resolves the alias-CMK from Wave D-0
 * (`alias/assignee-default-encryption`) and substitutes its key ARN into
 * the encryption rule before CCAPI CreateResource is called.
 *
 * S3's `KMSMasterKeyID` accepts a key ARN ONLY (the alias-form is
 * rejected at the CCAPI boundary — confirmed in Wave C reviewer recon).
 * This module therefore threads `result.keyArn`, NEVER `result.aliasName`.
 *
 * # Invariants
 *
 *   I-D1-1 — DEFAULT, NEVER HIJACK: any explicit non-empty `KMSMasterKeyID`
 *     (ARN, key ID, or alias) is preserved verbatim. Same contract as
 *     Wave C's primitive: explicit user value > default.
 *   I-D1-2 — KEY ARN ONLY: substitutes `result.keyArn`, never
 *     `result.aliasName` (S3 SSE-KMS field rejects alias-form).
 *   I-D1-3 — FAIL CLOSED: when the resolver throws, the pre-hook returns
 *     `{ ok: false, errorMessage }` carrying the underlying error so the
 *     orchestrator surfaces FAILED + a clear message. We never silently
 *     fall back to AWS-managed `aws/s3` — operators learn about
 *     account-level KMS issues now, not at the next epic-04 audit.
 *   I-D1-4 — POLLUTION DISCIPLINE: this module emits no audit records
 *     directly; the underlying `resolveDefaultKmsKeyForApply`
 *     (alias-resolver create-path) does, but it's gated by D-0's mock
 *     boundary in tests.
 *   I-D1-5 — CACHE REUSE: two S3 buckets in the same apply call share
 *     one STS round-trip + one `kms:ListAliases` per region (the
 *     upstream alias-resolver caches by (accountId, region)).
 *
 * # Pre-hook contract
 *
 *   - No-op for any non-S3 resource type (returns `{ ok: true }` with
 *     zero AWS calls).
 *   - No-op when desiredState lacks `BucketEncryption` or its nested
 *     `ServerSideEncryptionConfiguration` array (e.g. user opted out of
 *     encryption — leave to AWS S3 default).
 *   - Iterates the SSEConfiguration array, finds entries whose
 *     `ServerSideEncryptionByDefault.SSEAlgorithm === "aws:kms"`. For
 *     each such entry where `KMSMasterKeyID` is undefined / empty /
 *     whitespace-only, calls `resolveDefaultKmsKeyForApply` and
 *     substitutes the resolved keyArn.
 *   - On resolver error, returns `{ ok: false, errorMessage }`. CCAPI is
 *     NEVER called in this case (orchestrator returns FAILED).
 *
 * # Why apply-time and not plan-time
 *
 * The wizard / plan formatter still surfaces the alias-name placeholder
 * (or whatever the user authored) so plan output is readable / stable
 * across runs. The actual ARN substitution happens once per (apply, S3
 * bucket) at provision time so the operator's plan output is not
 * polluted with account-specific ARNs.
 *
 * SRP: this module changes when S3 default-CMK injection rules change.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-default-s3-bucket-d1.md
 * @see packages/core/src/services/apply-time-kms-resolver.ts
 */

import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { resolveDefaultKmsKeyForApply } from "@/services/apply-time-kms-resolver.js";

/**
 * Result of the S3 default-CMK pre-hook. Mirrors `EnsureSubnetResult`
 * shape so the orchestrator wires the failure path identically.
 */
export type EnsureS3DefaultKmsResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/**
 * Resolve the default CMK for any SSE-KMS rule on the desiredState that
 * lacks an explicit `KMSMasterKeyID`. Mutates `desiredState` in place.
 *
 * Idempotent across multiple buckets in the same apply: the upstream
 * alias-resolver caches by (accountId, region) so a second call returns
 * the same keyArn with zero additional STS / KMS round-trips.
 */
export async function ensureS3DefaultKms(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<EnsureS3DefaultKmsResult> {
  if (state.resourceType !== RESOURCE_TYPES.S3_BUCKET) {
    return { ok: true };
  }

  const encryptionBlock = desiredState[CfnKey.BUCKET_ENCRYPTION];
  if (!isPlainObject(encryptionBlock)) {
    return { ok: true };
  }

  const sseConfig = encryptionBlock["ServerSideEncryptionConfiguration"];
  if (!Array.isArray(sseConfig) || sseConfig.length === 0) {
    return { ok: true };
  }

  // Collect every rule whose SSEAlgorithm is aws:kms AND whose
  // KMSMasterKeyID is missing or blank. We resolve the default CMK
  // exactly once per call (the alias-resolver primitive itself is
  // additionally cached per (accountId, region)) and substitute the
  // resulting keyArn into each matching rule.
  const rulesNeedingDefault: Record<string, unknown>[] = [];
  for (const rule of sseConfig) {
    if (!isPlainObject(rule)) continue;
    const sseDefault = rule["ServerSideEncryptionByDefault"];
    if (!isPlainObject(sseDefault)) continue;
    if (sseDefault["SSEAlgorithm"] !== "aws:kms") continue;
    const explicit = sseDefault["KMSMasterKeyID"];
    if (typeof explicit === "string" && explicit.trim().length > 0) {
      // I-D1-1: user value preserved verbatim.
      continue;
    }
    rulesNeedingDefault.push(sseDefault);
  }

  if (rulesNeedingDefault.length === 0) {
    return { ok: true };
  }

  let resolvedKeyArn: string;
  try {
    const result = await resolveDefaultKmsKeyForApply({
      region: AWS_REGION,
      ...(state.runId ? { runId: state.runId } : {}),
    });
    // I-D1-2: keyArn (full ARN) — S3 rejects alias-form.
    resolvedKeyArn = result.keyArn;
  } catch (err) {
    // I-D1-3: fail closed. Surface the underlying error message + an
    // actionable hint so the operator sees exactly what went wrong.
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to resolve default Assignee KMS CMK for S3 bucket encryption (${cause}). ` +
        "Either supply an explicit KMSMasterKeyID (ARN of an existing customer-managed key) " +
        "or fix the underlying credential / KMS access issue and retry.",
    };
  }

  for (const sseDefault of rulesNeedingDefault) {
    sseDefault["KMSMasterKeyID"] = resolvedKeyArn;
  }

  return { ok: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
