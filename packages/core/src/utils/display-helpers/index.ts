/**
 * Barrel for display-helpers/ — formatting helpers + type definitions
 * for the display layer (state shape, friendly labels, sensitive-field
 * masking, value formatters, desiredState table builder).
 */
export type {
  RenderableState,
  RenderableCompoundQueue,
} from "./renderable-state.js";
export { FRIENDLY_NAMES } from "./friendly-names.js";
export {
  FRIENDLY_NAMES_BY_TYPE,
  resolveFieldLabel,
  spacePascalCase,
} from "./friendly-names-by-type.js";
export { SENSITIVE_FIELDS } from "./sensitive-fields.js";
export { resolveSetKey } from "./resolve-set-key.js";
export { formatValue } from "./format-value.js";
export { formatSpecialValue } from "./format-special-value.js";
export { formatDesiredState } from "./format-desired-state.js";
