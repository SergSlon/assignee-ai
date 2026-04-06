/**
 * Centralized AWS credential resolution for all SDK clients.
 *
 * ALL AWS SDK clients in the CLI (and tests) must use these helpers to
 * construct credentials — never rely on the default credential provider
 * chain, which would leak to root/SSO sessions on developer machines.
 *
 * This enforces the IAM 3-user model:
 *   - operator: CloudControl CRUD + Bedrock (for plan/apply/destroy)
 *   - reader:   CloudFormation DescribeType + Pricing + Cost Explorer (for schema/pricing)
 *   - auditor:  IAM Simulate + SecurityHub + GuardDuty (for audit commands)
 *
 * If a role's env vars are not set (e.g., `.env` not loaded), the helper
 * throws a clear error with the exact env var name needed. It NEVER falls
 * through to `~/.aws/credentials`, SSO, or instance metadata.
 *
 * @see Story 18.8 — IAM Security Overhaul
 * @see feedback_simulate_ci_no_creds.md
 */

import { EnvVar } from "../constants/env-vars.js";

export type AssigneeRole = "operator" | "reader" | "auditor";

/** Plain AWS credentials object consumable by any AWS SDK v3 client. */
export interface ExplicitAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Thrown when a role's credentials are not set in the environment.
 * The message includes the exact env var names and a recovery hint.
 */
export class MissingAssigneeCredentialsError extends Error {
  constructor(
    public readonly role: AssigneeRole,
    accessKeyVar: string,
    secretKeyVar: string,
  ) {
    super(
      `Missing ${role} credentials. Set ${accessKeyVar} and ${secretKeyVar} in ` +
        `${process.cwd().includes("assignee.ai") ? ".env" : "assignee.ai/.env"}, ` +
        `or run 'assignee setup' to create the IAM users. ` +
        `The default AWS credential chain is intentionally bypassed.`,
    );
    this.name = "MissingAssigneeCredentialsError";
  }
}

const ROLE_TO_VARS: Record<
  AssigneeRole,
  { accessKey: string; secretKey: string }
> = {
  operator: {
    accessKey: EnvVar.OPERATOR_ACCESS_KEY,
    secretKey: EnvVar.OPERATOR_SECRET_KEY,
  },
  reader: {
    accessKey: EnvVar.READER_ACCESS_KEY,
    secretKey: EnvVar.READER_SECRET_KEY,
  },
  auditor: {
    accessKey: EnvVar.AUDITOR_ACCESS_KEY,
    secretKey: EnvVar.AUDITOR_SECRET_KEY,
  },
};

/**
 * Returns the credentials for a given role, or throws a clear error if
 * the required env vars are not set.
 *
 * NEVER falls through to the default credential chain.
 */
export function requireAssigneeCredentials(
  role: AssigneeRole,
): ExplicitAwsCredentials {
  const vars = ROLE_TO_VARS[role];
  const accessKeyId = process.env[vars.accessKey];
  const secretAccessKey = process.env[vars.secretKey];

  if (!accessKeyId || !secretAccessKey) {
    throw new MissingAssigneeCredentialsError(
      role,
      vars.accessKey,
      vars.secretKey,
    );
  }

  return { accessKeyId, secretAccessKey };
}

/**
 * Non-throwing variant: returns undefined if credentials are not set.
 * Use when a feature should gracefully no-op without credentials
 * (e.g., read-only discovery helpers in plan mode).
 */
export function tryAssigneeCredentials(
  role: AssigneeRole,
): ExplicitAwsCredentials | undefined {
  const vars = ROLE_TO_VARS[role];
  const accessKeyId = process.env[vars.accessKey];
  const secretAccessKey = process.env[vars.secretKey];
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey };
}

/**
 * Returns true when a role has credentials configured in the environment.
 * Equivalent to `tryAssigneeCredentials(role) !== undefined` but more readable.
 */
export function hasAssigneeCredentials(role: AssigneeRole): boolean {
  return tryAssigneeCredentials(role) !== undefined;
}
