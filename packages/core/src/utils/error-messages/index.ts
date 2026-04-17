/**
 * Barrel for error-messages. Re-exports the full public surface of the
 * pre-decomposition monolith at apps/cli/src/utils/error-messages.ts.
 *
 * Lifted into @assignee/core in Story 50-4 Wave 5 Pass C-2.
 */

export type {
  ErrorMessageEntry,
  ErrorResolveContext,
  FormattedError,
} from "./types.js";
export {
  ErrorMessageRegistry,
  defaultErrorMessageRegistry,
} from "./registry.js";
export { redactSensitive } from "../redact.js";
export { formatErrorParts } from "./formatting.js";
