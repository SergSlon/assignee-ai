import type { ResourcePlugin } from "../types.js";

/**
 * Fallback plugin for any CloudFormation resource type not covered by a dedicated plugin.
 * Uses `'generic'` as the resourceType — never matches a real CloudFormation type.
 * The option-elicitor node (Story 7.3) will surface `required[]` schema props dynamically
 * in addition to these two common fields.
 */
export const genericPlugin: ResourcePlugin = {
  resourceType: "generic",
  commonFields: [
    {
      name: "ResourceName",
      question: {
        type: "string",
        label: "Resource name",
        placeholder: "my-resource",
      },
    },
    {
      name: "Tags",
      question: {
        type: "multi",
        label: "Tags",
        options: [],
      },
    },
  ],
  advancedFields: [],
  defaults: {},
};
