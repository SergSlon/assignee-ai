/**
 * Error hierarchy for the Assignee.ai system.
 * All errors carry a machine-readable `code` for structured logging and display.
 *
 * @see project-context.md — Error Handling section
 */

import { getTypeHint } from "./config/supported-types-block.js";

/**
 * Optional construction-time flags for `AssigneeError`.
 *
 * Story 94-R7 (Epic 94 wave 1 fixer): callers that have already
 * routed the human-readable message through `renderError` (or any
 * other structured printer that targets stderr) can set
 * `alreadyRendered: true` so the top-level Commander
 * `parseAsync.catch` in `apps/cli/src/index.ts` skips its fallback
 * `Error: ${err.message}` write. The exit code is still derived from
 * the error — only the duplicate stderr paint is suppressed. Closes
 * D-02 (MED REGRESSION): `list --resource-type <invalid>` was
 * printing the 37-types registry grid twice on stderr.
 */
export interface AssigneeErrorOptions {
  /**
   * Signal to top-level CLI catches that the human-readable form of
   * this error has already been printed. Default: `false` (unchanged
   * behaviour for existing call sites).
   */
  readonly alreadyRendered?: boolean;
}

/**
 * Base error class for all Assignee.ai errors (referred to as `AppError` in story/spec docs).
 */
export class AssigneeError extends Error {
  /**
   * Set when the CLI (or other surface) has already routed this
   * error's human-readable form to the user (typically via
   * `renderError`). Top-level error handlers check this to avoid
   * double-paint. See `AssigneeErrorOptions.alreadyRendered`.
   */
  public readonly alreadyRendered: boolean;

  constructor(
    message: string,
    public readonly code: string,
    options: AssigneeErrorOptions = {},
  ) {
    super(message);
    this.name = "AssigneeError";
    this.alreadyRendered = options.alreadyRendered === true;
  }
}

/** Error communicating with an MCP server process. */
export class McpError extends AssigneeError {
  constructor(message: string, code = "MCP_ERROR") {
    super(message, code);
    this.name = "McpError";
  }
}

/** Error invoking AWS Bedrock (LLM). */
export class BedrockError extends AssigneeError {
  constructor(message: string, code = "BEDROCK_ERROR") {
    super(message, code);
    this.name = "BedrockError";
  }
}

/** Error from any LLM port call (structured or raw text generation). */
export class LlmError extends AssigneeError {
  constructor(message: string, code = "LLM_ERROR") {
    super(message, code);
    this.name = "LlmError";
  }
}

/** Error when live resource state differs from plan-time state. */
export class StateGuardError extends AssigneeError {
  constructor(message: string, code = "STATE_GUARD_ERROR") {
    super(message, code);
    this.name = "StateGuardError";
  }
}

/**
 * Error when a requested resource type is not supported.
 *
 * Story e92-3a (Epic 92 wave 3.a): the message embeds the short
 * single-line hint from `getTypeHint()` rather than a hardcoded
 * supported-types grid. The full grouped grid is reserved for `--help`
 * output; error triples ([ERROR]+[CONTEXT]+[FIX]) must stay compact so
 * short terminals don't scroll the error off-screen (closes finding
 * D-33). The hint is registry-derived via `getTypeHint()` — single
 * source of truth, no drift possible (closes D-32).
 */
export class UnsupportedResourceError extends AssigneeError {
  constructor(resourceType: string) {
    super(
      `Resource type "${resourceType}" is not supported in the current phase. ${getTypeHint()}`,
      "UNSUPPORTED_RESOURCE",
    );
    this.name = "UnsupportedResourceError";
  }
}

/** Error when required configuration (env var, config file) is missing or invalid. */
export class ConfigurationError extends AssigneeError {
  constructor(message: string) {
    super(message, "CONFIGURATION_ERROR");
    this.name = "ConfigurationError";
  }
}

/** Error related to checkpoint save/load/validation. */
export class CheckpointError extends AssigneeError {
  constructor(message: string) {
    super(message, "CHECKPOINT_ERROR");
    this.name = "CheckpointError";
  }
}

/**
 * Error when --no-wizard is set and required fields have no defaults.
 * Lists the missing field names so the user can provide them via intent or remove --no-wizard.
 */
export class MissingRequiredFieldsError extends AssigneeError {
  constructor(public readonly missingFields: string[]) {
    const fieldList = missingFields.join(", ");
    super(
      `Missing required fields with no defaults: ${fieldList}. ` +
        `Provide these values in your intent or remove --no-wizard to use interactive prompts.`,
      "MISSING_REQUIRED_FIELDS",
    );
    this.name = "MissingRequiredFieldsError";
  }
}

/** Error when the user cancels an interactive prompt (Ctrl+C / ESC). */
export class UserCancelledError extends AssigneeError {
  constructor(message = "Operation cancelled by user.") {
    super(message, "USER_CANCELLED");
    this.name = "UserCancelledError";
  }
}

/** Named constants for ProvisioningErrorCode — eliminates magic strings across the codebase. */
export const PROVISIONING_ERROR_CODES = {
  ACCESS_DENIED: "AccessDenied",
  ALREADY_EXISTS: "AlreadyExists",
  NOT_FOUND: "NotFound",
  THROTTLED: "Throttled",
  STATE_MISMATCH: "StateMismatch",
  UNSUPPORTED_TYPE: "UnsupportedType",
  UNKNOWN: "Unknown",
} as const;

export type ProvisioningErrorCode =
  (typeof PROVISIONING_ERROR_CODES)[keyof typeof PROVISIONING_ERROR_CODES];

/** Error from AWS CloudControl resource provisioning. */
export class ProvisioningError extends AssigneeError {
  constructor(
    message: string,
    public readonly provisioningCode: ProvisioningErrorCode,
    public readonly hint?: string,
  ) {
    super(message, "PROVISIONING_ERROR");
    this.name = "ProvisioningError";
  }
}
