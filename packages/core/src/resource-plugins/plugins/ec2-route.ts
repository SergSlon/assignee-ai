import { RESOURCE_TYPES } from "../../config/resource-types.js";
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
      name: "RouteTableId",
      required: true,
      question: {
        type: "string",
        label: "Route Table ID",
        hint: "The ID of the route table this route belongs to. Use a Ref to the route table logical ID.",
        placeholder: "rtb-0123456789abcdef0",
      },
    },
    {
      name: "DestinationCidrBlock",
      required: true,
      question: {
        type: "string",
        label: "Destination CIDR block",
        initialValue: "0.0.0.0/0",
        placeholder: "0.0.0.0/0",
        hint: "The IPv4 CIDR address block for the route destination. 0.0.0.0/0 matches all traffic (default route).",
      },
    },
    {
      name: "RouteType",
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
    },
    {
      name: "GatewayId",
      question: {
        type: "string",
        label: "Internet Gateway ID",
        hint: "The ID of the InternetGateway target. Use a Ref to the IGW logical ID in the plan.",
        placeholder: "igw-0123456789abcdef0",
        showIf: { field: "RouteType", value: "public" },
      },
    },
    {
      name: "NatGatewayId",
      question: {
        type: "string",
        label: "NAT Gateway ID",
        hint: "The ID of the NatGateway target. Use a Ref to the NatGateway logical ID in the plan.",
        placeholder: "nat-0123456789abcdef0",
        showIf: { field: "RouteType", value: "private" },
      },
    },
  ],
  advancedFields: [],
  defaults: {
    DestinationCidrBlock: "0.0.0.0/0",
    RouteType: "public",
  },
  configHints: [
    "A Route MUST have exactly one target — either GatewayId (InternetGateway) or NatGatewayId (NatGateway), never both",
    "Public route tables use GatewayId referencing an InternetGateway for 0.0.0.0/0 traffic",
    "Private route tables use NatGatewayId referencing a NatGateway for 0.0.0.0/0 traffic",
    "RouteTableId MUST reference a valid route table in the plan",
    "Routes are replacement-only — changing the destination CIDR triggers resource replacement",
  ],
};
