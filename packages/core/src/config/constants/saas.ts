/**
 * SaaS/LLM infrastructure constants — Bedrock model ID, SaaS API URL.
 * Domain sub-module of the former `config/constants.ts` coupling hub
 * (Story 49.5).
 *
 * W5-01 (P007-tech → L1-F05 + L1-F20): SAAS_API_URL defaults to a
 * region-derived endpoint (`https://<region>.api.assignee.ai`) when
 * AWS_REGION is set, routing EU operators to EU endpoints by default.
 * Explicit `ASSIGNEE_SAAS_URL` env-var override is always honoured.
 * When no AWS_REGION is set, falls back to the legacy US-East URL.
 */

import { EnvVar } from "../../constants/env-vars.js";
import { assertValidUrl } from "../../utils/url-validator.js";

// MIGRATION-NOTE(M-009): the BEDROCK_MODEL_ID and SAAS_API_URL constants
// below derive from `process.env` at module load. Multi-tenant SaaS will
// need request-scoped lookup via `ConfigPort` — see deriveBedrockModelId()
// and deriveSaasApiUrl() for the two reads. Single-tenant CLI captures the
// value at module load — fine today.

/**
 * W5-01: Bedrock model ID. When `BEDROCK_MODEL_ID` env var is set, use
 * that value verbatim. Otherwise derive a region-aware inference profile:
 *   - eu-* regions  → "eu.amazon.nova-lite-v1:0"
 *   - ap-* regions  → "ap.amazon.nova-lite-v1:0"
 *   - everything else (us-*, GovCloud, ISO, etc.) → "us.amazon.nova-lite-v1:0"
 */
function deriveBedrockModelId(): string {
  const envOverride = process.env[EnvVar.BEDROCK_MODEL_ID];
  if (envOverride) return envOverride;

  const region = process.env[EnvVar.AWS_REGION] ?? "";
  if (region.startsWith("eu-")) return "eu.amazon.nova-lite-v1:0";
  if (region.startsWith("ap-")) return "ap.amazon.nova-lite-v1:0";
  return "us.amazon.nova-lite-v1:0";
}

export const BEDROCK_MODEL_ID = deriveBedrockModelId();

/**
 * W5-01 + W5-03: SaaS API base URL for org policy fetch (Story 7.2).
 *
 * Resolution order:
 *   1. `ASSIGNEE_SAAS_URL` env var (validated via url-validator)
 *   2. Region-derived: `https://<AWS_REGION>.api.assignee.ai` when AWS_REGION is set
 *   3. Legacy US-East fallback: `https://app.assignee.ai`
 */
function deriveSaasApiUrl(): string {
  const envOverride = process.env[EnvVar.ASSIGNEE_SAAS_URL];
  if (envOverride) {
    // W5-03: validate the override before accepting it.
    assertValidUrl(envOverride, EnvVar.ASSIGNEE_SAAS_URL, {
      allowLocalhostHttp: false,
    });
    return envOverride;
  }

  const region = process.env[EnvVar.AWS_REGION];
  if (region) {
    return `https://${region}.api.assignee.ai`;
  }

  // Legacy US-East fallback — no AWS_REGION configured.
  return "https://app.assignee.ai";
}

/** SaaS API base URL for org policy fetch (Story 7.2). */
export const SAAS_API_URL = deriveSaasApiUrl();
