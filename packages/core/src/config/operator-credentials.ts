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

/**
 * Choose a warning glyph that renders across legacy Windows code pages
 * (cp1252, cp437) where `\u26A0` shows as "?" and obscures the message.
 * We look for the `UTF-8` / `utf8` marker on `LC_ALL` / `LC_CTYPE` /
 * `LANG` — standard POSIX locale plumbing. Everything else (including
 * empty env on Windows) falls through to the plain ASCII `[!]` sentinel
 * so the operator-facing warning is always legible (Story 56-it2-04
 * L5-L3). Exported for the sibling unit test — pure, no side effects.
 */
export function isUtf8Locale(env: NodeJS.ProcessEnv = process.env): boolean {
  const candidates = [env["LC_ALL"], env["LC_CTYPE"], env["LANG"]];
  for (const raw of candidates) {
    if (!raw) continue;
    if (/utf-?8/i.test(raw)) return true;
  }
  return false;
}

function buildMissingOperatorCredsWarning(): string {
  const glyph = isUtf8Locale() ? "\u26A0" : "[!]";
  return `${glyph}  ASSIGNEE_OPERATOR_* env vars are not set — AWS SDK clients in this process will fall through to the default credential provider chain (env vars, ~/.aws/credentials, EC2 instance role, SSO). Run 'assignee init' to configure operator credentials.\n`;
}

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
 *
 * @deprecated Prefer a variant that throws on missing/empty credentials rather
 * than silently returning empty strings (scheduled for Epic 57). Every current
 * call-site must either (a) guard with `if (!creds.accessKeyId || !creds.secretAccessKey)`
 * before using the result, or (b) pass the result to `createCloudControlClient`
 * / `createTaggingClient` which throw `ConfigurationError` on empty. Audited
 * call-sites as of Story 56-it2-02:
 *   - `apps/cli/src/services/destroy-service.ts` — passes into `createCloudControlClient` (throws)
 *   - `apps/cli/src/services/drift-detector-factory.ts` — explicit `if (!creds.accessKeyId)` guard
 *   - `apps/cli/src/services/list-resources.ts` — conditional-spread pattern
 *   - `apps/cli/src/e2e/bulk-sweep.ts` — dev-only e2e harness, creds required by design
 *   - `apps/cli/src/commands/destroy/single-flow.ts` — passes into `createTaggingClient` (throws)
 *   - `packages/core/src/graph/create-graph.ts` — passes into `createCloudControlClient` (throws)
 *   - `packages/core/src/graph/nodes/preflight-guard/guards/managed-policy.ts` — conditional-spread pattern
 */
export function operatorCredentials(): AwsConfig {
  const accessKeyId = process.env[EnvVar.OPERATOR_ACCESS_KEY] ?? "";
  const secretAccessKey = process.env[EnvVar.OPERATOR_SECRET_KEY] ?? "";

  if (!hasWarned && accessKeyId === "" && secretAccessKey === "") {
    hasWarned = true;
    process.stderr.write(buildMissingOperatorCredsWarning());
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
