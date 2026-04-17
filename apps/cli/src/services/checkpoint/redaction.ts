/**
 * @deprecated Import from `@assignee/core/checkpoint`. Thin re-export
 * preserved during Story 50-4 so tests that import
 * `../checkpoint/redaction.js` continue to resolve.
 */
export {
  redactSensitiveFields,
  stripRedactedFields,
  REDACTED_VALUE,
} from "@assignee/core/checkpoint";
