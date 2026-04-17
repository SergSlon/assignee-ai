/** Configuration error message catalog. */

import { ErrorCode } from "../../constants/errors.js";
import type { ErrorMessageEntry } from "./types.js";

export const CONFIG_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
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
      "Set the AWS_REGION environment variable:\n  export AWS_REGION=us-east-1\nOr run `assignee init` to configure your region{?profile: for profile {profile}}.",
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
      "Configure credentials via one of:\n  1) ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables\n  2) Run `assignee setup` to create IAM users and credentials\nThen run `assignee init` to verify{?profile: profile {profile}}.",
  },
};
