/**
 * Setup-time ARN builders — partition-aware constructors for the IAM
 * and CloudWatch Logs ARNs that the `assignee dev setup` flow needs to
 * synthesize when configuring its own infrastructure (Bedrock logging
 * role/policy, operator user resource policies, etc.).
 *
 * These differ from `buildResourceArn` in `@assignee/core/config/arn-builder`
 * which converts a CloudControl primary identifier into a full ARN
 * for a specific CloudFormation resource type. The setup helpers
 * below operate on direct IAM primitives — role name, policy name,
 * user name, log-group name — without any CCAPI roundtrip.
 *
 * All helpers take the AWS partition as an explicit argument so the
 * caller is responsible for resolving it from the region (typically
 * via `getPartitionFromRegion`). This keeps every literal ARN
 * partition-aware per `feedback_partition_aware_arn_matching` —
 * GovCloud (`aws-us-gov`) and China (`aws-cn`) operators get the
 * right partition prefix, never the silently-wrong commercial `aws`
 * literal.
 *
 * Kept as a CLI-internal module (not exported from `@assignee/core`)
 * because no other package needs to mint setup ARNs — only the CLI
 * `setup` command flow does.
 *
 * @see Epic 54 6b LOW (backlog cleanup D)
 * @see feedback_partition_aware_arn_matching
 */

/**
 * Build an IAM role ARN for the caller's account.
 *
 * @example
 *   buildIamRoleArn({ partition: "aws", accountId: "111111111111", roleName: "MyRole" })
 *   // → "arn:aws:iam::111111111111:role/MyRole"
 */
export function buildIamRoleArn(opts: {
  partition: string;
  accountId: string;
  roleName: string;
}): string {
  const { partition, accountId, roleName } = opts;
  return `arn:${partition}:iam::${accountId}:role/${roleName}`;
}

/**
 * Build an IAM customer-managed policy ARN for the caller's account.
 *
 * @example
 *   buildIamPolicyArn({ partition: "aws", accountId: "111111111111", policyName: "MyPolicy" })
 *   // → "arn:aws:iam::111111111111:policy/MyPolicy"
 */
export function buildIamPolicyArn(opts: {
  partition: string;
  accountId: string;
  policyName: string;
}): string {
  const { partition, accountId, policyName } = opts;
  return `arn:${partition}:iam::${accountId}:policy/${policyName}`;
}

/**
 * Build an IAM user ARN for the caller's account.
 *
 * @example
 *   buildIamUserArn({ partition: "aws", accountId: "111111111111", userName: "alice" })
 *   // → "arn:aws:iam::111111111111:user/alice"
 */
export function buildIamUserArn(opts: {
  partition: string;
  accountId: string;
  userName: string;
}): string {
  const { partition, accountId, userName } = opts;
  return `arn:${partition}:iam::${accountId}:user/${userName}`;
}

/**
 * Build the IAM root principal ARN for the caller's account. Used
 * primarily as an "escape hatch" principal in resource policies so
 * the account owner can never be locked out of their own resource.
 *
 * @example
 *   buildIamRootArn({ partition: "aws", accountId: "111111111111" })
 *   // → "arn:aws:iam::111111111111:root"
 */
export function buildIamRootArn(opts: {
  partition: string;
  accountId: string;
}): string {
  const { partition, accountId } = opts;
  return `arn:${partition}:iam::${accountId}:root`;
}

/**
 * Build a CloudWatch Logs log-group ARN, optionally with the trailing
 * `:*` log-stream wildcard required by IAM policy resource segments.
 *
 * The `withStreamWildcard` flag controls the trailing `:*`:
 *   - `true` (default for IAM policy `Resource`)  → `…:log-group:<name>:*`
 *   - `false` (raw log-group ARN)                  → `…:log-group:<name>`
 *
 * @example
 *   buildLogGroupArn({ partition: "aws", region: "us-east-1", accountId: "0", logGroupName: "/x" })
 *   // → "arn:aws:logs:us-east-1:0:log-group:/x:*"
 *   buildLogGroupArn({ ..., withStreamWildcard: false })
 *   // → "arn:aws:logs:us-east-1:0:log-group:/x"
 */
export function buildLogGroupArn(opts: {
  partition: string;
  region: string;
  accountId: string;
  logGroupName: string;
  withStreamWildcard?: boolean;
}): string {
  const {
    partition,
    region,
    accountId,
    logGroupName,
    withStreamWildcard = true,
  } = opts;
  const base = `arn:${partition}:logs:${region}:${accountId}:log-group:${logGroupName}`;
  return withStreamWildcard ? `${base}:*` : base;
}
