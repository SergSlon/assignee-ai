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
        validate: (value: unknown) => {
          if (!value) return undefined; // Optional
          const s = String(value).trim();
          if (!s) return undefined;
          const pairs = s.split(",").map((p) => p.trim()).filter(Boolean);
          const validPairs = pairs.filter((p) => p.includes(":"));
          if (validPairs.length === 0) {
            return "Invalid tag format. Use Key:Value pairs separated by commas (e.g. env:production, team:backend)";
          }
          if (validPairs.length < pairs.length) {
            const invalid = pairs.filter((p) => !p.includes(":"));
            return `Some tags are missing a colon separator and will be ignored: ${invalid.join(", ")}. Use Key:Value format.`;
          }
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const tags = answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
        return tags.length > 0 ? tags : undefined;
      },
    },
  ],
  advancedFields: [],
  defaults: {},
};
