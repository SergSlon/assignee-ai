/**
 * STS operator account-id cache — poison-proof per Wave 4 (P1-R2-1).
 *
 * Policy:
 * - On success, the resolved account ID is cached for the MCP process lifetime.
 * - On failure (missing creds, STS error, timeout, undefined Account), nothing
 *   is cached — the next call retries fresh. We deliberately avoid caching the
 *   Promise across failures because a single transient STS hiccup would
 *   otherwise permanently disable the cross-account guard.
 * - `cachedOperatorAccountLookup` de-dupes concurrent in-flight lookups; it is
 *   cleared in `finally` so any subsequent call re-attempts on failure.
 *
 * Returns undefined on any failure — the caller treats undefined as "cannot
 * classify" and falls through to the conservative safe-shortcircuit behavior.
 */

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { requireAssigneeCredentials } from "@assignee/core";

let cachedOperatorAccountId: string | undefined;
let cachedOperatorAccountLookup: Promise<string | undefined> | undefined;

export function resetOperatorAccountCache(): void {
  cachedOperatorAccountId = undefined;
  cachedOperatorAccountLookup = undefined;
}

export async function getOperatorAccountId(
  region: string,
): Promise<string | undefined> {
  if (cachedOperatorAccountId !== undefined) return cachedOperatorAccountId;
  if (cachedOperatorAccountLookup) return cachedOperatorAccountLookup;

  cachedOperatorAccountLookup = (async () => {
    try {
      const sts = new STSClient({
        region,
        credentials: requireAssigneeCredentials("operator"),
      });
      const result = await Promise.race([
        sts.send(new GetCallerIdentityCommand({})),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("STS timeout")), 5_000),
        ),
      ]);
      const account = result.Account;
      if (account) {
        cachedOperatorAccountId = account;
        return account;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      // Clear the in-flight promise so failures don't poison subsequent
      // calls. Successful lookups are still served from cachedOperatorAccountId.
      cachedOperatorAccountLookup = undefined;
    }
  })();

  return cachedOperatorAccountLookup;
}
