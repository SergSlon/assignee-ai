/**
 * Early credential detection and auto-promotion.
 *
 * Extracted from command-runner.ts (Wave 6d F5). SRP: decide between
 *   (a) ASSIGNEE_OPERATOR_*  — preferred
 *   (b) AWS_ACCESS_KEY_ID    — auto-promoted with warning
 *   (c) AWS_PROFILE alone    — W2-02: resolved via fromIni() provider chain
 *   (d) nothing at all       — ConfigurationError with setup instructions
 *
 * @see W2-02 — AWS_PROFILE via provider chain (Epic 100)
 */
import { ConfigurationError } from "@assignee/core";
import { EnvVar } from "../../constants/env-vars.js";

/**
 * Run the pre-flight credential check. Throws ConfigurationError when no
 * usable credentials are present. Writes a yellow stderr warning when
 * auto-promoting AWS_* vars to ASSIGNEE_OPERATOR_*.
 *
 * W2-02: AWS_PROFILE is now supported — credentials are resolved lazily
 * via fromIni() and promoted to ASSIGNEE_OPERATOR_* so the rest of the
 * command pipeline (which reads those vars) stays unchanged. Call
 * resolveCredentialsWithProfile() before constructing SDK clients when
 * profile-based auth is in use.
 */
export function resolveCredentials(silent: boolean): void {
  const hasOperatorKey =
    process.env[EnvVar.OPERATOR_ACCESS_KEY] &&
    process.env[EnvVar.OPERATOR_SECRET_KEY];
  const hasStandardKey =
    process.env["AWS_ACCESS_KEY_ID"] && process.env["AWS_SECRET_ACCESS_KEY"];
  const hasProfile = process.env["AWS_PROFILE"];

  if (!hasOperatorKey && hasStandardKey) {
    // Auto-promote standard AWS vars to ASSIGNEE_OPERATOR_*.
    process.env[EnvVar.OPERATOR_ACCESS_KEY] = process.env["AWS_ACCESS_KEY_ID"];
    process.env[EnvVar.OPERATOR_SECRET_KEY] =
      process.env["AWS_SECRET_ACCESS_KEY"];
    if (process.env["AWS_SESSION_TOKEN"]) {
      process.env[EnvVar.OPERATOR_SESSION_TOKEN] =
        process.env["AWS_SESSION_TOKEN"];
    }
    if (!silent) {
      process.stderr.write(
        "[33m⚠  Using AWS_ACCESS_KEY_ID — consider running `assignee setup` to create least-privilege IAM users.[0m\n",
      );
    }
    return;
  }

  if (!hasOperatorKey && hasProfile) {
    // W2-02: AWS_PROFILE is now supported via the provider chain.
    // We emit an informational warning and let the async resolver handle it.
    // resolveCredentialsWithProfile() must be called before SDK clients are
    // constructed. Command entry-points that support --profile call it directly.
    if (!silent) {
      process.stderr.write(
        `[33m⚠  AWS_PROFILE="${hasProfile}" detected — resolving credentials via profile chain. ` +
          `For least-privilege isolation run \`assignee setup\` to create ASSIGNEE_OPERATOR_* users.[0m\n`,
      );
    }
    // Return without throwing — the profile is usable; the async promoter
    // (resolveCredentialsWithProfile) will materialize credentials before
    // the first SDK call.
    return;
  }

  if (!hasOperatorKey) {
    throw new ConfigurationError(
      "No AWS credentials detected.\n" +
        "Assignee.ai requires one of:\n" +
        "  • ASSIGNEE_OPERATOR_ACCESS_KEY_ID + ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY (preferred — least privilege)\n" +
        "  • AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (auto-promoted to operator role)\n" +
        "  • AWS_PROFILE=<name> — resolves via ~/.aws/config (supports SSO, assumed-role, static)\n" +
        "  • --profile <name> flag on init/plan/apply/destroy commands\n" +
        "Run `assignee setup` to create least-privilege IAM users.",
    );
  }
}

/**
 * Async variant — resolves AWS_PROFILE / --profile via the fromIni() provider
 * chain and promotes the resulting credentials to ASSIGNEE_OPERATOR_* env vars
 * so the rest of the pipeline (requireAssigneeCredentials, operatorCredentials)
 * finds them in the expected variables.
 *
 * This must be called BEFORE any SDK client is constructed when profile-based
 * authentication is in use. It is a no-op when ASSIGNEE_OPERATOR_* is already
 * set (direct env-var users are unaffected).
 *
 * @param profile - Explicit profile name (from --profile flag). Overrides
 *   AWS_PROFILE env var if both are set.
 * @param silent  - Suppress warning output.
 *
 * @throws ConfigurationError with an actionable SSO login hint on expiry.
 *
 * @see W2-02 — AWS_PROFILE via provider chain (Epic 100)
 */
export async function resolveCredentialsWithProfile(
  profile?: string,
  silent = false,
): Promise<void> {
  const hasOperatorKey =
    process.env[EnvVar.OPERATOR_ACCESS_KEY] &&
    process.env[EnvVar.OPERATOR_SECRET_KEY];

  // Already have explicit operator creds — profile override is a no-op.
  if (hasOperatorKey) return;

  const resolvedProfile =
    profile ?? process.env[EnvVar.AWS_PROFILE] ?? process.env["AWS_PROFILE"];
  if (!resolvedProfile) return;

  try {
    const { fromIni } = await import("@aws-sdk/credential-providers");
    const provider = fromIni({ profile: resolvedProfile });
    const creds = await provider();

    // Promote to ASSIGNEE_OPERATOR_* so the rest of the pipeline sees them.
    process.env[EnvVar.OPERATOR_ACCESS_KEY] = creds.accessKeyId;
    process.env[EnvVar.OPERATOR_SECRET_KEY] = creds.secretAccessKey;
    if (creds.sessionToken) {
      process.env[EnvVar.OPERATOR_SESSION_TOKEN] = creds.sessionToken;
    }

    if (!silent) {
      process.stderr.write(
        `[32m✓  Resolved credentials via profile "${resolvedProfile}".[0m\n`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Detect SSO expiry by checking for known AWS error codes/messages.
    const isExpiry =
      err instanceof Error &&
      (err.name === "ExpiredTokenException" ||
        err.name === "ExpiredToken" ||
        err.name === "TokenRefreshRequired" ||
        msg.toLowerCase().includes("expired") ||
        msg.toLowerCase().includes("sso session") ||
        msg.toLowerCase().includes("token has expired"));

    if (isExpiry) {
      throw new ConfigurationError(
        `Session expired or invalid for profile "${resolvedProfile}". Run:\n` +
          `  aws sso login --profile ${resolvedProfile}\n` +
          `\n` +
          `Then retry the command, or re-export credentials:\n` +
          `  eval $(aws configure export-credentials --profile ${resolvedProfile} --format env)\n` +
          `\n` +
          `Original error: ${msg}`,
      );
    }
    throw new ConfigurationError(
      `Failed to resolve credentials for profile "${resolvedProfile}": ${msg}\n` +
        `Ensure the profile is configured in ~/.aws/config and, for SSO profiles, ` +
        `run \`aws sso login --profile ${resolvedProfile}\` first.`,
    );
  }
}
