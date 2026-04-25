/**
 * Factory for the ResourceGroupsTaggingAPIClient with validated credentials.
 *
 * @see Story 18.5
 */

import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { ConfigurationError } from "@assignee/core";
import type { AwsConfig } from "../cloudcontrol-client.js";
import { AWS_REGION, CredentialError } from "../../config/constants.js";

/**
 * Creates a ResourceGroupsTaggingAPIClient with validated credentials.
 */
export function createTaggingClient(
  config: AwsConfig,
): ResourceGroupsTaggingAPIClient {
  if (!config.accessKeyId) {
    throw new ConfigurationError(CredentialError.MISSING_ACCESS_KEY);
  }
  if (!config.secretAccessKey) {
    throw new ConfigurationError(CredentialError.MISSING_SECRET_KEY);
  }

  return new ResourceGroupsTaggingAPIClient({
    region: config.region || AWS_REGION,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      // W2-01: pass session token for STS/SSO short-term credentials.
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
  });
}
