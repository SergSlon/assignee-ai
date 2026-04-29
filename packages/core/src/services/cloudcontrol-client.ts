/**
 * CloudControl client factory — validates ASSIGNEE_OPERATOR_* credentials
 * and returns a configured `@aws-sdk/client-cloudcontrol` client.
 *
 * Lifted from `apps/cli/src/services/cloudcontrol-client.ts` in Story
 * 50-4 Wave 5 Pass G so the in-core graph (createGraph + nodes) can
 * construct the client directly without reaching back into the CLI app.
 *
 * The CLI's old path is now a thin re-export shim.
 *
 * C4 fix (Wave 1): factory now accepts a missing-cred path via
 * `NoCrendentialsConfig`. When called without accessKeyId/secretAccessKey,
 * it emits a one-line stderr warning and returns a region-only client.
 * This keeps ALL client construction routed through this factory so
 * module-level `vi.mock("../services/cloudcontrol-client.js", ...)` in
 * integration tests intercepts both paths.
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
 * Region-only config used when operator credentials are absent.
 * The factory will emit a stderr warning and return a client that will
 * fail with an SDK auth error on the first actual AWS API call — the
 * correct blast-radius for missing credentials (not at construction time).
 */
export interface NoCredentialsConfig {
  region: string;
  accessKeyId?: undefined;
  secretAccessKey?: undefined;
  sessionToken?: undefined;
}

/**
 * Factory function that creates a CloudControlClient.
 *
 * When called with full credentials (`AwsConfig`):
 *   - validates that no field is missing or empty
 *   - returns a fully-credentialed CloudControlClient
 *
 * When called with region-only (`NoCredentialsConfig` — accessKeyId absent):
 *   - emits a one-line warning to stderr
 *   - returns a region-only CloudControlClient (auth errors deferred to first API call)
 *   - NEVER passes empty-string credentials to the AWS SDK
 *
 * R10a-03: lenient-at-construction — this function never throws for the
 * missing-cred path; it only throws for the with-creds path when a
 * provided credential field is empty (misconfiguration, not absence).
 *
 * Uses ASSIGNEE_OPERATOR_* env vars for CloudControl provisioning.
 * Callers should use requireAssigneeCredentials("operator") to read env vars and pass via AwsConfig.
 */
export function createCloudControlClient(
  config: AwsConfig | NoCredentialsConfig,
): CloudControlClient {
  // Missing-cred path: region-only client with stderr warning.
  // accessKeyId being undefined (not just empty) is the discriminant — this
  // distinguishes a deliberate "no creds available" call from an accidental
  // empty-string misconfiguration.
  if (config.accessKeyId === undefined) {
    if (!config.region) {
      throw new ConfigurationError("AWS_REGION is missing or empty");
    }
    process.stderr.write(
      "assignee: operator credentials not found — downstream AWS calls will fail with auth errors\n",
    );
    return new CloudControlClient({ region: config.region });
  }

  // Full-credentials path: validate every field before constructing.
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
