/**
 * Canonical pattern identifier constants — single source of truth.
 * Use instead of raw string literals like "serverless-api".
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const PatternId = {
  SERVERLESS_API: "serverless-api",
  THREE_TIER_WEB: "three-tier-web",
  CONTAINER_SERVICE: "container-service",
  MESSAGE_PROCESSING: "message-processing",
  STATIC_WEBSITE: "static-website",
  /**
   * Wave 13: minimal Lambda + IAM exec role companion. Closes the
   * Phase 2 lifecycle smoke test gap where bare "create a Lambda"
   * intents required `--set Role=arn:aws:iam::ACCOUNT:role/...`
   * because no compound pattern matched. With this pattern, any
   * Lambda-flavored intent that doesn't match the larger
   * serverless-api pattern auto-creates a minimal exec role.
   */
  LAMBDA_WITH_EXEC_ROLE: "lambda-with-exec-role",
  /**
   * EFS FileSystem + VPC compound. Bare "create an EFS file system"
   * intents need a full VPC topology (2 private subnets across 2 AZs,
   * a dedicated NFS security group, one MountTarget per AZ) because
   * EFS is reached by NFS mount from workloads inside the VPC — there
   * is no useful single-resource EFS plan. This pattern bundles the
   * network + file system + mount targets so the first-run experience
   * matches the promise of "natural language → running".
   */
  EFS_WITH_VPC: "efs-with-vpc",
  /**
   * Scheduled Lambda (cron Lambda) pattern. A Lambda function that
   * fires on a time-based schedule via EventBridge. 4 resources:
   * IAM exec role, Lambda function, Events::Rule with
   * ScheduleExpression + inline Target, and a display-only
   * Lambda::Permission granting events.amazonaws.com invoke.
   * Unblocks "scheduled lambda" / "cron lambda" intents that
   * previously had no compound answer.
   */
  SCHEDULED_LAMBDA: "scheduled-lambda",
} as const;
