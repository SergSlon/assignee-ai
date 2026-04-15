/**
 * Early credential detection and auto-promotion.
 *
 * Extracted from command-runner.ts (Wave 6d F5). SRP: decide between
 *   (a) ASSIGNEE_OPERATOR_*  — preferred
 *   (b) AWS_ACCESS_KEY_ID    — auto-promoted with warning
 *   (c) AWS_PROFILE alone    — rejected with actionable hint
 *   (d) nothing at all       — ConfigurationError with setup instructions
 */
import { ConfigurationError } from "@assignee/core";
import { EnvVar } from "../../constants/env-vars.js";

/**
 * Run the pre-flight credential check. Throws ConfigurationError when no
 * usable credentials are present. Writes a yellow stderr warning when
 * auto-promoting AWS_* vars to ASSIGNEE_OPERATOR_*.
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
      process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] =
        process.env["AWS_SESSION_TOKEN"];
    }
    if (!silent) {
      process.stderr.write(
        "\u001B[33m⚠  Using AWS_ACCESS_KEY_ID — consider running `assignee setup` to create least-privilege IAM users.\u001B[0m\n",
      );
    }
    return;
  }

  if (!hasOperatorKey && hasProfile) {
    if (!silent) {
      process.stderr.write(
        "\u001B[33m⚠  AWS_PROFILE detected but ASSIGNEE_OPERATOR_* not set. Run `assignee setup` for least-privilege users, or export AWS_ACCESS_KEY_ID directly.\u001B[0m\n",
      );
    }
    throw new ConfigurationError(
      "AWS_PROFILE alone is not supported. Export AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY directly, or run `assignee setup` to create ASSIGNEE_OPERATOR_* credentials.",
    );
  }

  if (!hasOperatorKey) {
    throw new ConfigurationError(
      "No AWS credentials detected.\n" +
        "Assignee.ai requires either:\n" +
        "  • ASSIGNEE_OPERATOR_ACCESS_KEY_ID + ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY (preferred — least privilege)\n" +
        "  • AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (will be auto-promoted to operator role)\n" +
        "Note: AWS_PROFILE alone is not currently supported. Run `assignee setup` to create least-privilege IAM users.",
    );
  }
}
