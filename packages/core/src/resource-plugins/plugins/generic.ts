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
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization. Example: Environment:production, Team:backend, Project:api. Tags are free and highly recommended.",
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
      },
    },
  ],
  advancedFields: [],
  defaults: {},
};
