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
        hint: "A descriptive name for this resource. Used for identification in the generated CloudFormation template. Use lowercase with hyphens.",
      },
    },
    {
      name: "Tags",
      question: {
        type: "multi",
        label: "Tags",
        hint: "Key-value pairs for cost tracking and organization. Common tags: Environment (dev/staging/prod), Team, Project. Tags are free and highly recommended.",
        options: [],
      },
    },
  ],
  advancedFields: [],
  defaults: {},
};
