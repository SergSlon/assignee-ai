/**
 * Error Message Registry — maps error codes and categories to structured,
 * human-friendly messages with WHAT / WHY / HOW-TO-FIX.
 *
 * Extends the existing ErrorHintRegistry (Story 9.6) with richer context.
 * Every user-facing error should flow through this registry to ensure
 * consistent quality and actionable fix suggestions.
 *
 * @see Story 18.3 — Error Message Quality Audit
 *
 * This file is a thin facade over the decomposed module at
 * ./error-messages/. Catalogs, matchers, the ErrorMessageRegistry class,
 * live-context interpolation, sensitive-data redaction and formatting
 * helpers each live in their own SRP-focused module.
 */

export type {
  ErrorMessageEntry,
  ErrorResolveContext,
  FormattedError,
} from "./error-messages/index.js";
export {
  ErrorMessageRegistry,
  defaultErrorMessageRegistry,
  redactSensitive,
  formatErrorParts,
} from "./error-messages/index.js";
