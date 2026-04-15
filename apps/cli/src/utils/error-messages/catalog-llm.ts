/** LLM / Bedrock error message catalog. */

import { ErrorCode } from "../../constants/errors.js";
import type { ErrorMessageEntry } from "./types.js";

export const LLM_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
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
      "Verify that:\n  1) Your AWS_REGION{?region: ({region})} supports Bedrock (e.g., us-east-1, us-west-2)\n  2) The Bedrock model is enabled in your account{?account: ({account})} (check AWS Console > Bedrock > Model access)\n  3) Your IAM credentials{?profile: for profile {profile}} have bedrock:InvokeModel permission.",
  },
  [ErrorCode.LLM_API_KEY_INVALID]: {
    code: ErrorCode.LLM_API_KEY_INVALID,
    what: "LLM API key is invalid or expired.",
    why: "The AI model provider rejected the API credentials.",
    howToFix:
      "Check and update your LLM API key. For Bedrock, verify your AWS credentials are current and have Bedrock permissions.",
  },
};
