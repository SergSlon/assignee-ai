import { SUPPORTED_TYPES_ARRAY, ASSIGNEE_DIR } from "@assignee/core";
export { ASSIGNEE_DIR } from "@assignee/core";
import { EnvVar } from "../constants/env-vars.js";

export const BEDROCK_MODEL_ID =
  process.env[EnvVar.BEDROCK_MODEL_ID] ?? "us.amazon.nova-lite-v1:0";

import { DEFAULT_AWS_REGION } from "@assignee/core";

export const AWS_REGION = process.env[EnvVar.AWS_REGION] ?? DEFAULT_AWS_REGION;

// packages/core is the single source of truth for supported resource types (Story 9.1)
export { SUPPORTED_TYPES_ARRAY as SUPPORTED_TYPES } from "@assignee/core";

/** Human-readable hint shown when an unsupported resource type is requested. */
export const SUPPORTED_TYPES_HINT = `Supported types: ${SUPPORTED_TYPES_ARRAY.join(", ")}`;

/** Architecture patterns hint shown in help text. */
export const PATTERNS_HINT = `Architecture patterns (multi-resource):
  "Create a serverless API"                → Lambda + API Gateway + IAM Role + LogGroup
  "Create a three-tier web app"            → EC2 + RDS + SecurityGroup
  "Create a VPC with public/private subnets" → VPC + Subnets + IGW + NAT + Routes (17 resources)
  "Create a message processing pipeline"   → SQS + Lambda + DLQ
  "Create a container service"             → ECS Cluster + ECR + IAM Role
  "Create a static website"               → S3 Bucket (+ CloudFront)`;

/** Examples hint shown in help text. */
export const EXAMPLES_HINT = `Examples:
  assignee plan "Create an S3 bucket"             Plan a single resource
  assignee plan "Create a serverless API"          Plan a multi-resource architecture
  assignee apply "Create a Lambda function"        Plan and deploy in one step
  assignee destroy --all --dry-run                 Preview bulk destruction
  assignee clean --resources                       Remove stale e2e/test resources
  assignee drift                                   Check all resources for drift`;

/** Maximum characters of the CFN schema excerpt passed to the plan generator prompt. */
export const SCHEMA_EXCERPT_MAX_CHARS = 3000;

/** Default TTL for plan checkpoints in hours. */
export const CHECKPOINT_DEFAULT_TTL_HOURS = 72;

/** Directory for checkpoint files, relative to project root. */
export const CHECKPOINT_DIR = ASSIGNEE_DIR;

/** SaaS API base URL for org policy fetch (Story 7.2). */
export const SAAS_API_URL =
  process.env[EnvVar.ASSIGNEE_SAAS_URL] ?? "https://app.assignee.ai";

/** TTL in milliseconds for cached org policy (default 5 minutes). */
export const ORG_POLICY_TTL_MS = parseInt(
  process.env[EnvVar.ASSIGNEE_ORG_POLICY_TTL_MS] ?? "300000",
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

// ── File Name Constants ─────────────────────────────────────────────────────

/**
 * Named file constants — single source of truth for file names used in
 * memory, config loaders, and path resolution.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const FileName = {
  PROVISIONS: "provisions.json",
  FAILURES: "failures.json",
  PATTERNS: "patterns.json",
  CONFIG: "config.yaml",
  ORG_POLICY: "org-policy.yaml",
} as const;

/** @deprecated Use FileName.PROVISIONS */
export const PROVISIONS_FILE = FileName.PROVISIONS;

/** @deprecated Use FileName.FAILURES */
export const FAILURES_FILE = FileName.FAILURES;

/** Prefix for checkpoint files: checkpoint-<runId>.json */
export const CHECKPOINT_FILE_PREFIX = "checkpoint-" as const;

/**
 * Cleanup category identifiers — single source of truth.
 * @see Story 42.10 — zero magic strings policy
 */
export const CleanupCategoryName = {
  CHECKPOINTS: "checkpoints" as const,
  CACHE: "cache" as const,
  MEMORY: "memory" as const,
} as const;

// ── Promise Status Constants ────────────────────────────────────────────────

/** Named constants for Promise.allSettled status values. */
export const PromiseStatus = {
  FULFILLED: "fulfilled",
  REJECTED: "rejected",
} as const;

// ── User-Facing Cancellation Messages ───────────────────────────────────────

export const UserMessage = {
  INIT_CANCELLED: "Initialization cancelled.",
  WIZARD_CANCELLED: "Wizard cancelled.",
  CANCELLED: "Cancelled.",
  BULK_DESTROY_CANCELLED: "Bulk destroy cancelled.",
  DESTROY_CANCELLED: "Destroy cancelled.",
  SETUP_CANCELLED: "Setup cancelled.",
  RESOURCE_CLEANUP_CANCELLED: "Resource cleanup cancelled.",
} as const;

// ── Destroy Polling Constants ────────────────────────────────────────────────

/** Maximum number of polls before giving up on delete status. */
export const DESTROY_MAX_POLL_ATTEMPTS = 60;

/** Delay between destroy status polls in milliseconds. */
export const DESTROY_POLL_INTERVAL_MS = 2000;

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

// ── Security Constants ─────────────────────────────────────────────────────

/**
 * Prototype pollution keys to reject in deep-merge and patch operations.
 * @see Story 42.10 — zero magic strings policy
 */
export const PROTO_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Sentinel value for "none of these" in AMI selection wizard. */
export const WIZARD_NONE_SENTINEL = "__none__" as const;

// ── Display / Boxen Alignment ──────────────────────────────────────────────

export const BoxenAlign = {
  CENTER: "center" as const,
  LEFT: "left" as const,
} as const;

export const BoxenBorderColor = {
  CYAN: "cyan" as const,
} as const;

// ── Fallback / Sentinel Values ──────────────────────────────────────────────

/** Generic "unknown" fallback for missing metadata fields (ARN parts, resource type, etc.). */
export const UNKNOWN_FALLBACK = "unknown" as const;

// ── AWS Service Identifiers ────────────────────────────────────────────────

/** ARN service identifier for API Gateway V2 execute endpoints. */
export const AWS_SERVICE_EXECUTE_API = "execute-api" as const;

// ── Shared User-Facing Strings ────────────────────────────────────────────

/** Error prefix used when plan generation fails. */
export const PLAN_GENERATION_FAILED = "Plan generation failed" as const;

/** Example S3 intent used in help text and error messages. */
export const EXAMPLE_S3_INTENT = "Create an S3 bucket named my-bucket" as const;

// ── Credential Error Messages ──────────────────────────────────────────────

/** Standard error messages for missing operator credentials. */
export const CredentialError = {
  MISSING_ACCESS_KEY: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID is missing or empty",
  MISSING_SECRET_KEY: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY is missing or empty",
} as const;
