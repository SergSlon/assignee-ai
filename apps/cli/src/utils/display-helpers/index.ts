/**
 * Thin re-export shim — canonical implementations live in
 * `@assignee/core/utils/display-helpers` (Story 50-4 Wave 5 Pass C-2).
 */
export type { RenderableState, RenderableCompoundQueue } from "@assignee/core";
export {
  FRIENDLY_NAMES,
  FRIENDLY_NAMES_BY_TYPE,
  SENSITIVE_FIELDS,
  resolveFieldLabel,
  resolveSetKey,
  spacePascalCase,
  formatValue,
  formatSpecialValue,
  formatDesiredState,
} from "@assignee/core";
