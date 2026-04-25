/**
 * W3-02 (Epic 100 Round 5) — Role context.
 *
 * Returns the current operator's role name.  In the scaffold wave this is
 * hardcoded to `"operator"` because there is no OIDC token yet.  Epic 101
 * (identity-squad hire) will read the role from the validated OIDC access
 * token once `OIDCPort` has a real adapter wired to Okta / AzureAD / Auth0.
 *
 * The function is intentionally synchronous so it can be called in the
 * `appendAuditRecord` hot path without an `await`.
 */

// ── Role constants ─────────────────────────────────────────────────────

export const ROLE_OPERATOR = "operator";
export const ROLE_ADMIN = "admin";
export const ROLE_READ_ONLY = "read-only";
export const ROLE_AUDITOR = "auditor";
export const ROLE_RESTRICTED = "restricted";

// ── Exported API ───────────────────────────────────────────────────────

/**
 * Returns the current operator's role.
 *
 * Today: always returns `"operator"` (hardcoded scaffold).
 * Epic 101: reads from the validated OIDC access token.
 */
export function getCurrentRole(): string {
  // Epic 101 TODO: replace with OIDC token extraction once
  // `in-memory-oidc-adapter.ts` is wired to a real IdP adapter.
  return ROLE_OPERATOR;
}
