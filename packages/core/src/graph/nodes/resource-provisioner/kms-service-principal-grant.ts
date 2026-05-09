/**
 * Shared CMK key-policy ensurer for service-principal grants
 * (Wave D-7, epic-104-demo-dryrun).
 *
 * Several AWS services (CloudWatch Logs, EventBridge, etc.) refuse to
 * use a customer-managed CMK unless the CMK's resource policy
 * explicitly grants the service principal (e.g.
 * `logs.<region>.amazonaws.com`, `events.amazonaws.com`) the
 * appropriate `kms:Encrypt-star` / `Decrypt-star` / `ReEncrypt-star` /
 * `GenerateDataKey-star` / `Describe-star` actions. The Wave C
 * alias-resolver creates the CMK with default account-root-only
 * policy, so the first apply of any such service must extend the
 * policy.
 *
 * This module is the **shared primitive** that D-6 (CloudWatch Logs)
 * and D-7 (EventBridge EventBus) both consume to keep the policy
 * extension logic in one place. Earlier waves D-1 through D-5 do not
 * need a service-principal grant at all (they use plugin-native
 * encryption keys, not the CMK directly).
 *
 * # Cache
 *
 * Per-process cache by `(keyArn, region, servicePrincipal)` so:
 *   - Two LogGroups in one apply share one Get/Put per (key, region).
 *   - Two EventBus in one apply share one Get/Put per (key, region).
 *   - One LogGroup + one EventBus in one apply trigger 1 GetKeyPolicy
 *     per servicePrincipal (the GetKeyPolicy contents are the same
 *     but we re-fetch defensively because the first call might have
 *     just added a sibling-service grant via PutKeyPolicy — we want
 *     to see the latest state).
 *
 * # Predicate
 *
 * `statementGrantsServicePrincipal` short-circuits true if the
 * statement Sid matches the per-service `sidPrefix`. Otherwise checks
 * Effect=Allow, Principal.Service includes the principal (string OR
 * string[]), AND Action includes the `kms:*` superset wildcard OR at
 * least one of the canonical actions. `Effect: Deny` is correctly
 * rejected — Deny wins in AWS resolution but we still install the
 * canonical Allow so operator intent is visible alongside ours.
 *
 * # Test seam
 *
 * Caller passes a `KMSClient` so the test file can mock both
 * GetKeyPolicy and PutKeyPolicy via `aws-sdk-client-mock` style
 * stubs.
 *
 * @see packages/core/src/graph/nodes/resource-provisioner/logs-encryption.ts
 * @see packages/core/src/graph/nodes/resource-provisioner/events-encryption.ts
 */

import {
  KMSClient,
  GetKeyPolicyCommand,
  PutKeyPolicyCommand,
} from "@aws-sdk/client-kms";

/**
 * Per-process cache: `${keyArn}|${region}|${servicePrincipal}` →
 * "policy already extended for this triple". Reset via
 * `clearKmsServicePrincipalGrantCache()` for SaaS multi-tenant + tests.
 */
const grantCache = new Set<string>();

/**
 * Test/SaaS reset: clear the per-process grant cache.
 */
export function clearKmsServicePrincipalGrantCache(): void {
  grantCache.clear();
}

export interface EnsureServicePrincipalGrantOpts {
  /** KMSClient — caller-instantiated so tests can mock send(). */
  kms: KMSClient;
  /** Full KMS key ARN whose policy should be extended. */
  keyArn: string;
  /** AWS region of the key (used in the cache key for multi-region applies). */
  region: string;
  /**
   * Service principal to grant, e.g. `logs.us-east-1.amazonaws.com`
   * (region-specific) or `events.amazonaws.com` (region-agnostic).
   */
  servicePrincipal: string;
  /**
   * Sid of the new statement we add. Becomes the canonical short-circuit
   * marker on subsequent runs — operators editing the policy should NOT
   * change the Sid or the predicate stops recognising the grant.
   */
  sid: string;
  /**
   * Canonical KMS actions for this service principal. The predicate
   * accepts a statement that lists ANY of these (or `kms:*` superset)
   * — operators may grant a broader set without confusing us.
   */
  canonicalActions: ReadonlyArray<string>;
}

/**
 * Ensure the CMK's resource policy includes a statement that grants
 * `servicePrincipal` the canonical actions. Idempotent: subsequent
 * calls hit the per-process cache.
 *
 * Side effects:
 *   - At most ONE GetKeyPolicy per (keyArn, region, servicePrincipal).
 *   - AT MOST ONE PutKeyPolicy per (keyArn, region, servicePrincipal).
 *
 * Throws on any KMS-API failure (caller wraps + adds operator-actionable
 * error context).
 */
export async function ensureServicePrincipalGrant(
  opts: EnsureServicePrincipalGrantOpts,
): Promise<void> {
  const cacheKey = `${opts.keyArn}|${opts.region}|${opts.servicePrincipal}`;
  if (grantCache.has(cacheKey)) return;

  const getResp = await opts.kms.send(
    new GetKeyPolicyCommand({ KeyId: opts.keyArn, PolicyName: "default" }),
  );
  const policyDoc = getResp.Policy ?? "";
  if (policyDoc.length === 0) {
    throw new Error(
      `KMS GetKeyPolicy returned an empty policy for ${opts.keyArn}. ` +
        "This is unexpected — the Wave C alias-resolver should have created " +
        "the CMK with a default policy. Please inspect the key in AWS Console.",
    );
  }

  const policy = JSON.parse(policyDoc) as {
    Version?: string;
    Statement?: Array<{
      Sid?: string;
      Effect?: string;
      Principal?: unknown;
      Action?: string | string[];
    }>;
  };
  const statements = Array.isArray(policy.Statement) ? policy.Statement : [];

  const alreadyGranted = statements.some((s) =>
    statementGrantsServicePrincipal(
      s,
      opts.servicePrincipal,
      opts.sid,
      opts.canonicalActions,
    ),
  );
  if (alreadyGranted) {
    grantCache.add(cacheKey);
    return;
  }

  const newStatement = {
    Sid: opts.sid,
    Effect: "Allow",
    Principal: { Service: opts.servicePrincipal },
    Action: [...opts.canonicalActions],
    Resource: "*",
  };

  const newPolicy = {
    ...policy,
    Statement: [...statements, newStatement],
  };

  await opts.kms.send(
    new PutKeyPolicyCommand({
      KeyId: opts.keyArn,
      PolicyName: "default",
      Policy: JSON.stringify(newPolicy),
    }),
  );

  grantCache.add(cacheKey);
}

function statementGrantsServicePrincipal(
  statement: {
    Sid?: string;
    Effect?: string;
    Principal?: unknown;
    Action?: string | string[];
  },
  servicePrincipal: string,
  sid: string,
  canonicalActions: ReadonlyArray<string>,
): boolean {
  if (statement.Sid === sid) return true;

  if (statement.Effect !== "Allow") return false;

  const principal = statement.Principal as
    | { Service?: string | string[] }
    | undefined;
  const services = principal?.Service;
  let hasService = false;
  if (typeof services === "string") {
    hasService = services === servicePrincipal;
  } else if (Array.isArray(services)) {
    hasService = services.includes(servicePrincipal);
  }
  if (!hasService) return false;

  const actions = statement.Action;
  let hasAction = false;
  if (typeof actions === "string") {
    hasAction = actions === "kms:*" || canonicalActions.includes(actions);
  } else if (Array.isArray(actions)) {
    hasAction = actions.some(
      (a) => a === "kms:*" || canonicalActions.includes(a),
    );
  }
  return hasAction;
}
