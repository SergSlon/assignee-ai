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
