/**
 * Pattern matchers for resolving error messages.
 *
 * Each matcher maps substring/regex patterns in an error message to
 * the catalog code that should be used. Returns the ErrorMessageEntry
 * from the supplied lookup, or undefined when no match.
 */

import { AwsErrorName } from "../../constants/aws-error-names.js";
import { ErrorCode } from "../../constants/errors.js";
import { PROVISIONING_ERROR_CODES } from "../../errors.js";
import type { ErrorMessageEntry } from "./types.js";

export type EntryLookup = (code: string) => ErrorMessageEntry | undefined;

export function matchAwsErrorName(
  message: string,
  lookup: EntryLookup,
): ErrorMessageEntry | undefined {
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
      return lookup(code);
    }
  }
  return undefined;
}

export function matchConfigError(
  message: string,
  lookup: EntryLookup,
): ErrorMessageEntry | undefined {
  if (
    message.includes("ASSIGNEE_OPERATOR_ACCESS_KEY_ID") ||
    message.includes("access key")
  ) {
    return lookup(ErrorCode.MISSING_ACCESS_KEY);
  }
  if (
    message.includes("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY") ||
    message.includes("secret key")
  ) {
    return lookup(ErrorCode.MISSING_SECRET_KEY);
  }
  if (message.includes("AWS_REGION") || message.includes("region is missing")) {
    return lookup(ErrorCode.MISSING_REGION);
  }
  if (
    message.includes("YAML") ||
    message.includes("yaml") ||
    message.includes("parse")
  ) {
    return lookup(ErrorCode.INVALID_YAML);
  }
  if (
    message.includes("No AWS credentials") ||
    message.includes("credentials")
  ) {
    return lookup(ErrorCode.MISSING_CREDENTIALS);
  }
  return undefined;
}

export function matchLlmError(
  message: string,
  lookup: EntryLookup,
): ErrorMessageEntry | undefined {
  if (message.includes("timeout") || message.includes("timed out")) {
    return lookup(ErrorCode.LLM_TIMEOUT);
  }
  if (
    message.includes("rate limit") ||
    message.includes(AwsErrorName.RATE_EXCEEDED) ||
    message.includes(AwsErrorName.THROTTLING)
  ) {
    return lookup(ErrorCode.LLM_RATE_LIMIT);
  }
  if (
    message.includes("invalid JSON") ||
    message.includes("Invalid response") ||
    message.includes("could not be parsed")
  ) {
    return lookup(ErrorCode.LLM_INVALID_RESPONSE);
  }
  if (
    message.includes("Bedrock") ||
    message.includes("bedrock") ||
    message.includes("connectivity")
  ) {
    return lookup(ErrorCode.BEDROCK_CONNECTIVITY);
  }
  if (
    message.includes("API key") ||
    message.includes("api key") ||
    message.includes("UnrecognizedClientException")
  ) {
    return lookup(ErrorCode.LLM_API_KEY_INVALID);
  }
  return undefined;
}

export function matchMcpError(
  message: string,
  lookup: EntryLookup,
): ErrorMessageEntry | undefined {
  if (message.includes("failed to start") || message.includes("MCP_STARTUP")) {
    return lookup(ErrorCode.MCP_STARTUP_FAILED);
  }
  if (
    message.includes(AwsErrorName.SCHEMA_FETCH_ERROR) ||
    message.includes("DescribeType") ||
    message.includes("Schema fetch failed")
  ) {
    return lookup(ErrorCode.CFN_MCP_UNAVAILABLE);
  }
  if (
    message.includes("tool") &&
    (message.includes("not found") || message.includes("not available"))
  ) {
    return lookup(ErrorCode.MCP_TOOL_NOT_FOUND);
  }
  return undefined;
}

export function matchCheckpointError(
  message: string,
  lookup: EntryLookup,
): ErrorMessageEntry | undefined {
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
    return lookup(ErrorCode.CHECKPOINT_NOT_FOUND);
  }
  if (isCheckpointContext && (lc.includes("expired") || lc.includes("ttl"))) {
    return lookup(ErrorCode.CHECKPOINT_EXPIRED);
  }
  if (
    isCheckpointContext &&
    (lc.includes("invalid") || lc.includes("corrupt") || lc.includes("schema"))
  ) {
    return lookup(ErrorCode.CHECKPOINT_INVALID);
  }
  return undefined;
}
