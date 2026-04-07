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
      `Missing ${role} credentials. Set ${accessKeyVar} and ${secretKeyVar} ` +
        `in your environment (or in the .env file at the project root), ` +
        `or run 'assignee setup' to create the IAM users. ` +
        `(CLI commands also accept AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY ` +
        `as a fallback — they are auto-promoted to the operator role.)`,
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
 * Long-term IAM access key prefix (`AKIA[0-9A-Z]{16}`). Short-term STS
 * sessions use `ASIA` — both are accepted, only the shape is asserted.
 *
 * @see SECURITY-AUDIT.md — M-S7
 */
const ACCESS_KEY_SHAPE = /^(AKIA|ASIA)[0-9A-Z]{16}$/;

/** All Assignee roles, in declaration order. */
export const ASSIGNEE_ROLES: readonly AssigneeRole[] = [
  "operator",
  "reader",
  "auditor",
] as const;

/**
 * Returns the access key / secret key environment variable names for a role.
 * Single source of truth — init.ts and other consumers MUST use this rather
 * than re-declaring the mapping.
 *
 * @see SECURITY-AUDIT.md — M-S8
 */
export function envVarsForRole(role: AssigneeRole): {
  accessKey: string;
  secretKey: string;
} {
  return ROLE_TO_VARS[role];
}

/**
 * Returns the list of Assignee roles that have credentials configured in
 * the current process environment. Single source of truth used by
 * `assignee init` and other detection callers.
 *
 * @see SECURITY-AUDIT.md — M-S8
 */
export function availableRoles(): AssigneeRole[] {
  return ASSIGNEE_ROLES.filter(
    (role) => tryAssigneeCredentials(role) !== undefined,
  );
}

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
  const accessKeyId = process.env[vars.accessKey]?.trim();
  const secretAccessKey = process.env[vars.secretKey]?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new MissingAssigneeCredentialsError(
      role,
      vars.accessKey,
      vars.secretKey,
    );
  }

  // Best-effort shape warning. We do NOT reject because IAM users may
  // legitimately use ASIA-prefixed STS session keys.
  if (
    !ACCESS_KEY_SHAPE.test(accessKeyId) &&
    process.env["ASSIGNEE_LOG_LEVEL"] === "debug"
  ) {
    process.stderr.write(
      `[assignee] warning: ${vars.accessKey} does not match the expected ` +
        `AWS access key shape (AKIA/ASIA + 16 alphanumerics). Continuing anyway.\n`,
    );
  }

  return { accessKeyId, secretAccessKey };
}

/**
 * Non-throwing variant: returns undefined if credentials are not set
 * (or are whitespace-only).
 * Use only when a feature has a documented graceful no-op path
 * (e.g., best-effort discovery in plan mode).
 */
export function tryAssigneeCredentials(
  role: AssigneeRole,
): ExplicitAwsCredentials | undefined {
  const vars = ROLE_TO_VARS[role];
  const accessKeyId = process.env[vars.accessKey]?.trim();
  const secretAccessKey = process.env[vars.secretKey]?.trim();
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey };
}

/**
 * Returns true when a role has credentials configured in the environment.
 */
export function hasAssigneeCredentials(role: AssigneeRole): boolean {
  return tryAssigneeCredentials(role) !== undefined;
}
