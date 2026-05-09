/**
 * EventBridge Connection default-CMK pre-provision (Wave D-8, epic-104-demo-dryrun).
 *
 * When the apply path receives an EventBridge Connection whose
 * desiredState does NOT specify a `KmsKeyIdentifier`, this pre-hook:
 *
 * 1. Resolves the alias-CMK from Wave D-0
 *    (`alias/assignee-default-encryption`).
 * 2. Ensures the CMK key policy grants `events.amazonaws.com` the
 *    canonical KMS actions. EventBridge owns the underlying
 *    SecretsManager secret (per the plugin's configHint at
 *    `events-connection.ts:174`: "AuthParameters credentials are
 *    stored in a managed Secrets Manager secret on your behalf"),
 *    so the service principal that needs CMK access is EventBridge,
 *    NOT SecretsManager. Same principal as D-7 EventBus, so this
 *    consumer hits the SHARED policy-grant cache when both D-7 and
 *    D-8 fire in the same apply.
 * 3. Substitutes the **alias name** (Connection accepts alias-form
 *    via the `KmsKeyIdentifier` field).
 *
 * # Why D-8 reuses D-7's service principal
 *
 * AWS docs + EventBridge Connection's plugin behaviour both confirm
 * that EventBridge creates the underlying secret with its own service
 * identity. The CMK policy must therefore grant
 * `events.amazonaws.com`, not `secretsmanager.amazonaws.com`. D-4
 * SecretsManager (already shipped) does NOT install a service-principal
 * grant because operators interact with their secrets through
 * SecretsManager APIs using their own IAM, not via a service principal.
 *
 * # Cache reuse with D-7
 *
 * The shared `kms-service-principal-grant` cache key is
 * `(keyArn, region, servicePrincipal)`. D-7 EventBus + D-8 Connection
 * both use `events.amazonaws.com`, so:
 *   - First D-7 apply: GetKeyPolicy + (PutKeyPolicy if missing).
 *   - Subsequent D-7 OR D-8 in the same process: cache hit, zero KMS calls.
 *   - First D-8 apply (no D-7 ran): GetKeyPolicy + (Put if missing).
 *
 * # Invariants
 *
 *   I-D8-1 — DEFAULT, NEVER HIJACK: any explicit non-empty
 *     `KmsKeyIdentifier` (ARN, alias, including `alias/aws/secretsmanager`)
 *     is preserved verbatim.
 *   I-D8-2 — KEY FORM = ALIAS: substitutes `result.aliasName`, never
 *     `result.keyArn`. Connection accepts alias-form.
 *   I-D8-3 — POLICY GRANT: events.amazonaws.com (region-AGNOSTIC).
 *     Delegated to shared helper.
 *   I-D8-4 — FAIL CLOSED: resolver throw OR policy ensurer throw →
 *     fail-closed with structured error mentioning the AWS-managed
 *     escape hatches.
 *   I-D8-5 — POLLUTION DISCIPLINE.
 *   I-D8-6 — CACHE REUSE (per-(accountId, region) upstream + per-
 *     (keyArn, region, servicePrincipal) shared service-principal-grant
 *     cache, SHARED with D-7).
 *
 * # Pre-hook contract
 *
 *   - No-op for any non-Connection resource type.
 *   - No-op when `desiredState["KmsKeyIdentifier"]` is a non-empty
 *     trimmed string.
 *   - Otherwise: resolve → ensure policy grant → substitute alias.
 *   - On any error, returns `{ ok: false, errorMessage }`. CCAPI is
 *     NEVER called.
 *
 * SRP: this module changes when EventBridge Connection default-CMK
 * injection rules change.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-default-events-connection-d8.md
 * @see packages/core/src/graph/nodes/resource-provisioner/events-encryption.ts (sibling D-7)
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

export type EnsureEventsConnectionDefaultKmsResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/**
 * Per-region KMSClient cache. The policy-grant cache lives in the
 * shared `kms-service-principal-grant` module (SHARED with D-7).
 */
const eventsConnKmsClientByRegion: Map<string, KMSClient> = new Map();

/**
 * Test/SaaS reset: clear the per-process KMSClient cache + the
 * shared policy-grant cache.
 */
export function clearEventsConnectionKmsCache(): void {
  eventsConnKmsClientByRegion.clear();
  clearKmsServicePrincipalGrantCache();
}

/**
 * Statement Sid used by Assignee for the EventBridge service-principal
 * grant. SAME as D-7 — both consumers use the same canonical Sid so
 * the policy editor sees one Assignee-managed statement covering both
 * EventBus + Connection.
 */
export const EVENTS_CONNECTION_GRANT_SID = "AssigneeGrantEventBridge";

/**
 * Canonical KMS actions EventBridge needs on the CMK. SAME as D-7.
 */
export const EVENTS_CONNECTION_KMS_ACTIONS: ReadonlyArray<string> = [
  "kms:Encrypt*",
  "kms:Decrypt*",
  "kms:ReEncrypt*",
  "kms:GenerateDataKey*",
  "kms:Describe*",
];

const EVENTBRIDGE_SERVICE_PRINCIPAL = "events.amazonaws.com";

/** Same field name as D-7 — Connection uses `KmsKeyIdentifier` literal. */
const KMS_KEY_IDENTIFIER_FIELD = "KmsKeyIdentifier";

export async function ensureEventsConnectionDefaultKms(
  state: AgentState,
  desiredState: Record<string, unknown>,
  injectedKmsClient?: KMSClient,
): Promise<EnsureEventsConnectionDefaultKmsResult> {
  if (state.resourceType !== RESOURCE_TYPES.EVENTS_CONNECTION) {
    return { ok: true };
  }

  const explicit = desiredState[KMS_KEY_IDENTIFIER_FIELD];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    // I-D8-1: user value preserved verbatim (incl. AWS-managed
    // shorthand `aws/secretsmanager` or alias-ARN form).
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
        `Failed to resolve default Assignee KMS CMK for EventBridge Connection encryption (${cause}). ` +
        "Either supply an explicit KmsKeyIdentifier (the AWS-managed " +
        "alias/aws/secretsmanager, an alias of the form alias/<name>, or a CMK ARN) " +
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
      sid: EVENTS_CONNECTION_GRANT_SID,
      canonicalActions: EVENTS_CONNECTION_KMS_ACTIONS,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to grant ${EVENTBRIDGE_SERVICE_PRINCIPAL} access to the Assignee default CMK for Connection (${cause}). ` +
        "Either supply an explicit KmsKeyIdentifier on a CMK whose policy already grants " +
        "the EventBridge service principal, or grant kms:GetKeyPolicy + kms:PutKeyPolicy " +
        "permissions to the Assignee operator role and retry.",
    };
  }

  // I-D8-2: alias-name (e.g. "alias/assignee-default-encryption") —
  // Connection accepts alias-form so we keep desiredState
  // human-readable.
  desiredState[KMS_KEY_IDENTIFIER_FIELD] = resolvedAlias;
  return { ok: true };
}

function getOrCreateKmsClient(region: string): KMSClient {
  let client = eventsConnKmsClientByRegion.get(region);
  if (!client) {
    client = new KMSClient({ region });
    eventsConnKmsClientByRegion.set(region, client);
  }
  return client;
}
