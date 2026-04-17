/**
 * SaaS/LLM infrastructure constants — Bedrock model ID, SaaS API URL.
 * Domain sub-module of the former `config/constants.ts` coupling hub
 * (Story 49.5).
 */

import { EnvVar } from "../../constants/env-vars.js";

export const BEDROCK_MODEL_ID =
  process.env[EnvVar.BEDROCK_MODEL_ID] ?? "us.amazon.nova-lite-v1:0";

/** SaaS API base URL for org policy fetch (Story 7.2). */
export const SAAS_API_URL =
  process.env[EnvVar.ASSIGNEE_SAAS_URL] ?? "https://app.assignee.ai";
