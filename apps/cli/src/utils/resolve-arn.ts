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
 * into `assignee destroy <arn>`.
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
 * `assignee apply`'s display step indefinitely.
 */

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  buildResourceArn,
  isArn,
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "@assignee/core";
import { AWS_REGION } from "../config/constants.js";
import { STS_TIMEOUT_MS } from "../config/constants/timeouts.js";

/** Module-level cache: one STS lookup per CLI process. */
let cachedAccountId: string | undefined;
let cachedCallerArn: string | undefined;
let cachedAccountIdLookup: Promise<string | undefined> | undefined;

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
export async function getOperatorAccountId(): Promise<string | undefined> {
  if (cachedAccountId !== undefined) return cachedAccountId;
  if (cachedAccountIdLookup) return cachedAccountIdLookup;

  cachedAccountIdLookup = (async () => {
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
      const identity = await Promise.race([
        sts.send(new GetCallerIdentityCommand({})),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `STS GetCallerIdentity timed out after ${STS_TIMEOUT_MS}ms`,
                ),
              ),
            STS_TIMEOUT_MS,
          ),
        ),
      ]);

      if (identity.Account) {
        cachedAccountId = identity.Account;
        if (identity.Arn) {
          cachedCallerArn = identity.Arn;
        }
        return cachedAccountId;
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

  const result = await cachedAccountIdLookup;
  // Reset the in-flight ref so a future failure can retry.
  cachedAccountIdLookup = undefined;
  return result;
}

/**
 * Returns the full caller ARN from the STS GetCallerIdentity response
 * (e.g. `arn:aws:iam::054125018476:user/assignee-operator`).
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
export async function getOperatorCallerArn(): Promise<string | undefined> {
  if (cachedCallerArn !== undefined) return cachedCallerArn;
  // Trigger the STS lookup if it hasn't happened yet — this populates
  // cachedCallerArn as a side-effect.
  await getOperatorAccountId();
  return cachedCallerArn;
}

/**
 * Resets the cached account ID and caller ARN. Used by tests; production
 * code should never call this — the cache is correct for the duration of
 * one CLI process and the operator credentials cannot change mid-run.
 */
export function resetAccountIdCache(): void {
  cachedAccountId = undefined;
  cachedCallerArn = undefined;
  cachedAccountIdLookup = undefined;
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
}): Promise<string | undefined> {
  if (!args.identifier) return undefined;
  if (isArn(args.identifier)) return args.identifier;

  const accountId = await getOperatorAccountId();
  // Wave 10 P1-2: strict guard. Previously this fell through to
  // buildResourceArn with accountId="" which produced malformed ARNs.
  // Returning undefined here lets the caller's `?? state.resourceArn`
  // fire correctly and surface the bare identifier instead.
  if (!accountId) return undefined;

  return buildResourceArn({
    resourceType: args.resourceType,
    identifier: args.identifier,
    region: args.region ?? AWS_REGION,
    accountId,
  });
}
