/**
 * Formatting helpers for ErrorMessageEntry → FormattedError.
 *
 * Converts a structured ErrorMessageEntry into a FormattedError for the
 * display layer, which renders each part with its own ANSI color.
 */

import type { ErrorMessageEntry, FormattedError } from "./types.js";

export function formatErrorParts(entry: ErrorMessageEntry): FormattedError {
  return {
    what: entry.what,
    why: entry.why,
    howToFix: entry.howToFix,
  };
}
