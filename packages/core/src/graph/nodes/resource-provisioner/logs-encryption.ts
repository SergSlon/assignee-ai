/**
 * CloudWatch Logs LogGroup default-CMK pre-provision (Wave D-6, epic-104-demo-dryrun).
 *
 * When the apply path receives a CloudWatch Logs LogGroup whose
 * desiredState does NOT specify a `KmsKeyId`, this pre-hook:
 *
 * 1. Resolves the alias-CMK from Wave D-0
 *    (`alias/assignee-default-encryption`).
 * 2. **Ensures the CMK key policy grants
 *    `logs.<region>.amazonaws.com`** the actions kms:Encrypt-star,
 *    Decrypt-star, ReEncrypt-star, GenerateDataKey-star, and
 *    Describe-star (the trailing star = wildcard suffix; written
 *    out long-form to keep the JSDoc parser happy). Without this
 *    grant, the `AssociateKmsKey` API (used by CCAPI when KmsKeyId
 *    is set on a LogGroup) is rejected with `InvalidParameterException`.
 * 3. Substitutes the **key ARN** (CloudWatch Logs API requires the
 *    full key ARN, NOT the alias-form — alias resolves at
 *    AssociateKmsKey time but the field is canonicalised to the ARN
 *    in CloudFormation state).
 *
 * # Why D-6 is the trickiest plugin in Wave D
 *
 * Unlike SNS, SQS, EFS, S3, SecretsManager — which only need their
 * own `KmsKeyId` field substituted — CloudWatch Logs additionally
 * requires the CMK's RESOURCE-LEVEL POLICY to grant the
 * `logs.<region>.amazonaws.com` service principal. The Wave C
 * resolver creates the CMK with default account-root-only policy, so
 * the first LogGroup apply on a given account+region must extend the
 * policy. Subsequent applies hit the per-process cache.
 *
 * # Invariants
 *
 *   I-D6-1 — DEFAULT, NEVER HIJACK: any explicit non-empty `KmsKeyId`
 *     (ARN, key id, alias) is preserved verbatim. Same contract as
 *     Wave C's primitive.
 *   I-D6-2 — KEY FORM = KEY ARN: substitutes `result.keyArn`, never
 *     `result.aliasName`. The CloudWatch Logs `KmsKeyId` field on
 *     LogGroup persists as the ARN form in CloudFormation state.
 *   I-D6-3 — POLICY GRANT: the CMK's resource policy MUST contain a
 *     statement granting `logs.<region>.amazonaws.com` the actions
 *     listed above. The pre-hook ensures this exactly once per
 *     (keyArn, region) per-process. Idempotent: re-runs see the
 *     existing grant and skip the PutKeyPolicy call.
 *   I-D6-4 — FAIL CLOSED: when the resolver throws OR the policy
 *     ensurer throws, the pre-hook returns `{ ok: false, errorMessage }`
 *     carrying the underlying error. We never silently fall back —
 *     operators learn about KMS issues now, not at AssociateKmsKey time.
 *   I-D6-5 — POLLUTION DISCIPLINE: this module emits no audit records
 *     directly; the underlying `resolveDefaultKmsKeyForApply`
 *     (alias-resolver create-path) does, but it's gated by D-0's mock
 *     boundary in tests.
 *   I-D6-6 — CACHE REUSE: two LogGroups in the same apply call share
 *     one STS round-trip + one `kms:ListAliases` per region (upstream
 *     resolver cache) AND share one policy-grant check per (keyArn,
 *     region) (this module's local cache).
 *
 * # Pre-hook contract
 *
 *   - No-op for any non-LogGroup resource type (returns `{ ok: true }`
 *     with zero AWS calls).
 *   - No-op when `desiredState["KmsKeyId"]` is a non-empty trimmed
 *     string (user value preserved verbatim — operator is responsible
 *     for the policy grant on their own CMK).
 *   - Otherwise: resolve alias-CMK → ensure policy grant → substitute
 *     key ARN.
 *   - On any error, returns `{ ok: false, errorMessage }`. CCAPI is
 *     NEVER called.
 *
 * SRP: this module changes when CloudWatch Logs default-CMK injection
 * rules change.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-default-logs-loggroup-d6.md
 * @see packages/core/src/graph/nodes/resource-provisioner/sqs-encryption.ts (parent pattern, Wave D-2)
 * @see packages/core/src/services/apply-time-kms-resolver.ts
 */

import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { resolveDefaultKmsKeyForApply } from "@/services/apply-time-kms-resolver.js";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  ensureServicePrincipalGrant,
  clearKmsServicePrincipalGrantCache,
} from "./kms-service-principal-grant.js";

/**
 * Result of the LogGroup default-CMK pre-hook. Mirrors
 * `EnsureS3DefaultKmsResult` shape so the orchestrator wires the
 * failure path identically.
 */
export type EnsureLogsDefaultKmsResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/**
 * Per-region KMSClient cache. The policy-grant cache itself lives in
 * the shared `kms-service-principal-grant` module (Wave D-7
 * refactor) so EventBridge + Logs share the cache key namespace.
 *
 * Reset hook for SaaS multi-tenant + test isolation.
 */
const logsKmsClientByRegion: Map<string, KMSClient> = new Map();

/**
 * Test/SaaS reset: clear the per-process KMSClient cache AND the
 * shared policy-grant cache. Production CLI never calls this — the
 * caches live for the apply process lifetime.
 */
export function clearLogsKmsCache(): void {
  logsKmsClientByRegion.clear();
  clearKmsServicePrincipalGrantCache();
}

/**
 * Resolve the default CMK alias for a LogGroup whose desiredState
 * lacks an explicit `KmsKeyId`, ensure the CMK's key policy grants
 * `logs.<region>.amazonaws.com`, and substitute the key ARN. Mutates
 * `desiredState` in place.
 *
 * Idempotent across multiple LogGroups in the same apply: the
 * upstream alias-resolver caches by (accountId, region) + this
 * module caches the policy-grant check by (keyArn, region).
 */
export async function ensureLogsDefaultKms(
  state: AgentState,
  desiredState: Record<string, unknown>,
  // Test seam: caller can inject a KMSClient. Production calls without
  // this and the helper instantiates per-region.
  injectedKmsClient?: KMSClient,
): Promise<EnsureLogsDefaultKmsResult> {
  if (state.resourceType !== RESOURCE_TYPES.LOGS_LOG_GROUP) {
    return { ok: true };
  }

  const explicit = desiredState[CfnKey.KMS_KEY_ID];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    // I-D6-1: user value preserved verbatim. Operator is responsible
    // for ensuring their CMK's policy grants logs.<region>.amazonaws.com.
    return { ok: true };
  }

  const region = AWS_REGION;

  let resolvedKeyArn: string;
  try {
    const result = await resolveDefaultKmsKeyForApply({
      region,
      ...(state.runId ? { runId: state.runId } : {}),
    });
    resolvedKeyArn = result.keyArn;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to resolve default Assignee KMS CMK for CloudWatch Logs encryption (${cause}). ` +
        "Either supply an explicit KmsKeyId (ARN of an existing customer-managed key " +
        "whose policy grants logs.<region>.amazonaws.com) or fix the underlying " +
        "credential / KMS access issue and retry. " +
        "If you intended to disable encryption entirely, omit KmsKeyId — CloudWatch Logs " +
        "encrypts at rest by default with an AWS-managed key.",
    };
  }

  // I-D6-3: ensure the CMK's key policy grants logs.<region>.amazonaws.com.
  // Delegated to the shared `kms-service-principal-grant` helper which
  // caches per (keyArn, region, servicePrincipal) so two LogGroups in
  // one apply share one GetKeyPolicy + at most one PutKeyPolicy.
  const kms = injectedKmsClient ?? getOrCreateKmsClient(region);
  try {
    await ensureServicePrincipalGrant({
      kms,
      keyArn: resolvedKeyArn,
      region,
      servicePrincipal: `logs.${region}.amazonaws.com`,
      sid: LOGS_GRANT_SID,
      canonicalActions: LOGS_KMS_ACTIONS,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to grant logs.${region}.amazonaws.com access to the Assignee default CMK (${cause}). ` +
        "Either supply an explicit KmsKeyId on a CMK whose policy already grants " +
        "the CloudWatch Logs service principal, or grant kms:GetKeyPolicy + kms:PutKeyPolicy " +
        "permissions to the Assignee operator role and retry.",
    };
  }

  // I-D6-2: substitute the key ARN (NOT the alias-name) — CloudWatch
  // Logs canonicalises KmsKeyId to ARN form in CloudFormation state.
  desiredState[CfnKey.KMS_KEY_ID] = resolvedKeyArn;
  return { ok: true };
}

function getOrCreateKmsClient(region: string): KMSClient {
  let client = logsKmsClientByRegion.get(region);
  if (!client) {
    client = new KMSClient({ region });
    logsKmsClientByRegion.set(region, client);
  }
  return client;
}

/**
 * Statement Sid used by Assignee for the CloudWatch Logs service
 * principal grant. Lookup is by Sid so the policy editor can see this
 * statement is Assignee-managed. Exported so the test file can pin
 * the canonical literal.
 */
export const LOGS_GRANT_SID = "AssigneeGrantCloudWatchLogs";

/**
 * Canonical KMS actions CloudWatch Logs needs on the CMK. The
 * predicate accepts a statement that lists ANY of these (or `kms:*`
 * superset) — operators may grant a broader set without confusing us.
 */
export const LOGS_KMS_ACTIONS: ReadonlyArray<string> = [
  "kms:Encrypt*",
  "kms:Decrypt*",
  "kms:ReEncrypt*",
  "kms:GenerateDataKey*",
  "kms:Describe*",
];
