/**
 * ErrorMessageRegistry — unified resolver that maps any thrown error to a
 * structured WHAT / WHY / HOW-TO-FIX entry. Decomposed from the original
 * monolith in utils/error-messages.ts; catalogs live alongside in this
 * folder and each matcher function is a pure helper in ./matchers.ts.
 */

import { ErrorCode } from "../../constants/errors.js";
import {
  AssigneeError,
  ProvisioningError,
  McpError,
  BedrockError,
  LlmError,
  ConfigurationError,
  CheckpointError,
  UnsupportedResourceError,
  StateGuardError,
  MissingRequiredFieldsError,
  PROVISIONING_ERROR_CODES,
} from "../../errors.js";
import type { ErrorMessageEntry, ErrorResolveContext } from "./types.js";
import { applyContext } from "./interpolation.js";
import { AWS_ERROR_MESSAGES } from "./catalog-aws.js";
import { CONFIG_ERROR_MESSAGES } from "./catalog-config.js";
import { LLM_ERROR_MESSAGES } from "./catalog-llm.js";
import { MCP_ERROR_MESSAGES } from "./catalog-mcp.js";
import { CHECKPOINT_ERROR_MESSAGES } from "./catalog-checkpoint.js";
import { GENERIC_ERROR_MESSAGES } from "./catalog-generic.js";
import {
  matchAwsErrorName,
  matchConfigError,
  matchLlmError,
  matchMcpError,
  matchCheckpointError,
} from "./matchers.js";

/**
 * Resolution order:
 * 1. ProvisioningError → match by provisioningCode
 * 2. ConfigurationError → match by message substring
 * 3. LlmError / BedrockError → match by message substring
 * 4. McpError → match by message substring
 * 5. CheckpointError → match by message substring
 * 6. Other AssigneeError → match by code
 * 7. Fallback → generic helpful message
 */
export class ErrorMessageRegistry {
  private readonly entries = new Map<string, ErrorMessageEntry>();

  constructor() {
    const catalogs = [
      AWS_ERROR_MESSAGES,
      CONFIG_ERROR_MESSAGES,
      LLM_ERROR_MESSAGES,
      MCP_ERROR_MESSAGES,
      CHECKPOINT_ERROR_MESSAGES,
      GENERIC_ERROR_MESSAGES,
    ];
    for (const cat of catalogs) {
      for (const entry of Object.values(cat)) {
        this.entries.set(entry.code, entry);
      }
    }
  }

  /** Look up an entry by its code. */
  get(code: string): ErrorMessageEntry | undefined {
    return this.entries.get(code);
  }

  /** Return all registered entries (for testing). */
  allEntries(): ErrorMessageEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Resolves an error (AssigneeError, raw Error, or string) into a
   * structured ErrorMessageEntry. Always returns a valid entry — falls
   * back to a generic helpful message for unknown errors.
   */
  resolve(error: unknown, context?: ErrorResolveContext): ErrorMessageEntry {
    const entry = this.resolveRaw(error);
    return applyContext(entry, context);
  }

  private resolveRaw(error: unknown): ErrorMessageEntry {
    const lookup = (code: string) => this.entries.get(code);

    if (error instanceof ProvisioningError) {
      const entry = this.entries.get(error.provisioningCode);
      if (entry) return entry;
      const awsMatch = matchAwsErrorName(error.message, lookup);
      if (awsMatch) return awsMatch;
      return this.unknownWithMessage(error.message);
    }

    if (error instanceof ConfigurationError) {
      const configEntry = matchConfigError(error.message, lookup);
      if (configEntry) return configEntry;
      return this.unknownWithMessage(error.message);
    }

    if (error instanceof LlmError || error instanceof BedrockError) {
      const llmEntry = matchLlmError(error.message, lookup);
      if (llmEntry) return llmEntry;
      return this.unknownWithMessage(error.message);
    }

    if (error instanceof McpError) {
      const mcpEntry = matchMcpError(error.message, lookup);
      if (mcpEntry) return mcpEntry;
      return this.unknownWithMessage(error.message);
    }

    if (error instanceof CheckpointError) {
      const cpEntry = matchCheckpointError(error.message, lookup);
      if (cpEntry) return cpEntry;
      return this.unknownWithMessage(error.message);
    }

    if (error instanceof UnsupportedResourceError) {
      return (
        this.entries.get(ErrorCode.UNSUPPORTED_RESOURCE) ?? this.fallback()
      );
    }

    if (error instanceof MissingRequiredFieldsError) {
      return (
        this.entries.get(ErrorCode.MISSING_REQUIRED_FIELDS) ?? this.fallback()
      );
    }

    if (error instanceof StateGuardError) {
      return (
        this.entries.get(PROVISIONING_ERROR_CODES.STATE_MISMATCH) ??
        this.fallback()
      );
    }

    if (error instanceof AssigneeError) {
      const byCode = this.entries.get(error.code);
      if (byCode) return byCode;
      return this.unknownWithMessage(error.message);
    }

    if (error instanceof Error) {
      const awsMatch = matchAwsErrorName(error.message, lookup);
      if (awsMatch) return awsMatch;
      return this.unknownWithMessage(error.message);
    }

    if (typeof error === "string") {
      const awsMatch = matchAwsErrorName(error, lookup);
      if (awsMatch) return awsMatch;
      return this.unknownWithMessage(error);
    }

    return this.fallback();
  }

  /**
   * Resolves an errorMessage string (from graph state) into a structured
   * ErrorMessageEntry. Attempts pattern matching against known error messages.
   */
  resolveMessage(
    errorMessage: string,
    context?: ErrorResolveContext,
  ): ErrorMessageEntry {
    return applyContext(this.resolveMessageRaw(errorMessage), context);
  }

  private resolveMessageRaw(errorMessage: string): ErrorMessageEntry {
    const lookup = (code: string) => this.entries.get(code);

    const awsMatch = matchAwsErrorName(errorMessage, lookup);
    if (awsMatch) return awsMatch;

    const configMatch = matchConfigError(errorMessage, lookup);
    if (configMatch) return configMatch;

    const llmMatch = matchLlmError(errorMessage, lookup);
    if (llmMatch) return llmMatch;

    const mcpMatch = matchMcpError(errorMessage, lookup);
    if (mcpMatch) return mcpMatch;

    const cpMatch = matchCheckpointError(errorMessage, lookup);
    if (cpMatch) return cpMatch;

    if (errorMessage.includes("Unsupported resource type")) {
      return (
        this.entries.get(ErrorCode.UNSUPPORTED_RESOURCE) ?? this.fallback()
      );
    }
    if (errorMessage.includes("Missing required fields")) {
      return (
        this.entries.get(ErrorCode.MISSING_REQUIRED_FIELDS) ?? this.fallback()
      );
    }
    if (errorMessage.includes("--yes")) {
      return (
        this.entries.get(ErrorCode.NON_INTERACTIVE_NO_YES) ?? this.fallback()
      );
    }
    if (
      errorMessage.includes("Plan generator returned invalid JSON") ||
      errorMessage.includes("invalid JSON")
    ) {
      return (
        this.entries.get(ErrorCode.LLM_INVALID_RESPONSE) ?? this.fallback()
      );
    }

    return this.unknownWithMessage(errorMessage);
  }

  private unknownWithMessage(message: string): ErrorMessageEntry {
    const fallback = this.fallback();
    return {
      ...fallback,
      what: message || fallback.what,
    };
  }

  private fallback(): ErrorMessageEntry {
    return (
      this.entries.get(ErrorCode.UNKNOWN) ?? {
        code: ErrorCode.UNKNOWN,
        what: "An unexpected error occurred.",
        why: "An unclassified error was encountered.",
        howToFix:
          "Retry the command. If it persists, run with ASSIGNEE_LOG_LEVEL=debug for more details.",
      }
    );
  }
}

/** Singleton default registry instance. */
export const defaultErrorMessageRegistry = new ErrorMessageRegistry();
