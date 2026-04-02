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
} as const;
