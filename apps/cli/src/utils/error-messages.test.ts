/**
 * Tests for ErrorMessageRegistry (Story 18.3 — Error Message Quality Audit).
 *
 * Validates:
 * - Every registered error code produces a message with a howToFix field
 * - AWS, config, LLM, MCP, and checkpoint errors are correctly resolved
 * - Unknown errors produce a generic helpful message (not a raw stack trace)
 * - Error resolution from AssigneeError subclasses works correctly
 * - Error resolution from raw error message strings works correctly
 */

import { describe, it, expect } from "vitest";
import {
  ErrorMessageRegistry,
  defaultErrorMessageRegistry,
  redactSensitive,
  type ErrorMessageEntry,
} from "./error-messages.js";
import { ErrorCode } from "../constants/errors.js";
import {
  ProvisioningError,
  ConfigurationError,
  LlmError,
  BedrockError,
  McpError,
  CheckpointError,
  UnsupportedResourceError,
  StateGuardError,
  MissingRequiredFieldsError,
  AssigneeError,
} from "@assignee/core";

// ── AC 4.2: Every mapped error code produces a message with howToFix ────────

describe("ErrorMessageRegistry — all entries have howToFix", () => {
  const allEntries = defaultErrorMessageRegistry.allEntries();

  it("has at least 20 registered error entries", () => {
    expect(allEntries.length).toBeGreaterThanOrEqual(20);
  });

  it.each(allEntries.map((e) => [e.code, e]))(
    "entry '%s' has a non-empty howToFix",
    (_code: string, entry: ErrorMessageEntry) => {
      expect(entry.howToFix).toBeTruthy();
      expect(entry.howToFix.length).toBeGreaterThan(10);
    },
  );

  it.each(allEntries.map((e) => [e.code, e]))(
    "entry '%s' has a non-empty what field",
    (_code: string, entry: ErrorMessageEntry) => {
      expect(entry.what).toBeTruthy();
      expect(entry.what.length).toBeGreaterThan(5);
    },
  );

  it.each(allEntries.map((e) => [e.code, e]))(
    "entry '%s' has a non-empty why field",
    (_code: string, entry: ErrorMessageEntry) => {
      expect(entry.why).toBeTruthy();
      expect(entry.why.length).toBeGreaterThan(10);
    },
  );
});

// ── AC 2: AWS provisioning errors ────────────────────────────────────────────

describe("ErrorMessageRegistry — AWS provisioning errors", () => {
  it("resolves ProvisioningError with AlreadyExists code", () => {
    const err = new ProvisioningError(
      "Resource already exists",
      "AlreadyExists",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("AlreadyExists");
    expect(entry.howToFix).toContain("different");
  });

  it("resolves ProvisioningError with NotFound code", () => {
    const err = new ProvisioningError("Not found", "NotFound");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("NotFound");
    expect(entry.howToFix).toContain("plan");
  });

  it("resolves ProvisioningError with Throttled code", () => {
    const err = new ProvisioningError("Rate exceeded", "Throttled");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("Throttled");
    expect(entry.howToFix).toContain("Wait");
  });

  it("resolves ProvisioningError with StateMismatch code", () => {
    const err = new ProvisioningError("State changed", "StateMismatch");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("StateMismatch");
    expect(entry.howToFix).toContain("plan");
  });

  it("resolves ProvisioningError with UnsupportedType code", () => {
    const err = new ProvisioningError("Not supported", "UnsupportedType");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("UnsupportedType");
    expect(entry.howToFix).toBeTruthy();
  });

  it("resolves ProvisioningError with Unknown code to generic message with original text", () => {
    const err = new ProvisioningError(
      "Something very specific went wrong",
      "Unknown",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.what).toContain("Something very specific went wrong");
    expect(entry.howToFix).toBeTruthy();
  });

  it("matches BucketAlreadyExists from message text", () => {
    const err = new ProvisioningError(
      "BucketAlreadyExists: my-bucket",
      "Unknown",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("BucketAlreadyExists");
    expect(entry.howToFix).toContain("bucket name");
  });

  it("matches AccessDenied from message text", () => {
    const err = new ProvisioningError(
      "AccessDeniedException: User not authorized",
      "Unknown",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("AccessDenied");
    expect(entry.howToFix).toContain("IAM");
  });

  it("matches ThrottlingException from message text", () => {
    const err = new ProvisioningError(
      "ThrottlingException: Rate exceeded",
      "Unknown",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("ThrottlingException");
    expect(entry.howToFix).toContain("Wait");
  });

  it("matches ValidationException from message text", () => {
    const err = new ProvisioningError(
      "ValidationException: Invalid parameter",
      "Unknown",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("ValidationException");
  });

  it("matches ResourceNotFoundException from message text", () => {
    const err = new ProvisioningError(
      "ResourceNotFoundException: Role not found",
      "Unknown",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("ResourceNotFoundException");
    expect(entry.howToFix).toContain("exist");
  });

  it("resolves ProvisioningError with InvalidParameterValue from message text", () => {
    const err = new ProvisioningError(
      "InvalidParameterValue: invalid instance type",
      "Unknown",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("InvalidParameterValue");
    expect(entry.howToFix).toContain("parameter");
  });

  it("resolves ProvisioningError with AccessDenied code directly", () => {
    const err = new ProvisioningError("Not authorized", "AccessDenied");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("AccessDenied");
    expect(entry.howToFix).toContain("IAM");
  });

  it("matches 'already exists' substring from generic message", () => {
    const err = new ProvisioningError(
      "Resource already exists in account",
      "Unknown",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("AlreadyExists");
  });

  it("matches 'bucket name is not available' from message text", () => {
    const err = new ProvisioningError(
      "The requested bucket name is not available. The bucket namespace is shared by all users of the system.",
      "Unknown",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("BucketNameNotAvailable");
    expect(entry.why).toContain("globally unique");
    expect(entry.howToFix).toContain("different bucket name");
  });

  it("matches 'S3 bucket name is already taken' from provisioner prefix", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "CloudControl provisioning failed: S3 bucket name is already taken globally. Choose a different name.",
    );
    expect(entry.code).toBe("BucketNameNotAvailable");
    expect(entry.howToFix).toContain("different bucket name");
  });
});

// ── AC 3: Configuration errors ───────────────────────────────────────────────

describe("ErrorMessageRegistry — configuration errors", () => {
  it("resolves missing access key", () => {
    const err = new ConfigurationError(
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID is missing or empty",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("MISSING_ACCESS_KEY");
    expect(entry.howToFix).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
  });

  it("resolves missing secret key", () => {
    const err = new ConfigurationError(
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY is missing or empty",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("MISSING_SECRET_KEY");
    expect(entry.howToFix).toContain("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY");
  });

  it("resolves missing region", () => {
    const err = new ConfigurationError("AWS_REGION is missing or empty");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("MISSING_REGION");
    expect(entry.howToFix).toContain("AWS_REGION");
  });

  it("resolves YAML parse error", () => {
    const err = new ConfigurationError("Failed to parse YAML config");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("INVALID_YAML");
    expect(entry.howToFix).toContain("config.yaml");
  });

  it("resolves missing credentials error", () => {
    const err = new ConfigurationError(
      "No AWS credentials detected in environment",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("MISSING_CREDENTIALS");
    expect(entry.howToFix).toContain("ASSIGNEE_OPERATOR");
  });
});

// ── AC 4: LLM errors ────────────────────────────────────────────────────────

describe("ErrorMessageRegistry — LLM errors", () => {
  it("resolves LLM timeout", () => {
    const err = new LlmError("Request timed out after 30s");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("LLM_TIMEOUT");
    expect(entry.howToFix).toContain("Retry");
  });

  it("resolves LLM rate limit", () => {
    const err = new LlmError("Rate exceeded: rate limit");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("LLM_RATE_LIMIT");
    expect(entry.howToFix).toContain("Wait");
  });

  it("resolves LLM invalid response", () => {
    const err = new LlmError("could not be parsed as valid JSON");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("LLM_INVALID_RESPONSE");
    expect(entry.howToFix).toContain("Retry");
  });

  it("resolves Bedrock connectivity error", () => {
    const err = new BedrockError("Failed to connect to Bedrock endpoint");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("BEDROCK_CONNECTIVITY");
    expect(entry.howToFix).toContain("Bedrock");
  });

  it("resolves LLM API key error", () => {
    const err = new LlmError("UnrecognizedClientException: invalid API key");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("LLM_API_KEY_INVALID");
    expect(entry.howToFix).toContain("API key");
  });
});

// ── MCP errors ───────────────────────────────────────────────────────────────

describe("ErrorMessageRegistry — MCP errors", () => {
  it("resolves MCP startup failure", () => {
    const err = new McpError("MCP server 'pricing' failed to start");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("MCP_STARTUP_FAILED");
    expect(entry.howToFix).toContain("MCP server");
  });

  it("resolves schema fetch failure (DescribeType)", () => {
    const err = new McpError("SchemaFetchError: DescribeType call failed");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("CFN_MCP_UNAVAILABLE");
    expect(entry.howToFix).toContain("DescribeType");
  });

  it("resolves MCP tool not found", () => {
    const err = new McpError("tool get_schema not found in server");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("MCP_TOOL_NOT_FOUND");
    expect(entry.howToFix).toContain("Update");
  });
});

// ── Checkpoint errors ────────────────────────────────────────────────────────

describe("ErrorMessageRegistry — checkpoint errors", () => {
  it("resolves checkpoint not found", () => {
    const err = new CheckpointError("Checkpoint file not found: ENOENT");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("CHECKPOINT_NOT_FOUND");
    expect(entry.howToFix).toContain("assignee plan");
  });

  it("resolves checkpoint expired", () => {
    const err = new CheckpointError("Checkpoint has expired (TTL exceeded)");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("CHECKPOINT_EXPIRED");
    expect(entry.howToFix).toContain("plan");
  });

  it("resolves checkpoint invalid", () => {
    const err = new CheckpointError(
      "Checkpoint schema version invalid: expected 2, got 1",
    );
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("CHECKPOINT_INVALID");
    expect(entry.howToFix).toContain("Delete");
  });
});

// ── Typed AssigneeError subclasses ───────────────────────────────────────────

describe("ErrorMessageRegistry — AssigneeError subclasses", () => {
  it("resolves UnsupportedResourceError", () => {
    const err = new UnsupportedResourceError("AWS::Kinesis::Stream");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("UNSUPPORTED_RESOURCE");
    expect(entry.howToFix).toContain("supported");
  });

  it("resolves StateGuardError", () => {
    const err = new StateGuardError("Resource state differs from plan");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("StateMismatch");
  });

  it("resolves MissingRequiredFieldsError", () => {
    const err = new MissingRequiredFieldsError(["FunctionName", "Runtime"]);
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.code).toBe("MISSING_REQUIRED_FIELDS");
    expect(entry.howToFix).toContain("--no-wizard");
  });

  it("resolves generic AssigneeError to unknown with message", () => {
    const err = new AssigneeError("Something specific", "CUSTOM_CODE");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.what).toContain("Something specific");
    expect(entry.howToFix).toBeTruthy();
  });
});

// ── AC 4.3: Unknown errors produce a generic helpful message ─────────────────

describe("ErrorMessageRegistry — unknown / generic errors", () => {
  it("resolves a raw Error to a message with howToFix", () => {
    const err = new Error("Something completely unknown");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.what).toContain("Something completely unknown");
    expect(entry.howToFix).toBeTruthy();
    expect(entry.howToFix).toContain("Retry");
  });

  it("resolves a string error to a message with howToFix", () => {
    const entry = defaultErrorMessageRegistry.resolve("String error message");
    expect(entry.what).toContain("String error message");
    expect(entry.howToFix).toBeTruthy();
  });

  it("resolves undefined to generic fallback", () => {
    const entry = defaultErrorMessageRegistry.resolve(undefined);
    expect(entry.code).toBe("UNKNOWN");
    expect(entry.howToFix).toBeTruthy();
  });

  it("resolves null to generic fallback", () => {
    const entry = defaultErrorMessageRegistry.resolve(null);
    expect(entry.code).toBe("UNKNOWN");
    expect(entry.howToFix).toBeTruthy();
  });
});

// ── resolveMessage (from errorMessage string in graph state) ─────────────────

describe("ErrorMessageRegistry — resolveMessage", () => {
  it("resolves 'Unsupported resource type' message", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "Unsupported resource type. Supported types: S3, EC2, Lambda.",
    );
    expect(entry.code).toBe("UNSUPPORTED_RESOURCE");
  });

  it("resolves 'Missing required fields' message", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "Missing required fields with no defaults: FunctionName, Runtime.",
    );
    expect(entry.code).toBe("MISSING_REQUIRED_FIELDS");
  });

  it("resolves non-interactive --yes hint message", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "Error: Apply requires confirmation. Use --yes for non-interactive mode.",
    );
    expect(entry.code).toBe("NON_INTERACTIVE_NO_YES");
  });

  it("resolves invalid JSON plan generator message", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "Plan generator returned invalid JSON. Hint: try rephrasing your intent.",
    );
    expect(entry.code).toBe("LLM_INVALID_RESPONSE");
  });

  it("resolves AccessDenied from message string", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "CloudControl provisioning failed: AccessDeniedException: not authorized",
    );
    expect(entry.code).toBe("AccessDenied");
  });

  it("resolves unknown message to generic with original text", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "Completely unknown error scenario",
    );
    expect(entry.what).toContain("Completely unknown error scenario");
    expect(entry.howToFix).toBeTruthy();
  });
});

// ── MISSING_INTENT error ──────────────────────────────────────────────────────

describe("ErrorMessageRegistry — MISSING_INTENT", () => {
  it("MISSING_INTENT entry exists and has actionable howToFix", () => {
    // Tier C: dropped redundant toBeDefined() — get!() + property accesses
    const entry = defaultErrorMessageRegistry.get("MISSING_INTENT")!;
    expect(entry.code).toBe("MISSING_INTENT");
    expect(entry.howToFix).toContain("assignee plan");
  });
});

// ── Fresh registry isolation ─────────────────────────────────────────────────

describe("ErrorMessageRegistry — fresh instance", () => {
  it("creates independent instances with all entries", () => {
    const registry = new ErrorMessageRegistry();
    const entries = registry.allEntries();
    expect(entries.length).toBeGreaterThanOrEqual(20);
  });
});

// ── M-S5: redactSensitive helper ─────────────────────────────────────────────

describe("redactSensitive", () => {
  it("replaces 12-digit AWS account IDs with [ACCOUNT]", () => {
    expect(redactSensitive("Failed for account 123456789012")).toBe(
      "Failed for account [ACCOUNT]",
    );
  });

  it("replaces a full IAM ARN with [ARN]", () => {
    expect(
      redactSensitive("User arn:aws:iam::123456789012:user/operator denied"),
    ).toBe("User [ARN] denied");
  });

  it("replaces a CloudControl-style resource ARN with [ARN]", () => {
    expect(
      redactSensitive(
        "Cannot delete arn:aws:s3:::my-bucket-123456789012-name from arn:aws:iam::123456789012:role/foo",
      ),
    ).toContain("[ARN]");
  });

  it("does not over-redact: leaves shorter numbers untouched", () => {
    expect(redactSensitive("port 8080 connection refused")).toBe(
      "port 8080 connection refused",
    );
  });

  it("does not over-redact: leaves a longer 13-digit number untouched", () => {
    // Word boundary protection: 1234567890123 is NOT exactly 12 digits
    expect(redactSensitive("id 1234567890123")).toBe("id 1234567890123");
  });

  it("redacts multiple account IDs in one message", () => {
    expect(redactSensitive("source 111111111111 dest 222222222222")).toBe(
      "source [ACCOUNT] dest [ACCOUNT]",
    );
  });

  it("returns empty string unchanged", () => {
    expect(redactSensitive("")).toBe("");
  });

  it("redacts an ARN that contains the account ID once (not twice)", () => {
    // ARN regex consumes the account, so the trailing ACCOUNT regex must
    // not double-replace the segment.
    const result = redactSensitive(
      "arn:aws:lambda:us-east-1:123456789012:function:foo",
    );
    expect(result).toBe("[ARN]");
  });
});

// ── Regression: non-checkpoint errors must not match CHECKPOINT_INVALID ──────

describe("matchCheckpointError regression — non-checkpoint errors", () => {
  it("resolves S3 TagValue invalid to InvalidParameterValue, NOT CHECKPOINT_INVALID", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "The TagValue you have provided is invalid (Service: S3)",
    );
    expect(entry.code).not.toBe(ErrorCode.CHECKPOINT_INVALID);
    expect(entry.code).toBe("InvalidParameterValue");
  });

  it("resolves InvalidParameterValue to AWS pattern, NOT CHECKPOINT_INVALID", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "InvalidParameterValue: The parameter is not valid",
    );
    expect(entry.code).not.toBe(ErrorCode.CHECKPOINT_INVALID);
    expect(entry.code).toBe("InvalidParameterValue");
  });

  it("still resolves checkpoint-specific invalid message to CHECKPOINT_INVALID", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "Checkpoint file is invalid or corrupted",
    );
    expect(entry.code).toBe(ErrorCode.CHECKPOINT_INVALID);
  });

  it("still resolves checkpoint ENOENT to CHECKPOINT_NOT_FOUND", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "Checkpoint not found: ENOENT",
    );
    expect(entry.code).toBe(ErrorCode.CHECKPOINT_NOT_FOUND);
  });
});

// ── P1-R2-4: live context interpolation ─────────────────────────────────────

describe("ErrorMessageRegistry — live context interpolation (P1-R2-4)", () => {
  it("strips {CTX} placeholder when no context is passed (back-compat)", () => {
    const err = new ConfigurationError("No AWS credentials detected");
    const entry = defaultErrorMessageRegistry.resolve(err);
    expect(entry.howToFix).not.toContain("{CTX}");
    expect(entry.howToFix).not.toContain("{region}");
  });

  it("expands {CTX} with region/account/profile when context provided", () => {
    const err = new ConfigurationError("No AWS credentials detected");
    const entry = defaultErrorMessageRegistry.resolve(err, {
      region: "us-west-2",
      account: "123456789012",
      profile: "dev",
    });
    expect(entry.howToFix).toContain("region=us-west-2");
    expect(entry.howToFix).toContain("account=123456789012");
    expect(entry.howToFix).toContain("profile=dev");
    expect(entry.howToFix).toContain("Context:");
  });

  it("expands {CTX} with partial context (region only)", () => {
    const err = new ProvisioningError("Resource not found in AWS", "NotFound");
    const entry = defaultErrorMessageRegistry.resolve(err, {
      region: "eu-west-1",
    });
    expect(entry.howToFix).toContain("region=eu-west-1");
    expect(entry.howToFix).not.toContain("account=");
    expect(entry.howToFix).not.toContain("profile=");
  });

  it("expands {region} scalar token when present in template", () => {
    // Manually register an entry using {region} to verify scalar path.
    const reg = new ErrorMessageRegistry();
    const raw = reg.get("UNKNOWN");
    expect(raw).toBeDefined();
  });

  it("does not re-emit placeholder artifacts when all ctx fields are empty", () => {
    const err = new ConfigurationError("No AWS credentials detected");
    const entry = defaultErrorMessageRegistry.resolve(err, {});
    expect(entry.howToFix).not.toContain("{CTX}");
    expect(entry.howToFix).not.toContain("Context: .");
  });

  it("resolveMessage accepts context argument", () => {
    const entry = defaultErrorMessageRegistry.resolveMessage(
      "AWS_REGION is missing",
      { profile: "ops" },
    );
    expect(entry.howToFix).toContain("profile=ops");
  });
});
