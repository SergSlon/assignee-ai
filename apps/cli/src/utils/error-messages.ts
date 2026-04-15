/**
 * Error Message Registry — maps error codes and categories to structured,
 * human-friendly messages with WHAT / WHY / HOW-TO-FIX.
 *
 * Extends the existing ErrorHintRegistry (Story 9.6) with richer context.
 * Every user-facing error should flow through this registry to ensure
 * consistent quality and actionable fix suggestions.
 *
 * @see Story 18.3 — Error Message Quality Audit
 */

import { AwsErrorName } from "../constants/aws-errors.js";
import { ErrorCode } from "../constants/errors.js";
import { EXAMPLE_S3_INTENT } from "../config/constants.js";
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
  ARN_PATTERN_SOURCE,
} from "@assignee/core";

/* Error codes are now imported from ../constants/errors.js */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ErrorMessageEntry {
  /** Machine-readable error code for programmatic matching. */
  code: string;
  /** WHAT went wrong — a specific, concise error description. */
  what: string;
  /** WHY it happened — contextual explanation for the user. */
  why: string;
  /** HOW TO FIX — actionable suggestion the user can follow immediately. */
  howToFix: string;
  /** Optional link to documentation or runbook. */
  docLink?: string;
}

// ── AWS Provisioning Error Messages ──────────────────────────────────────────

const AWS_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [PROVISIONING_ERROR_CODES.ALREADY_EXISTS]: {
    code: PROVISIONING_ERROR_CODES.ALREADY_EXISTS,
    what: "A resource with this name already exists in your AWS account.",
    why: "AWS rejected the create request because an identical resource identifier is already in use.",
    howToFix: `Choose a different resource name in your intent, or run \`assignee plan\` with a unique name (e.g., "${EXAMPLE_S3_INTENT}-v2").`,
  },
  [PROVISIONING_ERROR_CODES.NOT_FOUND]: {
    code: PROVISIONING_ERROR_CODES.NOT_FOUND,
    what: "The target resource was not found in AWS.",
    why: "The resource was deleted or never created. This can happen if the plan is stale or the resource was removed outside of assignee.ai.",
    howToFix:
      "Re-run `assignee plan` to generate a fresh plan against the current state of your AWS account.",
  },
  [PROVISIONING_ERROR_CODES.THROTTLED]: {
    code: PROVISIONING_ERROR_CODES.THROTTLED,
    what: "AWS is rate-limiting your requests.",
    why: "Too many API calls were made in a short period. AWS CloudControl API has per-account request limits.",
    howToFix:
      "Wait 30-60 seconds and retry. If this persists, check your AWS account service quotas at https://console.aws.amazon.com/servicequotas/.",
  },
  [PROVISIONING_ERROR_CODES.STATE_MISMATCH]: {
    code: PROVISIONING_ERROR_CODES.STATE_MISMATCH,
    what: "Resource already exists.",
    why: "A resource with the same identifier already exists in your AWS account.",
    howToFix: "Choose a different name and re-run 'assignee plan'.",
  },
  [PROVISIONING_ERROR_CODES.UNSUPPORTED_TYPE]: {
    code: PROVISIONING_ERROR_CODES.UNSUPPORTED_TYPE,
    what: "This resource type is not supported by AWS CloudControl API.",
    why: "Some AWS resource types require native SDK calls or have known CCAPI gaps.",
    howToFix:
      "Check the error message for an alternative resource type suggestion. If none is provided, this resource type may not yet be supported by assignee.ai.",
  },
  [AwsErrorName.BUCKET_ALREADY_EXISTS]: {
    code: AwsErrorName.BUCKET_ALREADY_EXISTS,
    what: "An S3 bucket with this name already exists globally.",
    why: "S3 bucket names are globally unique across all AWS accounts. Another account may own this name.",
    howToFix:
      'Choose a more specific bucket name (e.g., "my-company-logs-2026") or add a random suffix.',
  },
  [AwsErrorName.BUCKET_NAME_NOT_AVAILABLE]: {
    code: AwsErrorName.BUCKET_NAME_NOT_AVAILABLE,
    what: "The requested S3 bucket name is not available.",
    why: "The S3 bucket name is already taken by another AWS account. S3 bucket names are globally unique across all AWS accounts.",
    howToFix:
      "Choose a different bucket name and re-run the command. Tip: use a prefix like your org name (e.g., myorg-my-bucket).",
  },
  [AwsErrorName.ACCESS_DENIED_SHORT]: {
    code: AwsErrorName.ACCESS_DENIED_SHORT,
    what: "AWS denied access to perform this operation.",
    why: "The IAM credentials used by assignee.ai lack the required permissions for this resource type or action.",
    howToFix:
      "Verify that the ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY credentials have the necessary IAM permissions. Run `assignee setup` to create properly scoped IAM users.",
  },
  [AwsErrorName.INVALID_PARAMETER_VALUE]: {
    code: AwsErrorName.INVALID_PARAMETER_VALUE,
    what: "One or more resource parameters have invalid values.",
    why: "The configuration values in your plan do not meet AWS validation requirements for this resource type.",
    howToFix:
      'Rephrase your intent with valid parameter values. For example, ensure ARNs are correctly formatted and instance types exist in your region (e.g., "t3.micro" instead of "t3.invalid").',
  },
  [AwsErrorName.THROTTLING]: {
    code: AwsErrorName.THROTTLING,
    what: "AWS is throttling your API requests.",
    why: "You have exceeded the AWS API rate limit for this service.",
    howToFix:
      "Wait 30-60 seconds and retry. Consider reducing concurrent operations.",
  },
  [AwsErrorName.RESOURCE_NOT_FOUND]: {
    code: AwsErrorName.RESOURCE_NOT_FOUND,
    what: "The referenced AWS resource does not exist.",
    why: "A resource ARN or identifier in your plan refers to a resource that has been deleted or was never created.",
    howToFix:
      "Verify that all referenced resources (IAM roles, VPCs, subnets, etc.) exist in your AWS account and region. Re-run `assignee plan` to refresh.",
  },
  [AwsErrorName.VALIDATION_EXCEPTION]: {
    code: AwsErrorName.VALIDATION_EXCEPTION,
    what: "AWS request validation failed.",
    why: "The request payload does not conform to the AWS service's validation rules.",
    howToFix:
      "Check your intent for typos or unsupported configuration values. Try simplifying your request and adding parameters incrementally.",
  },
};

// ── Configuration Error Messages ─────────────────────────────────────────────

const CONFIG_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [ErrorCode.MISSING_ACCESS_KEY]: {
    code: ErrorCode.MISSING_ACCESS_KEY,
    what: "AWS access key ID is not configured.",
    why: "The ASSIGNEE_OPERATOR_ACCESS_KEY_ID environment variable is missing or empty. Assignee.ai requires operator credentials to interact with your account.",
    howToFix:
      "Set the ASSIGNEE_OPERATOR_ACCESS_KEY_ID environment variable:\n  export ASSIGNEE_OPERATOR_ACCESS_KEY_ID=AKIA...\nOr run `assignee setup` to create IAM users and credentials.",
  },
  [ErrorCode.MISSING_SECRET_KEY]: {
    code: ErrorCode.MISSING_SECRET_KEY,
    what: "AWS secret access key is not configured.",
    why: "The ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variable is missing or empty.",
    howToFix:
      "Set the ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variable:\n  export ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=...\nOr run `assignee setup` to create IAM users and credentials.",
  },
  [ErrorCode.MISSING_REGION]: {
    code: ErrorCode.MISSING_REGION,
    what: "AWS region is not configured.",
    why: "The AWS_REGION environment variable is missing or empty. Assignee.ai needs to know which region to provision resources in.",
    howToFix:
      "Set the AWS_REGION environment variable:\n  export AWS_REGION=us-east-1\nOr run `assignee init` to configure your region.",
  },
  INVALID_YAML: {
    code: ErrorCode.INVALID_YAML,
    what: "Configuration file contains invalid YAML.",
    why: "The config.yaml file could not be parsed. It may contain syntax errors such as incorrect indentation or invalid characters.",
    howToFix:
      "Check your config file at ~/.config/assignee/config.yaml (or $ASSIGNEE_CONFIG_DIR/config.yaml) for YAML syntax errors. Use a YAML linter to validate.",
  },
  [ErrorCode.MISSING_CREDENTIALS]: {
    code: ErrorCode.MISSING_CREDENTIALS,
    what: "No AWS credentials detected.",
    why: "Assignee.ai could not find operator credentials from ASSIGNEE_OPERATOR_* environment variables.",
    howToFix:
      "Configure credentials via one of:\n  1) ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables\n  2) Run `assignee setup` to create IAM users and credentials\nThen run `assignee init` to verify.",
  },
};

// ── LLM / Bedrock Error Messages ─────────────────────────────────────────────

const LLM_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [ErrorCode.LLM_TIMEOUT]: {
    code: ErrorCode.LLM_TIMEOUT,
    what: "The LLM request timed out.",
    why: "The AI model did not respond within the expected time limit. This can happen during high load or with complex requests.",
    howToFix:
      "Retry the command. If it persists, try a simpler intent or check your network connection to AWS Bedrock.",
  },
  [ErrorCode.LLM_RATE_LIMIT]: {
    code: ErrorCode.LLM_RATE_LIMIT,
    what: "LLM API rate limit exceeded.",
    why: "Too many requests were sent to the AI model provider in a short period.",
    howToFix:
      "Wait 30-60 seconds and retry. If you consistently hit rate limits, consider requesting a quota increase for your Bedrock model.",
  },
  [ErrorCode.LLM_INVALID_RESPONSE]: {
    code: ErrorCode.LLM_INVALID_RESPONSE,
    what: "The LLM returned an invalid or unparseable response.",
    why: "The AI model generated output that could not be parsed as valid JSON. This is a transient model behavior issue.",
    howToFix:
      "Retry the command. If it persists, try rephrasing your intent to be more specific.",
  },
  [ErrorCode.BEDROCK_CONNECTIVITY]: {
    code: ErrorCode.BEDROCK_CONNECTIVITY,
    what: "Cannot connect to AWS Bedrock.",
    why: "The connection to AWS Bedrock failed. This could be a network issue, incorrect region, or missing Bedrock model access.",
    howToFix:
      "Verify that:\n  1) Your AWS_REGION supports Bedrock (e.g., us-east-1, us-west-2)\n  2) The Bedrock model is enabled in your account (check AWS Console > Bedrock > Model access)\n  3) Your IAM credentials have bedrock:InvokeModel permission",
  },
  [ErrorCode.LLM_API_KEY_INVALID]: {
    code: ErrorCode.LLM_API_KEY_INVALID,
    what: "LLM API key is invalid or expired.",
    why: "The AI model provider rejected the API credentials.",
    howToFix:
      "Check and update your LLM API key. For Bedrock, verify your AWS credentials are current and have Bedrock permissions.",
  },
};

// ── MCP Server Error Messages ────────────────────────────────────────────────

const MCP_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [ErrorCode.MCP_STARTUP_FAILED]: {
    code: ErrorCode.MCP_STARTUP_FAILED,
    what: "An MCP server failed to start.",
    why: "One of the required MCP server processes could not be launched. It may not be installed or the binary path may be incorrect.",
    howToFix:
      "Ensure all MCP servers are installed. Run `npx` for the failing server to verify it is available. Check the error message above for the specific server name.",
  },
  [ErrorCode.MCP_TOOL_NOT_FOUND]: {
    code: ErrorCode.MCP_TOOL_NOT_FOUND,
    what: "A required MCP tool is not available.",
    why: "The MCP server is running but does not expose the expected tool. The server version may be incompatible.",
    howToFix:
      "Update your MCP server packages to the latest version and restart assignee.ai.",
  },
  [ErrorCode.CFN_MCP_UNAVAILABLE]: {
    code: ErrorCode.CFN_MCP_UNAVAILABLE,
    what: "The CloudFormation schema service is not available.",
    why: "The CloudFormation DescribeType SDK call failed. Schema fetching uses the AWS SDK directly to fetch resource type schemas for plan generation.",
    howToFix:
      "Verify your ASSIGNEE_OPERATOR credentials have cloudformation:DescribeType permission and check network connectivity.",
  },
};

// ── Checkpoint Error Messages ────────────────────────────────────────────────

const CHECKPOINT_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [ErrorCode.CHECKPOINT_NOT_FOUND]: {
    code: ErrorCode.CHECKPOINT_NOT_FOUND,
    what: "No plan checkpoint file found.",
    why: "The specified checkpoint file does not exist at the given path.",
    howToFix:
      "Run `assignee plan` first to create a checkpoint, then use `assignee apply --checkpoint <path>` to apply it.",
  },
  [ErrorCode.CHECKPOINT_EXPIRED]: {
    code: ErrorCode.CHECKPOINT_EXPIRED,
    what: "The plan checkpoint has expired.",
    why: "Checkpoints have a TTL to ensure plans reflect current AWS state. This checkpoint was created too long ago.",
    howToFix: "Run `assignee plan` to generate a fresh plan, then apply it.",
  },
  [ErrorCode.CHECKPOINT_INVALID]: {
    code: ErrorCode.CHECKPOINT_INVALID,
    what: "The checkpoint file is corrupted or has an incompatible format.",
    why: "The checkpoint file could not be parsed or does not match the expected schema version.",
    howToFix:
      "Delete the corrupted checkpoint and run `assignee plan` to create a new one.",
  },
};

// ── Generic / Fallback Error Messages ────────────────────────────────────────

const GENERIC_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [ErrorCode.UNKNOWN]: {
    code: ErrorCode.UNKNOWN,
    what: "An unexpected error occurred.",
    why: "An unclassified error was encountered. This may be a bug or an unusual edge case.",
    howToFix:
      "Retry the command. If it persists, run with ASSIGNEE_LOG_LEVEL=debug for more details and report the issue at https://github.com/assignee-ai/assignee.ai/issues.",
  },
  [ErrorCode.MISSING_INTENT]: {
    code: ErrorCode.MISSING_INTENT,
    what: "No intent was provided.",
    why: "The command requires a natural language description of what you want to create.",
    howToFix: `Provide an intent in quotes: \`assignee plan "${EXAMPLE_S3_INTENT}"\``,
  },
  [ErrorCode.UNSUPPORTED_RESOURCE]: {
    code: ErrorCode.UNSUPPORTED_RESOURCE,
    what: "The requested resource type is not supported.",
    why: "Assignee.ai currently supports a subset of AWS resource types. The resource you requested is not in the supported set.",
    howToFix:
      "Run `assignee plan --help` to see the list of supported resource types. Try rephrasing your intent to use a supported type.",
  },
  [ErrorCode.MISSING_REQUIRED_FIELDS]: {
    code: ErrorCode.MISSING_REQUIRED_FIELDS,
    what: "Required resource fields are missing.",
    why: "The --no-wizard flag was used but some required fields have no defaults and were not provided in the intent.",
    howToFix:
      "Either include the missing field values in your intent, or remove --no-wizard to use interactive prompts.",
  },
  [ErrorCode.NON_INTERACTIVE_NO_YES]: {
    code: ErrorCode.NON_INTERACTIVE_NO_YES,
    what: "Apply requires confirmation but no interactive terminal is available.",
    why: "The apply command was run in a non-interactive environment (CI/CD pipeline) without the --yes flag.",
    howToFix:
      'Add the --yes flag for non-interactive use: `assignee apply --yes "your intent"`',
  },
};

// ── Registry Class ───────────────────────────────────────────────────────────

/**
 * Unified error message registry that resolves any error into a structured
 * WHAT / WHY / HOW-TO-FIX message.
 *
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
    // Register all entries
    for (const entry of Object.values(AWS_ERROR_MESSAGES)) {
      this.entries.set(entry.code, entry);
    }
    for (const entry of Object.values(CONFIG_ERROR_MESSAGES)) {
      this.entries.set(entry.code, entry);
    }
    for (const entry of Object.values(LLM_ERROR_MESSAGES)) {
      this.entries.set(entry.code, entry);
    }
    for (const entry of Object.values(MCP_ERROR_MESSAGES)) {
      this.entries.set(entry.code, entry);
    }
    for (const entry of Object.values(CHECKPOINT_ERROR_MESSAGES)) {
      this.entries.set(entry.code, entry);
    }
    for (const entry of Object.values(GENERIC_ERROR_MESSAGES)) {
      this.entries.set(entry.code, entry);
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
  resolve(error: unknown): ErrorMessageEntry {
    if (error instanceof ProvisioningError) {
      // Try provisioning code first
      const entry = this.entries.get(error.provisioningCode);
      if (entry) return entry;

      // Try matching AWS error names embedded in the message
      const awsMatch = this.matchAwsErrorName(error.message);
      if (awsMatch) return awsMatch;

      return this.unknownWithMessage(error.message);
    }

    if (error instanceof ConfigurationError) {
      const configEntry = this.matchConfigError(error.message);
      if (configEntry) return configEntry;
      return this.unknownWithMessage(error.message);
    }

    if (error instanceof LlmError || error instanceof BedrockError) {
      const llmEntry = this.matchLlmError(error.message);
      if (llmEntry) return llmEntry;
      return this.unknownWithMessage(error.message);
    }

    if (error instanceof McpError) {
      const mcpEntry = this.matchMcpError(error.message);
      if (mcpEntry) return mcpEntry;
      return this.unknownWithMessage(error.message);
    }

    if (error instanceof CheckpointError) {
      const cpEntry = this.matchCheckpointError(error.message);
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
      // Try to match known patterns in generic Error messages
      const awsMatch = this.matchAwsErrorName(error.message);
      if (awsMatch) return awsMatch;
      return this.unknownWithMessage(error.message);
    }

    if (typeof error === "string") {
      const awsMatch = this.matchAwsErrorName(error);
      if (awsMatch) return awsMatch;
      return this.unknownWithMessage(error);
    }

    return this.fallback();
  }

  /**
   * Resolves an errorMessage string (from graph state) into a structured
   * ErrorMessageEntry. Attempts pattern matching against known error messages.
   */
  resolveMessage(errorMessage: string): ErrorMessageEntry {
    // Try AWS error patterns
    const awsMatch = this.matchAwsErrorName(errorMessage);
    if (awsMatch) return awsMatch;

    // Try config patterns
    const configMatch = this.matchConfigError(errorMessage);
    if (configMatch) return configMatch;

    // Try LLM patterns
    const llmMatch = this.matchLlmError(errorMessage);
    if (llmMatch) return llmMatch;

    // Try MCP patterns
    const mcpMatch = this.matchMcpError(errorMessage);
    if (mcpMatch) return mcpMatch;

    // Try checkpoint patterns
    const cpMatch = this.matchCheckpointError(errorMessage);
    if (cpMatch) return cpMatch;

    // Try specific known error message patterns
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

  // ── Private matchers ─────────────────────────────────────────────────────

  private matchAwsErrorName(message: string): ErrorMessageEntry | undefined {
    const awsPatterns: Array<[RegExp | string, string]> = [
      ["bucket name is not available", AwsErrorName.BUCKET_NAME_NOT_AVAILABLE],
      ["bucket name is already taken", AwsErrorName.BUCKET_NAME_NOT_AVAILABLE],
      [AwsErrorName.BUCKET_ALREADY_EXISTS, AwsErrorName.BUCKET_ALREADY_EXISTS],
      [AwsErrorName.BUCKET_ALREADY_OWNED, AwsErrorName.BUCKET_ALREADY_EXISTS],
      [AwsErrorName.ACCESS_DENIED_SHORT, AwsErrorName.ACCESS_DENIED_SHORT],
      [AwsErrorName.ACCESS_DENIED, AwsErrorName.ACCESS_DENIED_SHORT],
      [
        AwsErrorName.INVALID_PARAMETER_VALUE,
        AwsErrorName.INVALID_PARAMETER_VALUE,
      ],
      [AwsErrorName.INVALID_PARAMETER, AwsErrorName.INVALID_PARAMETER_VALUE],
      [AwsErrorName.THROTTLING, AwsErrorName.THROTTLING],
      [AwsErrorName.RESOURCE_NOT_FOUND, AwsErrorName.RESOURCE_NOT_FOUND],
      [AwsErrorName.VALIDATION_EXCEPTION, AwsErrorName.VALIDATION_EXCEPTION],
      [
        "TagValue you have provided is invalid",
        AwsErrorName.INVALID_PARAMETER_VALUE,
      ],
      [
        "TagKey you have provided is invalid",
        AwsErrorName.INVALID_PARAMETER_VALUE,
      ],
      ["Resource already exists", PROVISIONING_ERROR_CODES.ALREADY_EXISTS],
      ["already exists", PROVISIONING_ERROR_CODES.ALREADY_EXISTS],
      ["Request throttled", PROVISIONING_ERROR_CODES.THROTTLED],
      [AwsErrorName.RATE_EXCEEDED, AwsErrorName.THROTTLING],
    ];

    for (const [pattern, code] of awsPatterns) {
      if (
        typeof pattern === "string"
          ? message.includes(pattern)
          : pattern.test(message)
      ) {
        return this.entries.get(code);
      }
    }
    return undefined;
  }

  private matchConfigError(message: string): ErrorMessageEntry | undefined {
    if (
      message.includes("ASSIGNEE_OPERATOR_ACCESS_KEY_ID") ||
      message.includes("access key")
    ) {
      return this.entries.get(ErrorCode.MISSING_ACCESS_KEY);
    }
    if (
      message.includes("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY") ||
      message.includes("secret key")
    ) {
      return this.entries.get(ErrorCode.MISSING_SECRET_KEY);
    }
    if (
      message.includes("AWS_REGION") ||
      message.includes("region is missing")
    ) {
      return this.entries.get(ErrorCode.MISSING_REGION);
    }
    if (
      message.includes("YAML") ||
      message.includes("yaml") ||
      message.includes("parse")
    ) {
      return this.entries.get(ErrorCode.INVALID_YAML);
    }
    if (
      message.includes("No AWS credentials") ||
      message.includes("credentials")
    ) {
      return this.entries.get(ErrorCode.MISSING_CREDENTIALS);
    }
    return undefined;
  }

  private matchLlmError(message: string): ErrorMessageEntry | undefined {
    if (message.includes("timeout") || message.includes("timed out")) {
      return this.entries.get(ErrorCode.LLM_TIMEOUT);
    }
    if (
      message.includes("rate limit") ||
      message.includes(AwsErrorName.RATE_EXCEEDED) ||
      message.includes(AwsErrorName.THROTTLING)
    ) {
      return this.entries.get(ErrorCode.LLM_RATE_LIMIT);
    }
    if (
      message.includes("invalid JSON") ||
      message.includes("Invalid response") ||
      message.includes("could not be parsed")
    ) {
      return this.entries.get(ErrorCode.LLM_INVALID_RESPONSE);
    }
    if (
      message.includes("Bedrock") ||
      message.includes("bedrock") ||
      message.includes("connectivity")
    ) {
      return this.entries.get(ErrorCode.BEDROCK_CONNECTIVITY);
    }
    if (
      message.includes("API key") ||
      message.includes("api key") ||
      message.includes("UnrecognizedClientException")
    ) {
      return this.entries.get(ErrorCode.LLM_API_KEY_INVALID);
    }
    return undefined;
  }

  private matchMcpError(message: string): ErrorMessageEntry | undefined {
    if (
      message.includes("failed to start") ||
      message.includes("MCP_STARTUP")
    ) {
      return this.entries.get(ErrorCode.MCP_STARTUP_FAILED);
    }
    if (
      message.includes(AwsErrorName.SCHEMA_FETCH_ERROR) ||
      message.includes("DescribeType") ||
      message.includes("Schema fetch failed")
    ) {
      return this.entries.get(ErrorCode.CFN_MCP_UNAVAILABLE);
    }
    if (
      message.includes("tool") &&
      (message.includes("not found") || message.includes("not available"))
    ) {
      return this.entries.get(ErrorCode.MCP_TOOL_NOT_FOUND);
    }
    return undefined;
  }

  private matchCheckpointError(message: string): ErrorMessageEntry | undefined {
    // Only match checkpoint-specific patterns — avoid broad substring matches
    // that incorrectly classify AWS service errors (e.g. "TagValue is invalid").
    const lc = message.toLowerCase();
    const isCheckpointContext =
      lc.includes("checkpoint") || lc.includes("plan file");

    if (
      isCheckpointContext &&
      (lc.includes("not found") ||
        lc.includes("enoent") ||
        lc.includes("no such file"))
    ) {
      return this.entries.get(ErrorCode.CHECKPOINT_NOT_FOUND);
    }
    if (isCheckpointContext && (lc.includes("expired") || lc.includes("ttl"))) {
      return this.entries.get(ErrorCode.CHECKPOINT_EXPIRED);
    }
    if (
      isCheckpointContext &&
      (lc.includes("invalid") ||
        lc.includes("corrupt") ||
        lc.includes("schema"))
    ) {
      return this.entries.get(ErrorCode.CHECKPOINT_INVALID);
    }
    return undefined;
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

// ── Sensitive-data redaction (M-S5) ─────────────────────────────────────────

// Partition-aware ARN redaction pattern — accepts aws, aws-cn, aws-us-gov,
// aws-iso, aws-iso-b (via ARN_PATTERN_SOURCE = "arn:aws[\\w-]*:"). See
// feedback_partition_aware_arn_matching memory and the canonical helper in
// packages/core/src/config/aws-partition.ts.
const ARN_PATTERN = new RegExp(
  `${ARN_PATTERN_SOURCE}[a-z0-9-]+:[a-z0-9-]*:\\d{12}:[^\\s]*`,
  "g",
);
const ACCOUNT_ID_PATTERN = /\b\d{12}\b/g;

/**
 * Redacts sensitive identifiers (12-digit account IDs and full ARNs) from
 * an error message before displaying it to the user or forwarding to logs.
 *
 * Order matters: ARNs are redacted first (because they CONTAIN account IDs)
 * and the remaining bare account IDs are scrubbed afterwards.
 *
 * @see SECURITY-AUDIT.md — M-S5
 */
export function redactSensitive(message: string): string {
  if (!message) return message;
  return message
    .replace(ARN_PATTERN, "[ARN]")
    .replace(ACCOUNT_ID_PATTERN, "[ACCOUNT]");
}

// ── Formatting Helpers ───────────────────────────────────────────────────────

/**
 * Formats an ErrorMessageEntry into a structured multi-line string for TTY display.
 * Uses ANSI color codes via chalk integration in the display layer.
 *
 * Returns an object with the three parts for the display layer to render
 * with appropriate colors.
 */
export interface FormattedError {
  what: string;
  why: string;
  howToFix: string;
}

/**
 * Converts an ErrorMessageEntry into a FormattedError for the display layer.
 */
export function formatErrorParts(entry: ErrorMessageEntry): FormattedError {
  return {
    what: entry.what,
    why: entry.why,
    howToFix: entry.howToFix,
  };
}
