/**
 * Barrel for error-messages. Re-exports the full public surface of the
 * pre-decomposition monolith at apps/cli/src/utils/error-messages.ts.
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
export { redactSensitive } from "./redaction.js";
export { formatErrorParts } from "./formatting.js";
