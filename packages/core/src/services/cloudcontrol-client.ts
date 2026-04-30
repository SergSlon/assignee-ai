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
 *
 * W6-S2: parallel factories for KMS, SecretsManager, and EventBridge added
 * so the destroy command's three inline SDK client constructions are routed
 * through the same credential-validation + no-cred-warning pattern as the
 * CloudControl client.  All three factories share the same AwsConfig /
 * NoCredentialsConfig discriminant so tests intercept them via a single
 * `vi.mock("../services/cloudcontrol-client.js", ...)` call.
 */

import { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import { KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
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

// ─── Shared credential-builder helper ────────────────────────────────────────
// Extracted so the three new factories below don't repeat the same validation
// pattern.  Returns an object suitable for spreading into any AWS SDK v3
// client constructor config.

function buildClientConfig(
  config: AwsConfig | NoCredentialsConfig,
  serviceName: string,
): {
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
} {
  if (config.accessKeyId === undefined) {
    if (!config.region) {
      throw new ConfigurationError("AWS_REGION is missing or empty");
    }
    process.stderr.write(
      `assignee: operator credentials not found — downstream ${serviceName} calls will fail with auth errors\n`,
    );
    return { region: config.region };
  }

  if (!config.accessKeyId) {
    throw new ConfigurationError(CredentialError.MISSING_ACCESS_KEY);
  }
  if (!config.secretAccessKey) {
    throw new ConfigurationError(CredentialError.MISSING_SECRET_KEY);
  }
  if (!config.region) {
    throw new ConfigurationError("AWS_REGION is missing or empty");
  }

  return {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
  };
}

/**
 * Factory for `@aws-sdk/client-kms` KMSClient.
 *
 * Follows the same AwsConfig / NoCredentialsConfig discriminant as
 * `createCloudControlClient` so tests can intercept via:
 *   `vi.mock("../services/cloudcontrol-client.js", () => ({ createKmsClient: vi.fn() }))`
 *
 * W6-S2: replaces the inline KMSClient construction in `destroy.ts`
 * `scheduleKmsKeyDeletion`.
 */
export function createKmsClient(
  config: AwsConfig | NoCredentialsConfig,
): KMSClient {
  return new KMSClient(buildClientConfig(config, "KMS"));
}

/**
 * Factory for `@aws-sdk/client-secrets-manager` SecretsManagerClient.
 *
 * Follows the same AwsConfig / NoCredentialsConfig discriminant as
 * `createCloudControlClient` so tests can intercept via:
 *   `vi.mock("../services/cloudcontrol-client.js", () => ({ createSecretsManagerClient: vi.fn() }))`
 *
 * W6-S2: replaces the inline SecretsManagerClient construction in `destroy.ts`
 * `deleteSecret`.
 */
export function createSecretsManagerClient(
  config: AwsConfig | NoCredentialsConfig,
): SecretsManagerClient {
  return new SecretsManagerClient(buildClientConfig(config, "SecretsManager"));
}

/**
 * Factory for `@aws-sdk/client-eventbridge` EventBridgeClient.
 *
 * Follows the same AwsConfig / NoCredentialsConfig discriminant as
 * `createCloudControlClient` so tests can intercept via:
 *   `vi.mock("../services/cloudcontrol-client.js", () => ({ createEventBridgeClient: vi.fn() }))`
 *
 * W6-S2: replaces the inline EventBridgeClient construction in `destroy.ts`
 * `deleteEventBus`.
 */
export function createEventBridgeClient(
  config: AwsConfig | NoCredentialsConfig,
): EventBridgeClient {
  return new EventBridgeClient(buildClientConfig(config, "EventBridge"));
}
