/**
 * Centralized AWS credential resolution for ALL Assignee SDK clients.
 *
 * Every AWS SDK v3 client constructed inside the Assignee codebase MUST
 * obtain its credentials via these helpers — never via the default
 * credential provider chain. The default chain would silently fall through
 * to `~/.aws/credentials`, SSO sessions, or instance metadata, which would
 * leak operations to the developer's personal/root AWS identity.
 *
 * This enforces the IAM 3-user model:
 *   - operator: CloudControl CRUD + Bedrock (plan/apply/destroy/setup)
 *   - reader:   CloudFormation DescribeType + Pricing + Cost Explorer + discovery
 *   - auditor:  IAM Simulate + SecurityHub + GuardDuty (audit commands)
 *
 * If a role's env vars are not set, the helper throws
 * `MissingAssigneeCredentialsError` with the exact env var name needed.
 * It NEVER falls through to the default credential chain.
 *
 * Lives in @assignee/core so both apps/cli and apps/mcp-server can import it
 * without either reaching into the other.
 *
 * @see Story 18.8 — IAM Security Overhaul
 * @see feedback_simulate_ci_no_creds.md
 */

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
    accessKey: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
    secretKey: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  },
  reader: {
    accessKey: "ASSIGNEE_READER_ACCESS_KEY_ID",
    secretKey: "ASSIGNEE_READER_SECRET_ACCESS_KEY",
  },
  auditor: {
    accessKey: "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
    secretKey: "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
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
 * Use only when a feature has a documented graceful no-op path
 * (e.g., best-effort discovery in plan mode).
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
 */
export function hasAssigneeCredentials(role: AssigneeRole): boolean {
  return tryAssigneeCredentials(role) !== undefined;
}
