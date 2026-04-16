/**
 * AWS-related constants — region, service identifiers, credential error
 * message templates. Domain sub-module of the former `config/constants.ts`
 * coupling hub (Story 49.5).
 */

import { DEFAULT_AWS_REGION } from "@assignee/core";
import { EnvVar } from "../../constants/env-vars.js";

export const AWS_REGION = process.env[EnvVar.AWS_REGION] ?? DEFAULT_AWS_REGION;

/** ARN service identifier for API Gateway V2 execute endpoints. */
export const AWS_SERVICE_EXECUTE_API = "execute-api" as const;

/** Standard error messages for missing operator credentials. */
export const CredentialError = {
  MISSING_ACCESS_KEY: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID is missing or empty",
  MISSING_SECRET_KEY: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY is missing or empty",
} as const;
