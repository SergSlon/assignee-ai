import { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import { ConfigurationError } from "@assignee/core";

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
    throw new ConfigurationError(
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID is missing or empty",
    );
  }
  if (!config.secretAccessKey) {
    throw new ConfigurationError(
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY is missing or empty",
    );
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
