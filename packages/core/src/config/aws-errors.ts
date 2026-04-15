/**
 * aws-errors.ts — structured AWS SDK error classifiers.
 *
 * AWS SDK v3 surfaces errors via well-defined fields: `err.name`, `err.Code`
 * (legacy v2 shape), and `err.$metadata.httpStatusCode`. Historically the
 * codebase has been using substring matching on the error message (e.g.
 * `err.message.includes("AccessDenied")`). That approach is brittle:
 *
 *   - It false-matches resource names like "user-not-authorized-policy".
 *   - It silently misses localized AWS error strings.
 *   - It conflates unrelated errors whose messages happen to share keywords.
 *
 * These helpers replace all substring matching in the CLI and MCP packages
 * with structured code/HTTP-status checks. The 5-code AccessDenied set was
 * introduced in Wave 2 F5 for preflight; Wave 4 F2 promotes it to a shared
 * helper so every site sees the same classification.
 *
 * @see feedback_fix_all_issues, feedback_partition_aware_arn_matching
 */

/**
 * AWS SDK error codes that indicate the caller lacks IAM permission for a
 * specific operation or resource. All five shapes appear in practice:
 *
 *  - `AccessDenied` / `AccessDeniedException` — standard (S3, IAM, etc.)
 *  - `UnauthorizedOperation` — EC2 / VPC (DescribeAddresses, RunInstances)
 *  - `AuthFailure` — EC2 signing/credential issue *on a specific call*
 *    (note: `AuthFailure` also appears on expired tokens at the session
 *    layer; we include it here because per-call EC2 AuthFailure is almost
 *    always IAM-scoped — the session-level variant is still caught by the
 *    auth-failure classifier via HTTP 401 or ExpiredToken siblings).
 *  - `Forbidden` — generic HTTP 403 wrapper
 *  - `OperationNotPermitted` — EC2 variant for NACL / allocation limits
 */
const ACCESS_DENIED_CODES: ReadonlySet<string> = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "UnauthorizedOperation",
  "AuthFailure",
  "Forbidden",
  "OperationNotPermitted",
]);

/**
 * Session-level authentication failures. These indicate the whole credential
 * set is unusable — unlike AccessDenied (which is per-resource / per-action),
 * an auth failure means no subsequent API call will succeed without a
 * credential refresh.
 *
 *  - `ExpiredToken` / `ExpiredTokenException` — STS temporary creds expired
 *  - `InvalidClientTokenId` — unknown access-key ID (typo, revoked key)
 *  - `SignatureDoesNotMatch` — secret-key mismatch
 *  - `TokenRefreshRequired` — SSO / role-chained creds need refresh
 *  - HTTP 401 — generic unauthorized
 */
const AUTH_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "TokenRefreshRequired",
]);

/**
 * Throttling / rate-limit error codes. These are retryable with backoff,
 * unlike the fail-fast categories above.
 */
const THROTTLING_CODES: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "Throttling",
  "TooManyRequestsException",
  "RequestLimitExceeded",
  "RequestThrottled",
  "RequestThrottledException",
  "SlowDown",
]);

/**
 * Extracts the structured error shape from an arbitrary thrown value.
 *
 * Handles:
 *  - SDK v3 error objects (`err.name`, `err.$metadata.httpStatusCode`)
 *  - SDK v2 legacy shape (`err.Code`)
 *  - Wrapped response forms (`err.$response.body.Code`) — some older
 *    code paths re-throw the raw XML-parsed body.
 *  - Plain objects from middleware layers (`err.code` lowercase)
 */
function extractErrorShape(err: unknown): {
  name: string;
  code: string;
  httpStatus: number | undefined;
} {
  if (!err || typeof err !== "object") {
    return { name: "", code: "", httpStatus: undefined };
  }
  const e = err as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    $response?: { body?: { Code?: unknown } };
    statusCode?: unknown;
  };
  const name = typeof e.name === "string" ? e.name : "";
  const code =
    (typeof e.Code === "string" && e.Code) ||
    (typeof e.code === "string" && e.code) ||
    (e.$response?.body &&
      typeof e.$response.body.Code === "string" &&
      e.$response.body.Code) ||
    "";
  const rawStatus =
    (typeof e.$metadata?.httpStatusCode === "number" &&
      e.$metadata.httpStatusCode) ||
    (typeof e.statusCode === "number" && e.statusCode) ||
    undefined;
  return {
    name,
    code,
    httpStatus: rawStatus === undefined ? undefined : Number(rawStatus),
  };
}

/**
 * True when the given error indicates the caller lacks IAM permission for
 * a specific operation (i.e. credentials work, but this action/resource
 * is denied). HTTP 403 is also treated as AccessDenied.
 *
 * Does NOT match on error message substrings — use `err.name` / `err.Code`
 * only. See module docstring for rationale.
 */
export function isAccessDeniedError(err: unknown): boolean {
  const { name, code, httpStatus } = extractErrorShape(err);
  if (name && ACCESS_DENIED_CODES.has(name)) return true;
  if (code && ACCESS_DENIED_CODES.has(code)) return true;
  if (httpStatus === 403) return true;
  return false;
}

/**
 * True when the given error indicates the entire credential session is
 * unusable (expired token, invalid access key, bad signature). Callers
 * should fail closed — no subsequent AWS call will succeed until the
 * user refreshes creds.
 */
export function isAuthFailureError(err: unknown): boolean {
  const { name, code, httpStatus } = extractErrorShape(err);
  if (name && AUTH_FAILURE_CODES.has(name)) return true;
  if (code && AUTH_FAILURE_CODES.has(code)) return true;
  if (httpStatus === 401) return true;
  return false;
}

/**
 * True when the given error is an AWS throttling / rate-limit response.
 * Callers should retry with exponential backoff.
 */
export function isThrottlingError(err: unknown): boolean {
  const { name, code, httpStatus } = extractErrorShape(err);
  if (name && THROTTLING_CODES.has(name)) return true;
  if (code && THROTTLING_CODES.has(code)) return true;
  if (httpStatus === 429) return true;
  return false;
}
