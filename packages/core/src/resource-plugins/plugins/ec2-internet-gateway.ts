import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::EC2::InternetGateway.
 * InternetGateways are free — data transfer charges apply to traffic but are not IGW-specific.
 */
export const internetGatewayPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
  commonFields: [
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:platform",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization.",
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
  configHints: [
    "An InternetGateway MUST be attached to a VPC via a VPCGatewayAttachment resource to function",
    "A route table entry with destination 0.0.0.0/0 targeting the IGW is required for public subnet internet access",
    "Each VPC can have at most one InternetGateway attached",
  ],
};
