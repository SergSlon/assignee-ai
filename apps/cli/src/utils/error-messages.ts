/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/utils/error-messages` (Story 50-4 Wave 5 Pass C-2).
 *
 * The ErrorMessageRegistry + catalogs + matchers + interpolation + redaction
 * tree moved into @assignee/core so the node/graph tree can consume them
 * without reaching back into the CLI app.
 */
export type {
  ErrorMessageEntry,
  ErrorResolveContext,
  FormattedError,
} from "@assignee/core";
export {
  ErrorMessageRegistry,
  defaultErrorMessageRegistry,
  redactSensitive,
  formatErrorParts,
} from "@assignee/core";
