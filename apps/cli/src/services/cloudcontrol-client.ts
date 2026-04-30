/**
 * CloudControl client factory — thin re-export shim.
 *
 * Canonical implementation lives in `@assignee/core`'s services barrel
 * (lifted in Story 50-4 Wave 5 Pass G so the in-core graph can
 * construct the client without reaching back into the CLI app).
 *
 * `AwsConfig` is intentionally re-exported from the destroy-strategies
 * barrel because @assignee/core deliberately publishes the
 * `cloudcontrol-client.AwsConfig` interface ONLY at the leaf module
 * (the destroy-strategies barrel already exports an identically-
 * shaped `AwsConfig` from Story 49.1).
 */
export {
  createCloudControlClient,
  createKmsClient,
  createSecretsManagerClient,
  createEventBridgeClient,
} from "@assignee/core";
export type { AwsConfig } from "@assignee/core";
