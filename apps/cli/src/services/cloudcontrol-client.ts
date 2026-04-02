import { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import { ConfigurationError } from "@assignee/core";
import { CredentialError } from "../config/constants.js";

export interface AwsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
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
    },
  });
}
