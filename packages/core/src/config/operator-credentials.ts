/**
 * Shared helper for reading operator IAM user credentials from
 * ASSIGNEE_OPERATOR_* environment variables.
 *
 * All AWS SDK clients in the monorepo (CloudControl, Tagging, Lambda, SNS, Bedrock)
 * should call operatorCredentials() instead of reading AWS_* env vars directly.
 * This avoids conflicts with the user's own AWS credentials.
 *
 * Lifted from apps/cli/src/config/operator-credentials.ts in Story 50-4
 * Wave 5 Pass G so the in-core graph (createGraph + nodes) can read
 * operator credentials without reaching back into the CLI app.
 *
 * @see Story 18.8 — IAM Security Overhaul
 */

import type { AwsConfig } from "../services/cloudcontrol-client.js";
import { AWS_REGION } from "./constants/aws.js";
import { EnvVar } from "../constants/env-vars.js";

/**
 * Reads ASSIGNEE_OPERATOR_ACCESS_KEY_ID, ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY,
 * and AWS_REGION from the environment and returns an AwsConfig object.
 *
 * Region uses AWS_REGION (not operator-specific) since region is not user-specific.
 */
export function operatorCredentials(): AwsConfig {
  return {
    accessKeyId: process.env[EnvVar.OPERATOR_ACCESS_KEY] ?? "",
    secretAccessKey: process.env[EnvVar.OPERATOR_SECRET_KEY] ?? "",
    region: AWS_REGION,
  };
}
