/**
 * SNS topic default-CMK pre-provision (Wave D-3, epic-104-demo-dryrun).
 *
 * When the apply path receives an SNS topic whose desiredState
 * `KmsMasterKeyId` is missing, blank, or equals the AWS-managed
 * sentinel `"alias/aws/sns"` (the SNS plugin's default — see
 * sns-topic.ts:162 and merge.ts:151 plugin-default backfill), this
 * pre-hook resolves the alias-CMK from Wave D-0
 * (`alias/assignee-default-encryption`) and substitutes its
 * **alias name** into `KmsMasterKeyId` before the CCAPI CreateResource
 * call.
 *
 * SNS's `KmsMasterKeyId` accepts BOTH key-ARN and alias-name forms (per
 * Wave D-0 roadmap and the SNS plugin's `validate` which accepts both
 * `isArnOfService(s, "kms")` and `s.startsWith(KMS_ALIAS_PREFIX)`).
 * This module threads `result.aliasName`, NOT `result.keyArn`, so the
 * displayed / audited desiredState stays human-readable AND aligns with
 * the `alias/aws/sns` convention operators see in plan output.
 *
 * # Discriminator: AWS-managed-sentinel UPGRADE (Option A)
 *
 * Unlike D-2 (SQS), the SNS plugin's `defaults` block ships a
 * **non-empty** value for `KmsMasterKeyId` — the literal
 * `"alias/aws/sns"` (the AWS-managed SNS key alias). This satisfies
 * BP-SNS-001 (HIGH severity, FSBP SNS.1, `check_type: exists`) at
 * plan-time so operators see encryption-at-rest covered without an
 * auto-fix prompt. As a consequence, every bare-intent SNS topic
 * arrives at apply-time with `KmsMasterKeyId === "alias/aws/sns"`
 * already filled in.
 *
 * To distinguish "plugin filled the AWS-managed sentinel" from
 * "operator authored an explicit value", this hook treats the LITERAL
 * `"alias/aws/sns"` as the upgradeable sentinel:
 *
 *   - absent / blank / whitespace → substitute (defensive).
 *   - `"alias/aws/sns"` (after trim) → substitute (the sentinel).
 *   - any other non-empty value → preserve verbatim (operator wins).
 *
 * ## Escape hatch (operator wants AWS-managed SSE-SNS)
 *
 * An operator who genuinely wants the AWS-managed SSE-SNS key sets
 * `KmsMasterKeyId` to the **alias-ARN form**:
 *
 *   arn:aws:kms:<region>:<account>:alias/aws/sns
 *
 * This passes the SNS plugin's `validate` (which accepts KMS service
 * ARNs), is NOT equal to the bare literal `"alias/aws/sns"` (so this
 * hook's discriminator preserves it), and AWS CCAPI accepts it as a
 * valid KmsMasterKeyId. Documented for the rare operator who needs to
 * pin to the AWS-managed key.
 *
 * # Invariants
 *
 *   I-D3-1 — DEFAULT, NEVER HIJACK: any explicit non-empty
 *     `KmsMasterKeyId` OTHER than the literal `"alias/aws/sns"` (CMK
 *     ARN, key ID, custom alias, alias-ARN escape hatch) is preserved
 *     verbatim. Same contract as D-1/D-2.
 *   I-D3-2 — KEY FORM = ALIAS: substitutes `result.aliasName`, never
 *     `result.keyArn`. SNS accepts both forms; alias keeps audit /
 *     log readable AND aligns with the `alias/aws/sns` convention
 *     operators see in plan output.
 *   I-D3-3 — FAIL CLOSED: when the resolver throws, the pre-hook
 *     returns `{ ok: false, errorMessage }` carrying the underlying
 *     error AND mentioning `alias/aws/sns` so the operator sees the
 *     AWS-managed sentinel + the alias-ARN escape hatch. We never
 *     silently fall back to AWS-managed `alias/aws/sns` — operators
 *     learn about account-level KMS issues now, not at the next
 *     epic-04 audit.
 *   I-D3-4 — POLLUTION DISCIPLINE: this module emits no audit records
 *     directly; the underlying `resolveDefaultKmsKeyForApply`
 *     (alias-resolver create-path) does, but it's gated by D-0's mock
 *     boundary in tests.
 *   I-D3-5 — CACHE REUSE: two SNS topics in the same apply call share
 *     one STS round-trip + one `kms:ListAliases` per region (the
 *     upstream alias-resolver caches by (accountId, region)).
 *   I-D3-6 — AWS-MANAGED-SENTINEL UPGRADE: when
 *     `desiredState["KmsMasterKeyId"]` (after trim) equals the literal
 *     `"alias/aws/sns"`, this hook treats it as the plugin-default
 *     "no-operator-preference" sentinel and substitutes the Assignee
 *     default CMK. Mirrors D-2's I-D2-6 SSE-SQS skip in spirit (both
 *     encode "what does the plugin's bare-intent default mean for this
 *     hook") but with inverted shape — D-2 SKIPs the plugin default;
 *     D-3 UPGRADES it. The escape hatch for operators who genuinely
 *     want AWS-managed SSE-SNS is the alias-ARN form documented above.
 *
 * # Pre-hook contract
 *
 *   - No-op for any non-SNS resource type (returns `{ ok: true }` with
 *     zero AWS calls).
 *   - No-op when `desiredState["KmsMasterKeyId"]` is a non-empty
 *     trimmed string OTHER than `"alias/aws/sns"` (operator value
 *     preserved verbatim — I-D3-1).
 *   - Otherwise (absent / blank / `"alias/aws/sns"` sentinel) calls
 *     `resolveDefaultKmsKeyForApply` and substitutes
 *     `result.aliasName` (I-D3-6).
 *   - On resolver error, returns `{ ok: false, errorMessage }`. CCAPI
 *     is NEVER called in this case (orchestrator returns FAILED).
 *
 * # Why apply-time and not plan-time
 *
 * The wizard / plan formatter still surfaces whatever the user
 * authored OR the plugin-default `alias/aws/sns` so plan output is
 * readable / stable across runs and BP-SNS-001 stays disarmed. The
 * actual alias substitution happens once per (apply, SNS topic) at
 * provision time so the operator's plan output is not polluted with
 * account-specific defaults. Net: plan ships `alias/aws/sns`, apply
 * applies `alias/assignee-default-encryption`. The duality is
 * intentional and matches D-1/D-2.
 *
 * SRP: this module changes when SNS default-CMK injection rules change.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-default-sns-topic-d3.md
 * @see packages/core/src/graph/nodes/resource-provisioner/sqs-encryption.ts (sibling, Wave D-2)
 * @see packages/core/src/graph/nodes/resource-provisioner/s3-encryption.ts (parent pattern, Wave D-1)
 * @see packages/core/src/services/apply-time-kms-resolver.ts
 */

import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { resolveDefaultKmsKeyForApply } from "@/services/apply-time-kms-resolver.js";

/**
 * The AWS-managed SNS key alias literal that the SNS plugin's
 * `defaults` block populates (sns-topic.ts:162). When this exact
 * literal arrives as `KmsMasterKeyId` we treat it as a sentinel
 * meaning "operator expressed no preference" and upgrade it to the
 * Assignee default CMK. See I-D3-6.
 *
 * Operators who genuinely want the AWS-managed key supply the
 * alias-ARN escape hatch:
 *   `arn:aws:kms:<region>:<account>:alias/aws/sns`
 * which is NOT equal to this literal so the discriminator preserves
 * it.
 */
const SNS_AWS_MANAGED_ALIAS_SENTINEL = "alias/aws/sns";

/**
 * Result of the SNS default-CMK pre-hook. Mirrors `EnsureSqsDefaultKmsResult`
 * shape so the orchestrator wires the failure path identically.
 */
export type EnsureSnsDefaultKmsResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/**
 * Resolve the default CMK alias for an SNS topic whose desiredState
 * lacks an explicit `KmsMasterKeyId` OR carries the AWS-managed
 * `alias/aws/sns` sentinel. Mutates `desiredState` in place.
 *
 * Idempotent across multiple topics in the same apply: the upstream
 * alias-resolver caches by (accountId, region) so a second call returns
 * the same aliasName with zero additional STS / KMS round-trips.
 */
export async function ensureSnsDefaultKms(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<EnsureSnsDefaultKmsResult> {
  if (state.resourceType !== RESOURCE_TYPES.SNS_TOPIC) {
    return { ok: true };
  }

  const explicit = desiredState[CfnKey.KMS_MASTER_KEY_ID];
  if (typeof explicit === "string") {
    const trimmed = explicit.trim();
    // I-D3-1 + I-D3-6: a non-empty value that ISN'T the AWS-managed
    // sentinel is an operator-authored value (CMK ARN, custom alias,
    // alias-ARN escape hatch). Preserve verbatim. The sentinel
    // literal AND blank/whitespace fall through to the resolver path.
    if (trimmed.length > 0 && trimmed !== SNS_AWS_MANAGED_ALIAS_SENTINEL) {
      return { ok: true };
    }
  }

  let resolvedAlias: string;
  try {
    const result = await resolveDefaultKmsKeyForApply({
      region: AWS_REGION,
      ...(state.runId ? { runId: state.runId } : {}),
    });
    // I-D3-2: aliasName (e.g. "alias/assignee-default-encryption") —
    // SNS accepts alias-form so we keep desiredState human-readable
    // AND aligned with the `alias/aws/<svc>` convention operators see
    // in plan output.
    resolvedAlias = result.aliasName;
  } catch (err) {
    // I-D3-3: fail closed. Surface the underlying error message + an
    // actionable hint so the operator sees:
    //   - the AWS-managed `alias/aws/sns` sentinel (the plugin-
    //     default value they're seeing in plan output), AND
    //   - the alias-ARN escape hatch for operators who genuinely
    //     want to pin to the AWS-managed key.
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to resolve default Assignee KMS CMK for SNS topic encryption (${cause}). ` +
        "Either supply an explicit KmsMasterKeyId (a CMK ARN, an alias " +
        "of the form alias/<name>, or the AWS-managed alias-ARN form " +
        "arn:aws:kms:<region>:<account>:alias/aws/sns to pin to the " +
        "alias/aws/sns AWS-managed key) or fix the underlying " +
        "credential / KMS access issue and retry.",
    };
  }

  desiredState[CfnKey.KMS_MASTER_KEY_ID] = resolvedAlias;
  return { ok: true };
}
