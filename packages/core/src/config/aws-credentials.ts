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
 * @see W2-01 — Wire ASSIGNEE_OPERATOR_SESSION_TOKEN (Epic 100)
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
  { accessKey: string; secretKey: string; sessionTokenKey?: string }
> = {
  operator: {
    accessKey: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
    secretKey: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
    // W2-01: ASSIGNEE_OPERATOR_SESSION_TOKEN is declared in env-vars.ts but was
    // never read here — SSO operators using ASIA* keys got AccessDenied
    // because the session token was silently dropped.
    sessionTokenKey: EnvVar.OPERATOR_SESSION_TOKEN,
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
  const { accessKey, secretKey } = ROLE_TO_VARS[role];
  return { accessKey, secretKey };
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
 * Thrown when a session token is present but structurally invalid
 * (e.g. expired STS token or obviously malformed value). The message
 * includes an actionable hint for SSO users.
 *
 * @see W2-01 — Wire ASSIGNEE_OPERATOR_SESSION_TOKEN (Epic 100)
 */
export class InvalidSessionTokenError extends Error {
  constructor(varName: string) {
    super(
      `Session token in ${varName} appears invalid or expired. ` +
        `If you are using AWS SSO, run \`aws sso login\` to refresh your session, ` +
        `then re-export the token: \`eval $(aws configure export-credentials --profile <profile> --format env)\``,
    );
    this.name = "InvalidSessionTokenError";
  }
}

/** Minimum plausible length for an AWS STS session token. Tokens issued
 *  by STS are typically 100–1000+ characters. A value shorter than this
 *  is almost certainly a typo or truncated paste. */
const MIN_SESSION_TOKEN_LEN = 16;

/**
 * Returns the credentials for a given role, or throws a clear error if
 * the required env vars are not set.
 *
 * NEVER falls through to the default credential chain.
 *
 * W2-01: now reads the optional session token env var (currently only
 * declared for the operator role via ASSIGNEE_OPERATOR_SESSION_TOKEN).
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

  // W2-01: read optional session token. Validate if present.
  let sessionToken: string | undefined;
  if (vars.sessionTokenKey) {
    const rawToken = process.env[vars.sessionTokenKey]?.trim();
    if (rawToken) {
      if (rawToken.length < MIN_SESSION_TOKEN_LEN) {
        throw new InvalidSessionTokenError(vars.sessionTokenKey);
      }
      sessionToken = rawToken;
    }
  }

  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

/**
 * Non-throwing variant: returns undefined if credentials are not set
 * (or are whitespace-only).
 * Use only when a feature has a documented graceful no-op path
 * (e.g., best-effort discovery in plan mode).
 *
 * W2-01: now reads the optional session token env var so STS credentials
 * (ASIA* keys) work correctly in best-effort callers as well.
 */
export function tryAssigneeCredentials(
  role: AssigneeRole,
): ExplicitAwsCredentials | undefined {
  const vars = ROLE_TO_VARS[role];
  const accessKeyId = process.env[vars.accessKey]?.trim();
  const secretAccessKey = process.env[vars.secretKey]?.trim();
  if (!accessKeyId || !secretAccessKey) return undefined;

  // W2-01: also pick up session token when present.
  let sessionToken: string | undefined;
  if (vars.sessionTokenKey) {
    const rawToken = process.env[vars.sessionTokenKey]?.trim();
    if (rawToken && rawToken.length >= MIN_SESSION_TOKEN_LEN) {
      sessionToken = rawToken;
    }
  }

  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

/**
 * Returns true when a role has credentials configured in the environment.
 */
export function hasAssigneeCredentials(role: AssigneeRole): boolean {
  return tryAssigneeCredentials(role) !== undefined;
}
