/**
 * Canonical pattern identifier constants — single source of truth.
 * Use instead of raw string literals like "serverless-api".
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const PatternId = {
  /**
   * CP-1: bare SQS queue that explicitly requests a companion DLQ via
   * "with DLQ" / "with dead-letter queue" / "dead letter queue" phrasing.
   * 2-resource compound: primary AWS::SQS::Queue + DLQ companion with
   * RedrivePolicy.deadLetterTargetArn wired via markerGetAtt.
   */
  SQS_WITH_DLQ: "sqs-with-dlq",
  /**
   * CP-2 / PH1-C-2: SNS Topic + Email Subscription compound. Routes intents
   * containing "with email subscription to <email>" or "with subscriber
   * <email>" to a 2-resource compound (AWS::SNS::Topic +
   * AWS::SNS::Subscription with Protocol=email). Email is extracted by
   * email-extractor.ts using a conservative regex; invalid emails fall
   * through to the bare SNS path with an advisory.
   */
  SNS_WITH_EMAIL_SUBSCRIPTION: "sns-with-email-subscription",
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
  /**
   * Epic 92 wave 2.b: API Gateway v2 WebSocket compound pattern.
   * Mirrors the serverless-api pattern shape but for the WebSocket
   * protocol — same 8 resource slots (IAM Role + Lambda + LogGroup +
   * API + Integration + Route + Stage + Permission) with two
   * structural differences: (a) ProtocolType is WEBSOCKET not HTTP,
   * (b) three Routes ($connect, $disconnect, $default) each with
   * their own Integration pointing at the same Lambda. Closes C-10
   * ("no compound answer for WebSocket intents") and the
   * serverless-api/WebSocket collision half of C-06.
   */
  WEBSOCKET_API: "websocket-api",
} as const;
