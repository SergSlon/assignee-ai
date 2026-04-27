/**
 * AWS-related constants — region, service identifiers, credential error
 * message templates.
 *
 * Story 50-4 Wave 5 Pass A: lifted from `apps/cli/src/config/constants/aws.ts`
 * so the in-core logger / token-usage / LlmAdapter can read AWS_REGION
 * without reaching back into the CLI app.
 */

import { DEFAULT_AWS_REGION } from "../config-schema.js";
import { EnvVar } from "../../constants/env-vars.js";

// MIGRATION-NOTE(M-009): process-lifetime config; multi-tenant SaaS will
// need request-scoped lookup via `ConfigPort.get(EnvVar.AWS_REGION)`. The
// CLI today is single-tenant so the read at module load is benign — every
// invocation gets its own process. Migrating away requires touching every
// caller (LlmAdapter, S3 client factory, CloudControl client factory,
// ARN resolver, …); deferred to a dedicated wave.
export const AWS_REGION = process.env[EnvVar.AWS_REGION] ?? DEFAULT_AWS_REGION;

/** ARN service identifier for API Gateway V2 execute endpoints. */
export const AWS_SERVICE_EXECUTE_API = "execute-api" as const;

/** Standard error messages for missing operator credentials. */
export const CredentialError = {
  MISSING_ACCESS_KEY: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID is missing or empty",
  MISSING_SECRET_KEY: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY is missing or empty",
} as const;
