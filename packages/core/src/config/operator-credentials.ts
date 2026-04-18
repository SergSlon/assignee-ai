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
 * Module-level guard so the "operator creds missing" warning fires only once
 * per process. Without this, high-frequency SDK builders (one per CCAPI call)
 * would flood stderr. Exported reset helper below lets tests re-arm.
 */
let hasWarned = false;

const MISSING_OPERATOR_CREDS_WARNING =
  "\u26A0  ASSIGNEE_OPERATOR_* env vars are not set — AWS SDK clients in this process will fall through to the default credential provider chain (env vars, ~/.aws/credentials, EC2 instance role, SSO). Run 'assignee init' to configure operator credentials.\n";

/**
 * Reads ASSIGNEE_OPERATOR_ACCESS_KEY_ID, ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY,
 * and AWS_REGION from the environment and returns an AwsConfig object.
 *
 * Region uses AWS_REGION (not operator-specific) since region is not user-specific.
 *
 * When BOTH operator env vars are empty, we emit a one-time-per-process warning
 * to stderr. The return shape is preserved (empty strings) so existing callers
 * that conditionally spread non-empty fields keep working. See
 * `apps/cli/src/commands/list-resources.ts` for the conditional-spread pattern.
 */
export function operatorCredentials(): AwsConfig {
  const accessKeyId = process.env[EnvVar.OPERATOR_ACCESS_KEY] ?? "";
  const secretAccessKey = process.env[EnvVar.OPERATOR_SECRET_KEY] ?? "";

  if (!hasWarned && accessKeyId === "" && secretAccessKey === "") {
    hasWarned = true;
    process.stderr.write(MISSING_OPERATOR_CREDS_WARNING);
  }

  return {
    accessKeyId,
    secretAccessKey,
    region: AWS_REGION,
  };
}

/**
 * Test-only helper — resets the module-level `hasWarned` flag so each test
 * case starts with a fresh warning budget. Mirrors the `_resetAccountDateCache`
 * pattern elsewhere in core.
 */
export function _resetOperatorCredsWarning(): void {
  hasWarned = false;
}
