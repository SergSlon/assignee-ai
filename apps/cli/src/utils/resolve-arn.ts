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
 * Failures (missing credentials, STS network error) are non-fatal —
 * the function returns the bare identifier so display still works.
 * The caller can detect a failed resolution via `isArn(result)`.
 */

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { buildResourceArn, isArn } from "@assignee/core";
import { operatorCredentials } from "../config/operator-credentials.js";
import { AWS_REGION } from "../config/constants.js";

/** Module-level cache: one STS lookup per CLI process. */
let cachedAccountId: string | undefined;
let cachedAccountIdLookup: Promise<string | undefined> | undefined;

/**
 * Returns the account ID associated with the operator credentials.
 * Cached after first successful lookup. Returns undefined when:
 *   - operator credentials are not configured
 *   - STS call fails (network, throttling, AccessDenied)
 *
 * Concurrent callers share the same in-flight Promise so we never
 * issue duplicate STS calls during a single apply.
 */
export async function getOperatorAccountId(): Promise<string | undefined> {
  if (cachedAccountId !== undefined) return cachedAccountId;
  if (cachedAccountIdLookup) return cachedAccountIdLookup;

  cachedAccountIdLookup = (async () => {
    try {
      const opCreds = operatorCredentials();
      if (!opCreds.accessKeyId || !opCreds.secretAccessKey) {
        return undefined;
      }
      const sts = new STSClient({
        region: opCreds.region ?? AWS_REGION,
        credentials: {
          accessKeyId: opCreds.accessKeyId,
          secretAccessKey: opCreds.secretAccessKey,
        },
      });
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      if (identity.Account) {
        cachedAccountId = identity.Account;
        return cachedAccountId;
      }
      return undefined;
    } catch {
      return undefined;
    }
  })();

  const result = await cachedAccountIdLookup;
  // Reset the in-flight ref so a future failure can retry.
  cachedAccountIdLookup = undefined;
  return result;
}

/**
 * Resets the cached account ID. Used by tests; production code should
 * never call this — the cache is correct for the duration of one CLI
 * process and the operator credentials cannot change mid-run.
 */
export function resetAccountIdCache(): void {
  cachedAccountId = undefined;
  cachedAccountIdLookup = undefined;
}

/**
 * Resolves a CloudControl identifier into a full AWS ARN.
 *
 * - If `identifier` is already an ARN, returns it verbatim.
 * - If `resourceType` is unknown to buildResourceArn, returns the
 *   identifier verbatim.
 * - If the STS lookup fails, returns whatever buildResourceArn produces
 *   with `accountId=""`. For most types this still produces a useful
 *   region+resource ARN; for IAM/S3 it produces a malformed ARN that
 *   the caller can detect via isArn().
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

  const accountId = (await getOperatorAccountId()) ?? "";
  return buildResourceArn({
    resourceType: args.resourceType,
    identifier: args.identifier,
    region: args.region ?? AWS_REGION,
    accountId,
  });
}
