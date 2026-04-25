/**
 * CloudControl client factory — validates ASSIGNEE_OPERATOR_* credentials
 * and returns a configured `@aws-sdk/client-cloudcontrol` client.
 *
 * Lifted from `apps/cli/src/services/cloudcontrol-client.ts` in Story
 * 50-4 Wave 5 Pass G so the in-core graph (createGraph + nodes) can
 * construct the client directly without reaching back into the CLI app.
 *
 * The CLI's old path is now a thin re-export shim.
 */

import { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import { ConfigurationError } from "../errors.js";
import { CredentialError } from "../config/constants/aws.js";

export interface AwsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Optional STS session token — required for ASIA* short-term credentials (SSO, assumed roles). W2-01. */
  sessionToken?: string;
}

/**
 * Factory function that creates a CloudControlClient with validated credentials.
 * Throws ConfigurationError immediately if any credential field is missing or empty.
 *
 * Uses ASSIGNEE_OPERATOR_* env vars for CloudControl provisioning.
 * Callers should use operatorCredentials() to read env vars and pass via AwsConfig.
 */
export function createCloudControlClient(
  config: AwsConfig,
): CloudControlClient {
  if (!config.accessKeyId) {
    throw new ConfigurationError(CredentialError.MISSING_ACCESS_KEY);
  }
  if (!config.secretAccessKey) {
    throw new ConfigurationError(CredentialError.MISSING_SECRET_KEY);
  }
  if (!config.region) {
    throw new ConfigurationError("AWS_REGION is missing or empty");
  }
  return new CloudControlClient({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      // W2-01: pass session token for STS/SSO short-term credentials.
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
  });
}
