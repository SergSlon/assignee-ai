import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/** Validates IPv4 CIDR notation (e.g. "10.0.0.0/16"). */
function validateCidr(value: unknown): string | undefined {
  if (!value) return undefined;
  const s = String(value);
  const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
  if (!cidrRegex.test(s))
    return "Must be valid CIDR notation (e.g. 10.0.0.0/16)";
  const [ip, prefix] = s.split("/");
  const octets = ip!.split(".").map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return "Invalid IP address in CIDR";
  const prefixLen = Number(prefix);
  if (prefixLen < 16 || prefixLen > 28)
    return "VPC CIDR prefix must be between /16 and /28";
  return undefined;
}

/**
 * ResourcePlugin for AWS::EC2::VPC.
 * VPCs are free — pricing is on the resources inside them.
 */
export const vpcPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_VPC,
  commonFields: [
    {
      name: "CidrBlock",
      required: true,
      question: {
        type: "string",
        label: "VPC CIDR block",
        placeholder: "10.0.0.0/16",
        initialValue: "10.0.0.0/16",
        hint: "The IPv4 address range for the VPC. /16 gives 65,536 IPs (recommended). /24 gives 256 IPs. Cannot be changed after creation.",
        validate: validateCidr,
      },
    },
    {
      name: "EnableDnsHostnames",
      question: {
        type: "boolean",
        label: "Enable DNS hostnames?",
        initialValue: true,
        hint: "Assigns public DNS hostnames to instances with public IPs. Required for many AWS services (ELB, RDS, etc.). Recommended to keep enabled.",
      },
    },
    {
      name: "EnableDnsSupport",
      question: {
        type: "boolean",
        label: "Enable DNS support?",
        initialValue: true,
        hint: "Enables the Amazon-provided DNS server for the VPC. Required for DNS resolution within the VPC. Almost always should be true.",
      },
    },
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
  advancedFields: [
    {
      name: "InstanceTenancy",
      question: {
        type: "enum",
        label: "Instance tenancy",
        options: [
          { value: "default", label: "Default (shared hardware)" },
          { value: "dedicated", label: "Dedicated (single-tenant hardware)" },
        ],
        initialValue: "default",
        hint: "Dedicated tenancy runs instances on single-tenant hardware at ~2x cost. Use only for strict compliance requirements.",
      },
    },
  ],
  defaults: {
    CidrBlock: "10.0.0.0/16",
    EnableDnsHostnames: true,
    EnableDnsSupport: true,
    InstanceTenancy: "default",
  },
  configHints: [
    "CidrBlock MUST be valid IPv4 CIDR between /16 and /28",
    "EnableDnsHostnames and EnableDnsSupport should both be true unless user explicitly disables",
    "InstanceTenancy defaults to 'default'; only use 'dedicated' if user requires compliance isolation",
  ],
};
