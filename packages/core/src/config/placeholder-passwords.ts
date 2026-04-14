/**
 * Placeholder password sentinels emitted by pattern templates that the user
 * MUST override before apply. Unlike random defaults, these are deterministic
 * strings so preflight can positively identify them and reject them with an
 * actionable error rather than let a known-public password reach AWS.
 *
 * Shared between:
 * - pattern-templates/patterns/three-tier-web.ts — emits the sentinel as the
 *   RDS `MasterUserPassword` default so CCAPI's 8-char validation passes at
 *   plan generation time.
 * - apps/cli preflight-guard — rejects any RDS desiredState whose password
 *   field still matches the sentinel, mirroring detectPlaceholderArn.
 */

/**
 * The RDS MasterUserPassword placeholder used by the three-tier-web pattern.
 * Any change here MUST stay in lockstep with the pattern default, otherwise
 * the guard will either miss real placeholders (false negative) or reject
 * legitimately-rotated values (false positive).
 */
export const RDS_PLACEHOLDER_PASSWORD = "ChangeMe-REPLACE-123!" as const;

/**
 * Set of every known placeholder-password sentinel. Preflight-guard walks
 * RDS desiredState and rejects the plan if any password-typed field matches
 * one of these values.
 */
export const PLACEHOLDER_DB_PASSWORDS: ReadonlySet<string> = new Set([
  RDS_PLACEHOLDER_PASSWORD,
]);

/**
 * CCAPI property names that carry a database master password for AWS::RDS::*
 * resources. Kept narrow on purpose — widening this to every field that
 * contains "Password" would false-positive on unrelated resource types
 * (e.g. DirectoryService, OpsWorks) where the sentinel is meaningless.
 */
export const RDS_PASSWORD_FIELDS: readonly string[] = [
  "MasterUserPassword", // AWS::RDS::DBInstance, AWS::RDS::DBCluster
];
