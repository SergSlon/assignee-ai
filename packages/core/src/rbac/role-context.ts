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

// ── Internal constants ─────────────────────────────────────────────────

/** Valid role strings accepted from ASSIGNEE_ROLE env var (SEC-038). */
const VALID_ROLES = new Set<string>([
  ROLE_OPERATOR,
  ROLE_ADMIN,
  ROLE_READ_ONLY,
  ROLE_AUDITOR,
  ROLE_RESTRICTED,
]);

/** Dedup flag: emit the "unresolvable role" warning at most once per process. */
let _unknownRoleWarned = false;

// ── Exported API ───────────────────────────────────────────────────────

/**
 * Returns the current operator's role.
 *
 * SEC-038: reads the `ASSIGNEE_ROLE` env var so that auditor / reader
 * actions are correctly attributed in audit records, instead of always
 * recording `"operator"`. The env var is expected to be set by the MCP
 * server host or the CLI bootstrap before any audit writes.
 *
 * Fallback: when the env var is absent or resolves to an unrecognised
 * value, emits a one-time stderr warning and returns `"unknown"` so the
 * audit record is not silently mis-attributed to `"operator"`.
 *
 * Epic 101 TODO: replace with OIDC token extraction once
 * `in-memory-oidc-adapter.ts` is wired to a real IdP adapter.
 */
export function getCurrentRole(): string {
  const envRole = process.env["ASSIGNEE_ROLE"]?.trim();
  if (envRole && VALID_ROLES.has(envRole)) {
    return envRole;
  }
  if (envRole !== undefined && envRole.length > 0 && !_unknownRoleWarned) {
    _unknownRoleWarned = true;
    process.stderr.write(
      `[audit] WARNING: ASSIGNEE_ROLE="${envRole}" is not a recognised role ` +
        `(valid: ${[...VALID_ROLES].join(", ")}); recording "unknown" in audit log.\n`,
    );
    return "unknown";
  }
  // No env var set — default to "operator" (legacy scaffold behaviour).
  // Once Epic 101 is live this default should never be reached in production.
  return ROLE_OPERATOR;
}

/** @internal Reset the unknown-role warning flag — for tests only. */
export function _resetRoleContext(): void {
  _unknownRoleWarned = false;
}
