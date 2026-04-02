import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::EC2::Route.
 * Routes are free — no AWS charges apply.
 *
 * Uses showIf conditions to present the correct target field:
 * - Public routes: GatewayId (references InternetGateway)
 * - Private routes: NatGatewayId (references NatGateway)
 * Only one target can be set per route (AWS API constraint).
 */
export const routePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_ROUTE,
  commonFields: [
    {
      name: CfnKey.ROUTE_TABLE_ID,
      required: true,
      question: {
        type: "string",
        label: "Route Table ID",
        hint: "The ID of the route table this route belongs to. Use a Ref to the route table logical ID.",
        placeholder: "rtb-0123456789abcdef0",
      },
    },
    {
      name: CfnKey.DESTINATION_CIDR_BLOCK,
      required: true,
      question: {
        type: "string",
        label: "Destination CIDR block",
        initialValue: "0.0.0.0/0",
        placeholder: "0.0.0.0/0",
        hint: "The IPv4 CIDR address block for the route destination. 0.0.0.0/0 matches all traffic (default route).",
        validate: (value: unknown) => {
          if (!value) return "Destination CIDR block is required";
          const s = String(value);
          const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
          if (!cidrRegex.test(s))
            return "Must be valid CIDR notation (e.g. 0.0.0.0/0 or 10.0.0.0/16)";
          const [ip, prefix] = s.split("/");
          const octets = ip!.split(".").map(Number);
          if (octets.some((o) => o < 0 || o > 255))
            return "Invalid IP address in CIDR";
          const prefixLen = Number(prefix);
          if (prefixLen < 0 || prefixLen > 32)
            return "CIDR prefix must be between /0 and /32";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.ROUTE_TYPE,
      required: true,
      question: {
        type: "enum",
        label: "Route target type",
        options: [
          { value: "public", label: "Public (Internet Gateway)" },
          { value: "private", label: "Private (NAT Gateway)" },
        ],
        initialValue: "public",
        hint: "Public routes target an InternetGateway for direct internet access. Private routes target a NatGateway for outbound-only internet access.",
      },
      toCfn: () => undefined,
    },
    {
      name: CfnKey.GATEWAY_ID,
      question: {
        type: "string",
        label: "Internet Gateway ID",
        hint: "The ID of the InternetGateway target. Use a Ref to the IGW logical ID in the plan.",
        placeholder: "igw-0123456789abcdef0",
        showIf: { field: CfnKey.ROUTE_TYPE, value: "public" },
      },
    },
    {
      name: CfnKey.NAT_GATEWAY_ID,
      question: {
        type: "string",
        label: "NAT Gateway ID",
        hint: "The ID of the NatGateway target. Use a Ref to the NatGateway logical ID in the plan.",
        placeholder: "nat-0123456789abcdef0",
        showIf: { field: CfnKey.ROUTE_TYPE, value: "private" },
      },
    },
  ],
  advancedFields: [],
  defaults: {
    [CfnKey.DESTINATION_CIDR_BLOCK]: "0.0.0.0/0",
    [CfnKey.ROUTE_TYPE]: "public",
  },
  configHints: [
    "NEVER include Tags — AWS::EC2::Route does not support tagging. Omit Tags entirely.",
    "A Route MUST have exactly one target — either GatewayId (InternetGateway) or NatGatewayId (NatGateway), never both",
    "Public route tables use GatewayId referencing an InternetGateway for 0.0.0.0/0 traffic",
    "Private route tables use NatGatewayId referencing a NatGateway for 0.0.0.0/0 traffic",
    "RouteTableId MUST reference a valid route table in the plan",
    "Routes are replacement-only — changing the destination CIDR triggers resource replacement",
  ],
};
