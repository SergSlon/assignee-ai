import { SUPPORTED_TYPES_ARRAY } from "@assignee/core";

export const BEDROCK_MODEL_ID =
  process.env["BEDROCK_MODEL_ID"] ?? "us.amazon.nova-lite-v1:0";

export const AWS_REGION = process.env["AWS_REGION"] ?? "us-east-1";

// packages/core is the single source of truth for supported resource types (Story 9.1)
export { SUPPORTED_TYPES_ARRAY as SUPPORTED_TYPES } from "@assignee/core";

/** Human-readable hint shown when an unsupported resource type is requested. */
export const SUPPORTED_TYPES_HINT = `Supported types: ${SUPPORTED_TYPES_ARRAY.join(", ")}`;

/** Maximum characters of the CFN schema excerpt passed to the plan generator prompt. */
export const SCHEMA_EXCERPT_MAX_CHARS = 3000;

/** Default TTL for plan checkpoints in hours. */
export const CHECKPOINT_DEFAULT_TTL_HOURS = 72;

/** Directory for checkpoint files, relative to project root. */
export const CHECKPOINT_DIR = ".assignee";

/** SaaS API base URL for org policy fetch (Story 7.2). */
export const SAAS_API_URL =
  process.env["ASSIGNEE_SAAS_URL"] ?? "https://app.assignee.ai";

/** TTL in milliseconds for cached org policy (default 5 minutes). */
export const ORG_POLICY_TTL_MS = parseInt(
  process.env["ASSIGNEE_ORG_POLICY_TTL_MS"] ?? "300000",
  10,
);

/** Auto-cleanup throttle interval in milliseconds (1 hour). */
export const AUTO_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Maximum number of provision records to keep in memory rotation. */
export const MEMORY_MAX_PROVISIONS = 200;

/** Maximum number of failure records to keep in memory rotation. */
export const MEMORY_MAX_FAILURES = 100;

/** Maximum number of pattern records to keep in memory rotation. */
export const MEMORY_MAX_PATTERNS = 100;

// ── Timeout Constants ────────────────────────────────────────────────────────

/** Hard timeout for pricing MCP queries (ms). Non-blocking: never blocks apply on failure. */
export const PRICING_TIMEOUT_MS = 3000;

/** Timeout for post-provision security posture checks (ms). Longer than pricing as security aggregates from multiple sources. */
export const SECURITY_CHECK_TIMEOUT_MS = 5000;

/** 24 hours in milliseconds — used for failure record staleness checks. */
export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// ── Pricing Calculation Constants ────────────────────────────────────────────

/** Average hours per month for pricing calculations (730 = 365 days * 24 hours / 12 months). */
export const HOURS_PER_MONTH = 730;

// ── Additional Timeout / Threshold Constants ────────────────────────────────

/** Timeout for pricing lookups during option elicitation (ms). */
export const PRICING_LOOKUP_TIMEOUT_MS = 3000;

/** Timeout for fetching org policy from SaaS API (ms). */
export const ORG_POLICY_FETCH_TIMEOUT_MS = 2000;

/** Delay for optional MCP client initialization before proceeding with core tools (ms). */
export const MCP_SHUTDOWN_DELAY_MS = 3000;

/** Maximum retries for drift detection resource checks. */
export const DRIFT_MAX_RETRIES = 3;

/** Base delay for drift detection exponential backoff (ms). */
export const DRIFT_RETRY_BASE_DELAY_MS = 200;

/** Maximum jitter added to drift detection retry delay (ms). */
export const DRIFT_RETRY_JITTER_MS = 100;

/** Skip checkpoint files modified within this many minutes during cleanup. */
export const CLEANUP_SKIP_RECENT_MINUTES = 10;

/** Default max age for cache entries (24 hours in ms). */
export const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Threshold for deduplicating memory lock acquisition attempts (ms). */
export const MEMORY_DEDUP_THRESHOLD_MS = 10_000;

/** Maximum iterations for the provisioning loop before aborting. */
export const MAX_PROVISION_LOOPS = 50;
