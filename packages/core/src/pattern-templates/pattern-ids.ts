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
} as const;
