/** Field elicitation policy constants (Story 7.2 / 7.3). */

export const FieldPolicy = {
  NEVER_ASK: "never_ask",
  ASK_IF_NOT_SET: "ask_if_not_set",
  ALWAYS_ASK: "always_ask",
} as const;

export type FieldPolicyType = (typeof FieldPolicy)[keyof typeof FieldPolicy];

export const FieldSource = {
  PLUGIN_DEFAULT: "plugin_default",
} as const;

export type FieldSourceType = (typeof FieldSource)[keyof typeof FieldSource];
