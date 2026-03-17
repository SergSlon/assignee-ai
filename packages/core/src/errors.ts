/**
 * Error hierarchy for the Assignee.ai system.
 * All errors carry a machine-readable `code` for structured logging and display.
 *
 * @see project-context.md — Error Handling section
 */

export class AssigneeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AssigneeError";
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

/** Error when live resource state differs from plan-time state. */
export class StateGuardError extends AssigneeError {
  constructor(message: string, code = "STATE_GUARD_ERROR") {
    super(message, code);
    this.name = "StateGuardError";
  }
}

/** Error when a requested resource type is not supported. */
export class UnsupportedResourceError extends AssigneeError {
  constructor(resourceType: string) {
    super(
      `Resource type "${resourceType}" is not supported in the current phase.`,
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

export type ProvisioningErrorCode =
  | "AlreadyExists"
  | "NotFound"
  | "Throttled"
  | "StateMismatch"
  | "Unknown";

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
