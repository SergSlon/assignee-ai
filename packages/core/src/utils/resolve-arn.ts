/**
 * resolveResourceArn — converts a CloudControl primary identifier into
 * a full AWS ARN by combining it with the operator's account ID and the
 * configured region.
 *
 * CloudControl's `GetResourceRequestStatus.ProgressEvent.Identifier`
 * returns the bare resource name for most types (BucketName, RoleName,
 * FunctionName, TableName, etc.). Without this resolver, `assignee
 * apply`'s success line displayed the bare name in the `ARN:` field —
 * which is unusable for scripting because users can't pipe it back
 * into `assignee infra destroy <arn>`.
 *
 * Closes Phase 2 smoke test BUG-5.
 *
 * The account ID lookup is cached at module level for the duration of
 * the process (a single CLI invocation). One STS GetCallerIdentity
 * call is amortized across every resource the apply produces.
 *
 * Failures (missing credentials, STS network error, STS timeout) are
 * non-fatal — the function returns undefined so the caller falls back
 * to the bare identifier. Wave 10 P1-2 added the `accountId === ""`
 * guard so a failed STS lookup never produces a malformed ARN like
 * `arn:aws:iam:::role/foo` (truthy + passes isArn() = bypasses every
 * downstream `?? state.resourceArn` fallback). Wave 10 P1-3 wrapped
 * the STS call in a 5-second timeout so a regional outage cannot stall
 * `assignee infra apply`'s display step indefinitely.
 */

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { buildResourceArn, isArn } from "../config/arn-builder.js";
import { partitionForRegion } from "../config/arn-builder.js";
import { RESOURCE_TYPES } from "../config/resource-types.js";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "../config/aws-credentials.js";
import { AWS_REGION } from "../config/constants/aws.js";
import { STS_TIMEOUT_MS } from "../config/constants/timeouts.js";
import {
  type TenantId,
  createLegacySingleTenantId,
  tenantIdToKey,
} from "../tenant/tenant-id.js";
import { TenantScopedCache } from "../tenant/tenant-scoped-cache.js";

/**
 * MASTER-008 (RW4a): per-tenant caches replacing the previous module-
 * level singletons. The previous `let cachedAccountId: string | undefined`
 * stamped tenant A's account ID into every subsequent tenant's display
 * ARN — a security and correctness regression in any multi-tenant SaaS
 * worker.
 *
 * Three caches:
 *   - `accountIdCache` — STS-resolved 12-digit account ID per tenant.
 *   - `callerArnCache` — the full caller ARN that came back with the
 *     same STS response (piggybacks; never issues a second call).
 *   - `inFlightLookup` — single-flight coalescing of concurrent
 *     {@link getOperatorAccountId} calls per tenant. Without this, two
 *     simultaneous result-formatter calls on the same tenant would
 *     each issue a separate STS call.
 */
const accountIdCache = new TenantScopedCache<string>();
const callerArnCache = new TenantScopedCache<string>();
const inFlightLookup = new Map<string, Promise<string | undefined>>();

/**
 * Returns the account ID associated with the operator credentials.
 * Cached after first successful lookup. Returns undefined when:
 *   - operator credentials are not configured (MissingAssigneeCredentialsError)
 *   - STS call fails (network, throttling, AccessDenied)
 *   - STS call exceeds STS_TIMEOUT_MS (Wave 10 P1-3)
 *   - STS returns an empty/undefined Account field (Wave 10 P1-2)
 *
 * Concurrent callers share the same in-flight Promise so we never
 * issue duplicate STS calls during a single apply.
 *
 * Wave 10 P0-2: switched from `operatorCredentials()` (which silently
 * returned empty strings) to `requireAssigneeCredentials("operator")`
 * which throws when env vars are unset. The throw is caught locally
 * so the helper still returns `undefined` rather than propagating —
 * the surface contract (undefined on failure) is preserved.
 */
export async function getOperatorAccountId(
  tenantId?: TenantId,
): Promise<string | undefined> {
  // TODO(SaaS): replace with caller-passed TenantId once
  // result-formatter / preflight-guard thread it through.
  const tid = tenantId ?? createLegacySingleTenantId();
  const cached = accountIdCache.get(tid);
  if (cached !== undefined) return cached;
  const tidKey = tenantIdToKey(tid);
  const inFlight = inFlightLookup.get(tidKey);
  if (inFlight) return inFlight;

  const lookup = (async () => {
    try {
      // Wave 10 P0-2: requireAssigneeCredentials throws
      // MissingAssigneeCredentialsError if ASSIGNEE_OPERATOR_* env
      // vars are unset. We catch the throw at the outer try and
      // return undefined — the previous code's optional credentials
      // spread silently let STSClient fall through to the default
      // AWS credential chain (`~/.aws/credentials`, instance role,
      // SSO). On a dev laptop with personal credentials configured,
      // that meant the apply success line showed an ARN derived from
      // THE WRONG ACCOUNT.
      const creds = requireAssigneeCredentials("operator");
      const sts = new STSClient({
        region: AWS_REGION,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
        },
      });

      // Wave 10 P1-3: race the STS call against a 5s timeout. STS
      // regional outages would otherwise stall the display step
      // indefinitely because the SDK's default retry strategy can
      // wait minutes before giving up.
      //
      // Epic 49 review HIGH-3 (EX-7 pattern from whoami.ts): the
      // timer handle must be cleared when STS wins the race so the
      // event loop isn't pinned for the remaining ~5s.
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(
                `STS GetCallerIdentity timed out after ${STS_TIMEOUT_MS}ms`,
              ),
            ),
          STS_TIMEOUT_MS,
        );
      });
      let identity;
      try {
        identity = await Promise.race([
          sts.send(new GetCallerIdentityCommand({})),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      if (identity.Account) {
        accountIdCache.set(tid, identity.Account);
        if (identity.Arn) {
          callerArnCache.set(tid, identity.Arn);
        }
        return identity.Account;
      }
      return undefined;
    } catch (err) {
      // MissingAssigneeCredentialsError, network failures, throttling,
      // AccessDenied, and the timeout above all collapse to undefined.
      // resolveResourceArn turns that into a fallback to the bare
      // identifier in the caller's display path.
      if (err instanceof MissingAssigneeCredentialsError) return undefined;
      return undefined;
    }
  })();

  inFlightLookup.set(tidKey, lookup);
  try {
    return await lookup;
  } finally {
    // Reset the in-flight ref so a future failure can retry.
    inFlightLookup.delete(tidKey);
  }
}

/**
 * Returns the full caller ARN from the STS GetCallerIdentity response
 * (e.g. `arn:aws:iam::210987654321:user/assignee-operator`).
 *
 * Piggybacks on the same STS call as getOperatorAccountId — no extra
 * network request. Returns undefined when:
 *   - operator credentials are not configured
 *   - STS call fails or times out
 *   - STS returned an Account but no Arn (shouldn't happen in practice)
 *
 * Used by preflight-guard to supply `policy_source_arn` to the IAM MCP
 * server's `simulate_principal_policy` tool, which requires it.
 */
export async function getOperatorCallerArn(
  tenantId?: TenantId,
): Promise<string | undefined> {
  const tid = tenantId ?? createLegacySingleTenantId();
  const cached = callerArnCache.get(tid);
  if (cached !== undefined) return cached;
  // Trigger the STS lookup if it hasn't happened yet — this populates
  // callerArnCache as a side-effect of the same STS call that resolves
  // the account ID.
  await getOperatorAccountId(tid);
  return callerArnCache.get(tid);
}

/**
 * Resets the cached account ID and caller ARN. Used by tests; production
 * code should never call this — the cache is correct for the duration of
 * one CLI process and the operator credentials cannot change mid-run.
 *
 * Tenant-scoped: pass `tenantId` to evict only that tenant's caches.
 * No argument → wipe every tenant. Existing tests call this with no
 * argument between cases (`resolve-arn.test.ts`,
 * `preflight-guard.test.ts`), which still works.
 */
export function resetAccountIdCache(tenantId?: TenantId): void {
  if (tenantId) {
    accountIdCache.clear(tenantId);
    callerArnCache.clear(tenantId);
    inFlightLookup.delete(tenantIdToKey(tenantId));
  } else {
    accountIdCache.clear();
    callerArnCache.clear();
    inFlightLookup.clear();
  }
}

/**
 * Resolves a CloudControl identifier into a full AWS ARN.
 *
 * - If `identifier` is already an ARN, returns it verbatim.
 * - If `resourceType` is unknown to buildResourceArn, returns the
 *   identifier verbatim.
 * - If the STS lookup fails (missing creds, timeout, AccessDenied,
 *   network error, empty Account), returns `undefined` so the caller
 *   falls back to the bare identifier. Wave 10 P1-2 made this branch
 *   strict — the previous code passed `accountId=""` to buildResourceArn
 *   which produced malformed ARNs like `arn:aws:iam:::role/foo` that
 *   were truthy AND passed `isArn()`, bypassing every downstream
 *   `?? state.resourceArn` fallback in result-formatter.ts.
 *
 * Pass `region` explicitly when known (e.g. from desiredState); falls
 * back to the configured AWS_REGION constant otherwise.
 */
export async function resolveResourceArn(args: {
  resourceType: string;
  identifier: string | undefined;
  region?: string;
  tenantId?: TenantId;
}): Promise<string | undefined> {
  if (!args.identifier) return undefined;
  if (isArn(args.identifier)) return args.identifier;

  const accountId = await getOperatorAccountId(args.tenantId);
  // Wave 10 P1-2: strict guard. Previously this fell through to
  // buildResourceArn with accountId="" which produced malformed ARNs.
  // Returning undefined here lets the caller's `?? state.resourceArn`
  // fire correctly and surface the bare identifier instead.
  if (!accountId) return undefined;

  const region = args.region ?? AWS_REGION;
  const built = buildResourceArn({
    resourceType: args.resourceType,
    identifier: args.identifier,
    region,
    accountId,
  });

  // Epic 92 Wave 1 (e92.1.b): buildResourceArn returns the identifier
  // unchanged for types whose ARN template is not registered in
  // arn-templates.ts. Historically this meant:
  //   - KMS::Key        → UUID (D-22)
  //   - Events::EventBus→ bus name (D-20)
  // which surfaced as the bare primary identifier in the apply success
  // line and got stamped into the provision record as the "ARN" — so
  // the user couldn't pipe that value back into `assignee infra destroy`
  // (nor could billing / security posture resolve it).
  //
  // Synthesize the canonical ARN locally for these types when the
  // upstream template registry returns the identifier unchanged and it
  // still isn't a full ARN. Kept narrow (two known types) so we don't
  // fabricate ARNs for future types that deliberately have no template.
  if (built === args.identifier && !isArn(built)) {
    const partition = partitionForRegion(region);
    if (args.resourceType === RESOURCE_TYPES.KMS_KEY) {
      // arn:<partition>:kms:<region>:<account>:key/<KeyId-uuid>
      return `arn:${partition}:kms:${region}:${accountId}:key/${args.identifier}`;
    }
    if (args.resourceType === RESOURCE_TYPES.EVENTS_EVENT_BUS) {
      // arn:<partition>:events:<region>:<account>:event-bus/<Name>
      return `arn:${partition}:events:${region}:${accountId}:event-bus/${args.identifier}`;
    }
  }
  return built;
}
