/** Generic/fallback error message catalog. */

import { ErrorCode } from "../../constants/errors.js";
import { EXAMPLE_S3_INTENT } from "../../config/constants/ui.js";
import type { ErrorMessageEntry } from "./types.js";

export const GENERIC_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [ErrorCode.UNKNOWN]: {
    code: ErrorCode.UNKNOWN,
    what: "An unexpected error occurred.",
    why: "An unclassified error was encountered. This may be a bug or an unusual edge case.",
    howToFix:
      "Retry the command. If it persists, run with ASSIGNEE_LOG_LEVEL=debug for more details and report the issue at https://github.com/SergSlon/assignee-ai/issues.",
  },
  [ErrorCode.MISSING_INTENT]: {
    code: ErrorCode.MISSING_INTENT,
    what: "No intent was provided.",
    why: "The command requires a natural language description of what you want to create.",
    howToFix: `Provide an intent in quotes: \`assignee infra plan "${EXAMPLE_S3_INTENT}"\``,
  },
  [ErrorCode.UNSUPPORTED_RESOURCE]: {
    code: ErrorCode.UNSUPPORTED_RESOURCE,
    what: "The requested resource type is not supported.",
    why: "Assignee.ai currently supports a subset of AWS resource types. The resource you requested is not in the supported set.",
    howToFix:
      "Run `assignee infra plan --help` to see the list of supported resource types. Try rephrasing your intent to use a supported type.",
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
