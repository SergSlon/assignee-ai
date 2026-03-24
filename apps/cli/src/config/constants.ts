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
