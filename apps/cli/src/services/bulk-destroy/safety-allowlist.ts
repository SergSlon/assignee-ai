/**
 * IAM safety allowlist — prevents `destroy --all --include-iam` from
 * self-destructing assignee.ai's own setup-created operator infrastructure.
 *
 * Wave 5 F3 (2026-04-14, R3-D P3): uses EXACT-MATCH anchored regex on the
 * ARN's resource name (segment after the last `/`). NOT a prefix match —
 * substring matches like `AssigneeOperatorPolicyClone` would over-protect
 * attacker-squatted role names that evade `--include-iam`.
 *
 * PRESERVE this module as-is. See the tightening rationale inline below.
 */

/**
 * IAM resources that belong to assignee.ai's own operator infrastructure
 * and must NEVER be destroyed by `destroy --all --include-iam`. These are
 * created by `assignee setup` and removing them locks the user out of
 * their own AWS account / breaks every subsequent assignee command.
 *
 * Anchored regex on the ARN's resource name (the segment after the last
 * `/`). The leading `^` and trailing `$` are mandatory — a substring
 * match would over-protect roles like `MyAssigneeOperatorPolicyClone`.
 */
// A8 follow-up: added optional `Services` segment so the
// AssigneeOperatorServicesPolicy (the second half of the operator
// policy split) is also covered by the safety allowlist. Without
// this, `assignee destroy --all --include-iam` would destroy the
// services policy and lock the operator user out of every
// service-specific permission. The leading `^` and trailing `$`
// stay mandatory so substring matches like
// `MyAssigneeOperatorServicesPolicyClone` are NOT protected.
//
// (f) 2026-04-09 A/B split: the services half was split once more
// into Services-A + Services-B to fit inside the 6144-byte managed
// policy limit. The optional `[AB]?` segment matches the new names
// (AssigneeOperatorServicesAPolicy, AssigneeOperatorServicesBPolicy)
// AND keeps matching the legacy AssigneeOperatorServicesPolicy name
// so existing installations are still protected during the upgrade
// window. The trailing `$` anchor means Clone/Backup suffixes are
// still NOT protected — substring spoofing requires an exact match.
//
// W5-F3 L4 (2026-04-14, R3-D P3): tightened the Bedrock arm. The
// previous `Bedrock\w*` subpattern allowed ANY word-char suffix,
// i.e. `AssigneeBedrockEvilUser` would have landed in the allowlist
// and evaded `--include-iam` sweeps. An attacker with write access
// to IAM could squat the allowlist namespace to pin a persistence
// role against the operator's own destroy broom. Tightened to an
// explicit whitelist of known Bedrock role suffixes —
// `BedrockLoggingRole` is the only one `assignee setup` creates
// today; new ones must be added here intentionally, NOT absorbed
// silently by `\w*`. Anchors (`^`, `$`) already provide exact-name
// match on the ARN's last `/` segment; see test suite for coverage
// of `AssigneeOperator-evil` / `AssigneeOperator2` / `bedrock-evil`
// rejection paths.
const ASSIGNEE_INFRA_NAME_PATTERN =
  /^(?:Assignee(?:Ai)?(?:Operator|Reader|Auditor)?(?:Services[AB]?)?(?:Policy|Role|User|Group)?|AssigneeAiBedrockLoggingRole)$/;

/**
 * Returns true when the given ARN points at one of assignee.ai's own
 * setup-created IAM resources. Used as a safety filter in
 * planBulkDestroy so an `--include-iam` sweep cannot self-destruct
 * the operator/reader/auditor policies the CLI itself depends on.
 */
export function isAssigneeInfraResource(arn: string): boolean {
  // ARN format examples (partition-aware to cover GovCloud + China):
  //   arn:aws:iam::123:policy/AssigneeOperatorPolicy
  //   arn:aws-us-gov:iam::123:role/AssigneeAiBedrockLoggingRole
  //   arn:aws-cn:iam::123:role/AssigneeReaderPolicy
  // The literal commercial-only check that lived here through Wave 9 let
  // GovCloud / China users self-lockout via `--include-iam` because the
  // safety allowlist silently dropped through. The `[\w-]*` partition
  // segment matches `aws`, `aws-us-gov`, `aws-cn`, and any future
  // partitions AWS introduces — same convention as `isArn()` in
  // packages/core/src/config/arn-builder.ts.
  if (!/^arn:aws[\w-]*:iam::/.test(arn)) return false;
  const lastSegment = arn.split("/").pop() ?? "";
  return ASSIGNEE_INFRA_NAME_PATTERN.test(lastSegment);
}
