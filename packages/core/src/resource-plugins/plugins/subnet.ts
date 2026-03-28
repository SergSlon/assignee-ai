import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE } from "../shared-fields.js";

/** Validates IPv4 CIDR notation for subnets (e.g. "10.0.1.0/24"). */
function validateSubnetCidr(value: unknown): string | undefined {
  if (!value) return "Subnet CIDR block is required";
  const s = String(value);
  const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
  if (!cidrRegex.test(s))
    return "Must be valid CIDR notation (e.g. 10.0.1.0/24)";
  const [ip, prefix] = s.split("/");
  const octets = ip!.split(".").map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return "Invalid IP address in CIDR";
  const prefixLen = Number(prefix);
  if (prefixLen < 16 || prefixLen > 28)
    return "Subnet CIDR prefix must be between /16 and /28";
  return undefined;
}

/**
 * ResourcePlugin for AWS::EC2::Subnet.
 * Subnets are free — pricing is on the resources placed within them.
 */
export const subnetPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_SUBNET,
  commonFields: [
    {
      name: "VpcId",
      required: true,
      question: {
        type: "enum",
        label: "VPC",
        hint: "The VPC this subnet belongs to. Each subnet lives in exactly one VPC and one Availability Zone.",
        fetcher: "discover-vpcs",
        options: [], // populated at runtime by fetcher
      },
    },
    {
      name: "CidrBlock",
      required: true,
      question: {
        type: "string",
        label: "Subnet CIDR block",
        placeholder: "10.0.1.0/24",
        hint: "Must be a subset of the VPC CIDR. /24 gives 251 usable IPs (AWS reserves 5). Use smaller prefixes for tighter control.",
        validate: validateSubnetCidr,
      },
    },
    {
      name: "AvailabilityZone",
      required: true,
      question: {
        type: "enum",
        label: "Availability Zone",
        hint: "The AZ where this subnet will be created. Spread subnets across AZs for high availability.",
        fetcher: "discover-availability-zones",
        options: [], // populated at runtime by fetcher
      },
    },
    {
      name: "MapPublicIpOnLaunch",
      question: {
        type: "boolean",
        label: "Auto-assign public IP on launch?",
        initialValue: false,
        hint: "Automatically assigns a public IPv4 address to instances launched in this subnet. Keep false for private subnets (recommended). Enable only for public-facing subnets behind a load balancer or NAT.",
      },
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, tier:public",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization.",
        validate: TAGS_VALIDATE,
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
  defaults: {
    MapPublicIpOnLaunch: false,
  },
  configHints: [
    "VpcId MUST reference an existing VPC — use discover-vpcs fetcher",
    "CidrBlock MUST be a valid subset of the parent VPC CIDR range",
    "AvailabilityZone MUST be a valid AZ in the target region — use discover-availability-zones fetcher",
    "MapPublicIpOnLaunch should default to false for security; only enable for explicitly public subnets",
  ],
};
