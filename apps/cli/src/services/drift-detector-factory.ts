/**
 * Factory for creating DriftDetectorService with real AWS credentials.
 * Replaces the globalThis["__assigneeDriftPort"] DI pattern with proper initialization.
 *
 * @see Sprint K — Quality Blitz: Fix globalThis DI pattern
 */

import { DriftDetectorService } from "./drift-detector.js";
import { CloudControlAdapter } from "./cloudcontrol-adapter.js";
import { createCloudControlClient } from "./cloudcontrol-client.js";
import { tryAssigneeCredentials } from "../config/aws-credentials.js";
import { AWS_REGION } from "@assignee/core";
import type { ProvisioningPort } from "./provisioning-port.js";

export interface DriftDetectorWithPort {
  detector: DriftDetectorService;
  port: ProvisioningPort;
}

/**
 * Creates a DriftDetectorService backed by CloudControlAdapter using
 * operator credentials from environment variables.
 *
 * Returns undefined if credentials are missing (access key or secret key empty).
 * This replaces the old globalThis["__assigneeDriftPort"] injection pattern.
 */
export function createDriftDetectorFromEnv():
  | DriftDetectorWithPort
  | undefined {
  const opCreds = tryAssigneeCredentials("operator");

  // If credentials are missing, return undefined so the caller can show a helpful message
  if (!opCreds) {
    return undefined;
  }

  try {
    const client = createCloudControlClient({ ...opCreds, region: AWS_REGION });
    const port = new CloudControlAdapter(client);
    const detector = new DriftDetectorService({ provisioningPort: port });
    return { detector, port };
  } catch {
    // ConfigurationError from createCloudControlClient — treat as unavailable
    return undefined;
  }
}
