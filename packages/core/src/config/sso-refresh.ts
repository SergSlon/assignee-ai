/**
 * SSO session expiry detection and actionable hint generation.
 *
 * AWS SDK v3 surfaces SSO / STS expiry as errors with recognisable codes.
 * Without interception these produce opaque "ExpiredTokenException" messages.
 * This module normalizes them into a user-facing hint that tells the operator
 * exactly what command to run.
 *
 * @see W2-02 — AWS_PROFILE via provider chain (Epic 100)
 * @see feedback_bedrock_region_error_hints.md — precedent for error wrapping
 */

/** Error codes emitted by AWS SDK v3 for expired / invalid sessions. */
const SSO_EXPIRY_CODES = new Set([
  "ExpiredTokenException",
  "ExpiredToken",
  "TokenRefreshRequired",
  "InvalidClientTokenId",
  "InvalidIdentityToken",
  "AuthorizationPendingException",
]);

/** HTTP status codes that indicate credential expiry. */
const AUTH_HTTP_STATUSES = new Set([401, 403]);

/**
 * Returns true when `err` looks like an expired or invalid SSO / STS token.
 *
 * Checks:
 *   - `error.name` or `error.Code` matching known expiry error codes.
 *   - `error.$metadata?.httpStatusCode` being 401 or 403.
 *   - `error.message` containing canonical AWS error phrases.
 */
export function isSsoExpiryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // AWS SDK v3 attaches `name` for service exceptions.
  if (SSO_EXPIRY_CODES.has(err.name)) return true;

  // Some older SDK surfaces use `.Code` on the error.
  const errAsObj = err as unknown as Record<string, unknown>;
  const code = errAsObj["Code"];
  if (typeof code === "string" && SSO_EXPIRY_CODES.has(code)) return true;

  // HTTP status check via SDK metadata.
  const meta = errAsObj["$metadata"] as Record<string, unknown> | undefined;
  if (meta) {
    const status = meta["httpStatusCode"];
    if (typeof status === "number" && AUTH_HTTP_STATUSES.has(status)) {
      return true;
    }
  }

  // Phrase matching for STS / SSO SDK error messages.
  const msg = err.message.toLowerCase();
  return (
    msg.includes("expired token") ||
    msg.includes("token has expired") ||
    msg.includes("security token included in the request is expired") ||
    msg.includes("sso token is expired") ||
    msg.includes("the sso session associated with this profile has expired")
  );
}

/**
 * Builds an actionable error message for SSO / STS session expiry.
 *
 * @param profile - The profile name that was active when expiry occurred.
 *   If undefined, generic refresh instructions are emitted.
 * @param originalMessage - The raw SDK error message, appended for context.
 */
export function buildSsoRefreshHint(
  profile: string | undefined,
  originalMessage: string,
): string {
  const profileFlag = profile ? ` --profile ${profile}` : "";
  const loginCmd = `aws sso login${profileFlag}`;
  const exportCmd = profile
    ? `eval $(aws configure export-credentials --profile ${profile} --format env)`
    : "eval $(aws configure export-credentials --format env)";

  return (
    `Session expired or invalid — run the following to refresh:\n` +
    `  ${loginCmd}\n` +
    `\n` +
    `Then re-export credentials for this session:\n` +
    `  ${exportCmd}\n` +
    `\n` +
    `Original error: ${originalMessage}`
  );
}

/**
 * Wraps an error in a new Error with the SSO refresh hint if `isSsoExpiryError`
 * returns true. Otherwise re-throws the original error unchanged.
 *
 * Intended for wrapping AWS SDK calls in command handlers:
 *
 * ```ts
 * try {
 *   await client.send(command);
 * } catch (err) {
 *   throw wrapSsoExpiryError(err, profile);
 * }
 * ```
 */
export function wrapSsoExpiryError(err: unknown, profile?: string): Error {
  if (!isSsoExpiryError(err)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const original = err instanceof Error ? err.message : String(err);
  const hint = buildSsoRefreshHint(profile, original);
  const wrapped = new Error(hint);
  wrapped.name = "SsoSessionExpiredError";
  return wrapped;
}
