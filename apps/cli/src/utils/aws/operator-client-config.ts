/**
 * Build an AWS SDK client config for the `operator` role.
 *
 * Shared by `destroy.ts` — `scheduleKmsKeyDeletion`, `tryDescribeSecretDeletionDate`,
 * `deleteSecret`, and `deleteEventBus` all follow the same pattern:
 *
 *   const awsCreds = tryAssigneeCredentials("operator");
 *   const region = resolved.region || AWS_REGION;
 *   const config = awsCreds ? { ...awsCreds, region } : { region };
 *
 * Extracting this into a single helper keeps the pattern DRY and makes
 * it trivially testable.
 *
 * NOTE: This helper MUST NOT be used for `resolveForDestroy` (the RGTA
 * tagging client), which requires a different shape with mandatory
 * `accessKeyId` / `secretAccessKey` fields (line 457 of destroy.ts at
 * extraction time). That site has its own ad-hoc construction.
 */

import { tryAssigneeCredentials } from "../../config/aws-credentials.js";
import { AWS_REGION } from "../../config/constants.js";

/**
 * Fully-credentialed config. Mirrors `AwsConfig` from `@assignee/core`
 * but kept local so this utility does not need to import a deep core type.
 */
export interface WithCredentialsConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Region-only config (no credentials available).
 * Mirrors `NoCredentialsConfig` from `@assignee/core` — the discriminant
 * `accessKeyId?: undefined` matches the discriminated union that the
 * AWS SDK client factories accept.
 */
export interface WithoutCredentialsConfig {
  region: string;
  accessKeyId?: undefined;
  secretAccessKey?: undefined;
  sessionToken?: undefined;
}

/** Discriminated union accepted by KMS / SecretsManager / EventBridge client factories. */
export type OperatorClientConfig =
  | WithCredentialsConfig
  | WithoutCredentialsConfig;

/**
 * Resolve operator credentials and build an AWS SDK client config.
 *
 * @param resolved  An object with an optional `region` field (e.g. the
 *   `ResolvedResource` from the destroy pipeline). When `resolved.region`
 *   is falsy, falls back to the `AWS_REGION` environment constant.
 */
export function buildOperatorClientConfig(resolved: {
  region?: string;
}): OperatorClientConfig {
  const awsCreds = tryAssigneeCredentials("operator");
  const region = resolved.region || AWS_REGION;
  if (awsCreds) {
    return { ...awsCreds, region };
  }
  return { region };
}
