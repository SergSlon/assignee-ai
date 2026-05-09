/**
 * EventBridge EventBus default-CMK pre-provision (Wave D-7, epic-104-demo-dryrun).
 *
 * When the apply path receives an EventBridge EventBus whose
 * desiredState does NOT specify a `KmsKeyIdentifier`, this pre-hook:
 *
 * 1. Resolves the alias-CMK from Wave D-0
 *    (`alias/assignee-default-encryption`).
 * 2. Ensures the CMK key policy grants `events.amazonaws.com` the
 *    canonical KMS actions (delegated to the shared
 *    `ensureServicePrincipalGrant` helper introduced in this wave).
 * 3. Substitutes the **alias name** (EventBridge accepts alias-form
 *    via the `KmsKeyIdentifier` field — alias resolves at AWS service
 *    invocation time).
 *
 * # Why D-7 needed a service-principal grant + the shared refactor
 *
 * Like CloudWatch Logs (D-6), EventBridge requires the CMK's resource
 * policy to grant a service principal (`events.amazonaws.com`) the
 * `kms:Encrypt-star / Decrypt-star / ReEncrypt-star /
 * GenerateDataKey-star / Describe-star` actions. D-7 reuses the
 * shared `ensureServicePrincipalGrant` helper extracted from D-6 so
 * both consumers share the cache + predicate semantics.
 *
 * Note: `events.amazonaws.com` is REGION-AGNOSTIC, unlike Logs's
 * `logs.<region>.amazonaws.com`. The shared helper handles this
 * transparently because the cache key includes the principal string
 * verbatim.
 *
 * # Invariants
 *
 *   I-D7-1 — DEFAULT, NEVER HIJACK: any explicit non-empty
 *     `KmsKeyIdentifier` (ARN, alias) is preserved verbatim. Same
 *     contract as Wave C's primitive.
 *   I-D7-2 — KEY FORM = ALIAS: substitutes `result.aliasName`, never
 *     `result.keyArn`. EventBridge accepts alias-form so the
 *     substituted value stays human-readable and aligns with the
 *     `alias/aws/events` convention operators already know.
 *   I-D7-3 — POLICY GRANT: the CMK's resource policy MUST contain a
 *     statement granting `events.amazonaws.com`. Delegated to the
 *     shared helper; cached per (keyArn, region, servicePrincipal).
 *   I-D7-4 — FAIL CLOSED: when the resolver throws OR the policy
 *     ensurer throws, the pre-hook returns `{ ok: false, errorMessage }`
 *     mentioning `alias/aws/events` (the AWS-managed escape hatch).
 *   I-D7-5 — POLLUTION DISCIPLINE: this module emits no audit records
 *     directly; the underlying `resolveDefaultKmsKeyForApply`
 *     (alias-resolver create-path) does, but it's gated by D-0's mock
 *     boundary in tests.
 *   I-D7-6 — CACHE REUSE: two EventBus in the same apply call share
 *     one STS round-trip + one `kms:ListAliases` per region (upstream
 *     resolver cache) AND share one Get/PutKeyPolicy per (keyArn,
 *     region, principal) (shared service-principal-grant cache).
 *
 * # Pre-hook contract
 *
 *   - No-op for any non-EventBus resource type (returns `{ ok: true }`
 *     with zero AWS calls).
 *   - No-op when `desiredState["KmsKeyIdentifier"]` is a non-empty
 *     trimmed string (user value preserved verbatim — including any
 *     `alias/aws/events` escape hatch).
 *   - Otherwise: resolve alias-CMK → ensure policy grant → substitute
 *     alias-name.
 *   - On any error, returns `{ ok: false, errorMessage }`. CCAPI is
 *     NEVER called.
 *
 * SRP: this module changes when EventBridge default-CMK injection
 * rules change.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-default-events-eventbus-d7.md
 * @see packages/core/src/graph/nodes/resource-provisioner/logs-encryption.ts (sibling, Wave D-6)
 * @see packages/core/src/graph/nodes/resource-provisioner/kms-service-principal-grant.ts (shared helper)
 */

import { RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { resolveDefaultKmsKeyForApply } from "@/services/apply-time-kms-resolver.js";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  ensureServicePrincipalGrant,
  clearKmsServicePrincipalGrantCache,
} from "./kms-service-principal-grant.js";

/**
 * Result of the EventBus default-CMK pre-hook. Mirrors
 * `EnsureS3DefaultKmsResult` shape so the orchestrator wires the
 * failure path identically.
 */
export type EnsureEventsDefaultKmsResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/**
 * Per-region KMSClient cache. The policy-grant cache lives in the
 * shared `kms-service-principal-grant` module.
 */
const eventsKmsClientByRegion: Map<string, KMSClient> = new Map();

/**
 * Test/SaaS reset: clear the per-process KMSClient cache + the
 * shared policy-grant cache.
 */
export function clearEventsKmsCache(): void {
  eventsKmsClientByRegion.clear();
  clearKmsServicePrincipalGrantCache();
}

/**
 * Statement Sid used by Assignee for the EventBridge service-principal
 * grant. Lookup is by Sid so the policy editor can see this statement
 * is Assignee-managed.
 */
export const EVENTS_GRANT_SID = "AssigneeGrantEventBridge";

/**
 * Canonical KMS actions EventBridge needs on the CMK. The shared
 * predicate accepts a statement that lists ANY of these (or `kms:*`
 * superset).
 */
export const EVENTS_KMS_ACTIONS: ReadonlyArray<string> = [
  "kms:Encrypt*",
  "kms:Decrypt*",
  "kms:ReEncrypt*",
  "kms:GenerateDataKey*",
  "kms:Describe*",
];

/**
 * EventBridge service principal — REGION-AGNOSTIC (unlike Logs's
 * region-specific `logs.<region>.amazonaws.com`).
 */
const EVENTBRIDGE_SERVICE_PRINCIPAL = "events.amazonaws.com";

/**
 * Field name on AWS::Events::EventBus desiredState that holds the
 * customer KMS key identifier. NOT a `CfnKey` constant — the plugin
 * uses a literal string at `events-eventbus.ts:75`.
 */
const KMS_KEY_IDENTIFIER_FIELD = "KmsKeyIdentifier";

/**
 * Resolve the default CMK alias for an EventBus whose desiredState
 * lacks an explicit `KmsKeyIdentifier`, ensure the CMK's key policy
 * grants `events.amazonaws.com`, and substitute the alias name.
 * Mutates `desiredState` in place.
 *
 * Idempotent across multiple EventBus in the same apply.
 */
export async function ensureEventsDefaultKms(
  state: AgentState,
  desiredState: Record<string, unknown>,
  injectedKmsClient?: KMSClient,
): Promise<EnsureEventsDefaultKmsResult> {
  if (state.resourceType !== RESOURCE_TYPES.EVENTS_EVENT_BUS) {
    return { ok: true };
  }

  const explicit = desiredState[KMS_KEY_IDENTIFIER_FIELD];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    // I-D7-1: user value preserved verbatim.
    return { ok: true };
  }

  const region = AWS_REGION;

  let resolvedAlias: string;
  let resolvedKeyArn: string;
  try {
    const result = await resolveDefaultKmsKeyForApply({
      region,
      ...(state.runId ? { runId: state.runId } : {}),
    });
    resolvedAlias = result.aliasName;
    resolvedKeyArn = result.keyArn;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to resolve default Assignee KMS CMK for EventBridge EventBus encryption (${cause}). ` +
        "Either supply an explicit KmsKeyIdentifier (the AWS-managed " +
        "alias/aws/events, an alias of the form alias/<name>, or a CMK ARN) " +
        "or fix the underlying credential / KMS access issue and retry.",
    };
  }

  const kms = injectedKmsClient ?? getOrCreateKmsClient(region);
  try {
    await ensureServicePrincipalGrant({
      kms,
      keyArn: resolvedKeyArn,
      region,
      servicePrincipal: EVENTBRIDGE_SERVICE_PRINCIPAL,
      sid: EVENTS_GRANT_SID,
      canonicalActions: EVENTS_KMS_ACTIONS,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to grant ${EVENTBRIDGE_SERVICE_PRINCIPAL} access to the Assignee default CMK (${cause}). ` +
        "Either supply an explicit KmsKeyIdentifier on a CMK whose policy already grants " +
        "the EventBridge service principal, or grant kms:GetKeyPolicy + kms:PutKeyPolicy " +
        "permissions to the Assignee operator role and retry.",
    };
  }

  // I-D7-2: alias-name (e.g. "alias/assignee-default-encryption") —
  // EventBridge accepts alias-form so we keep desiredState
  // human-readable.
  desiredState[KMS_KEY_IDENTIFIER_FIELD] = resolvedAlias;
  return { ok: true };
}

function getOrCreateKmsClient(region: string): KMSClient {
  let client = eventsKmsClientByRegion.get(region);
  if (!client) {
    client = new KMSClient({ region });
    eventsKmsClientByRegion.set(region, client);
  }
  return client;
}
