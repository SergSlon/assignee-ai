/**
 * Unconditional exclusion allowlist for bulk destroy.
 *
 * Every ARN matched by these patterns is EXCLUDED from `assignee destroy --all`
 * regardless of what flags the caller passes. The list covers the assignee.ai
 * self-infrastructure resources whose deletion would lock the operator out of
 * running `assignee` commands at all:
 *
 *   - Managed policy ARNs for the 3-user IAM model (operator / reader / auditor).
 *   - IAM user ARNs for the same 3 identities.
 *   - IAM roles: AssigneeOperator / AssigneeReader / AssigneeAuditor (if created).
 *   - Bedrock logging role: AssigneeAiBedrockLoggingRole.
 *
 * There is NO flag that bypasses this allowlist. That is intentional — the
 * safety guarantee only holds if the check is unconditional. See Story 50-3
 * rationale in `apps/cli/src/commands/destroy.ts` and the bulk-destroy story
 * spec at `_bmad-output/implementation-artifacts/feature-bulk-destroy-with-allowlist.md`.
 *
 * Shared between CLI (apps/cli) and MCP server (apps/mcp-server) via the
 * `@assignee/core` package so both code paths enforce the same rules.
 *
 * @see apps/cli/src/commands/setup/constants.ts  — IAM_POLICY_NAMES, BEDROCK_LOGGING_ROLE_NAME
 * @see packages/core/src/config/iam-policies/types.ts — IAM_USER_NAMES
 */

// ── Pattern constants (documented individually) ────────────────────────

/**
 * Assignee-managed IAM policy names as defined in IAM_POLICY_NAMES.
 * Operator surface is split across three policies (core + A + B) to
 * fit AWS's 6144-byte per-policy limit.
 */
const PROTECTED_POLICY_NAMES = [
  "AssigneeOperatorPolicy",
  "AssigneeOperatorServicesAPolicy",
  "AssigneeOperatorServicesBPolicy",
  "AssigneeReaderPolicy",
  "AssigneeAuditorPolicy",
] as const;

/**
 * Assignee-managed IAM user names as defined in IAM_USER_NAMES.
 * Deleting these users revokes all programmatic access from CLI / MCP.
 */
const PROTECTED_USER_NAMES = [
  "assignee-operator",
  "assignee-reader",
  "assignee-auditor",
] as const;

/**
 * Assignee-managed IAM role names. These exist when an operator has
 * run `assignee setup` with role-creation enabled.
 */
const PROTECTED_ROLE_NAMES = [
  "AssigneeOperator",
  "AssigneeReader",
  "AssigneeAuditor",
  "AssigneeAiBedrockLoggingRole",
] as const;

// ── Exclusion entry type ───────────────────────────────────────────────

export interface ExclusionEntry {
  /** Pattern matched against the resource ARN. */
  arnPattern: RegExp;
  /** Human-readable reason shown in the dry-run plan. */
  reason: string;
}

// ── Allowlist constant ─────────────────────────────────────────────────

/**
 * Unconditional exclusion allowlist for `assignee destroy --all`.
 *
 * Each entry's `arnPattern` is matched against the resource ARN via
 * `.test()`. Matching resources are excluded from the destroy plan and
 * cannot be included by any flag.
 *
 * Patterns cover:
 *   1. IAM managed policies — `arn:aws*:iam::<accountId>:policy/<name>`
 *   2. IAM users — `arn:aws*:iam::<accountId>:user/<name>`
 *   3. IAM roles — `arn:aws*:iam::<accountId>:role/<name>`
 *
 * Partition-aware: `arn:aws[\w-]*:` covers standard, GovCloud
 * (`arn:aws-us-gov:`), and China (`arn:aws-cn:`) partitions, matching
 * the convention used in the rest of the codebase.
 */
export const EXCLUSION_ALLOWLIST: ReadonlyArray<ExclusionEntry> = [
  // ── IAM Managed Policies ───────────────────────────────────────────
  ...PROTECTED_POLICY_NAMES.map(
    (name): ExclusionEntry => ({
      arnPattern: new RegExp(`^arn:aws[\\w-]*:iam::[\\d]*:policy/${name}$`),
      reason: `Assignee self-infrastructure policy (${name}) — deletion would lock out operator/reader/auditor access`,
    }),
  ),

  // ── IAM Users ─────────────────────────────────────────────────────
  ...PROTECTED_USER_NAMES.map(
    (name): ExclusionEntry => ({
      arnPattern: new RegExp(`^arn:aws[\\w-]*:iam::[\\d]*:user/${name}$`),
      reason: `Assignee self-infrastructure user (${name}) — deletion would revoke all programmatic CLI / MCP access`,
    }),
  ),

  // ── IAM Roles ─────────────────────────────────────────────────────
  ...PROTECTED_ROLE_NAMES.map(
    (name): ExclusionEntry => ({
      arnPattern: new RegExp(`^arn:aws[\\w-]*:iam::[\\d]*:role/${name}$`),
      reason: `Assignee self-infrastructure role (${name}) — deletion would break CLI execution or Bedrock logging`,
    }),
  ),
];

// ── Lookup helper ──────────────────────────────────────────────────────

/**
 * Returns the first matching exclusion entry for an ARN, or `undefined`
 * when the ARN is not in the exclusion allowlist.
 *
 * Callers should use this rather than iterating `EXCLUSION_ALLOWLIST`
 * directly — it centralises the matching semantics so future changes
 * (e.g. tag-based matching) have a single update point.
 */
export function findExclusion(arn: string): ExclusionEntry | undefined {
  return EXCLUSION_ALLOWLIST.find((entry) => entry.arnPattern.test(arn));
}

/**
 * Returns `true` when `arn` matches at least one entry in the
 * EXCLUSION_ALLOWLIST. Convenience wrapper around `findExclusion`.
 */
export function isExcluded(arn: string): boolean {
  return findExclusion(arn) !== undefined;
}
