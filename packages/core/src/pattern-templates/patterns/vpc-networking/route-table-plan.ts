/**
 * Route-table layer for the vpc-networking pattern family.
 *
 * Split from vpc-networking.ts (W6d F3). Owns IGW, the VPC gateway
 * attachment, route tables, routes, and subnet↔RT associations.
 */

import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "@/config/resource-types.js";
import { markerRef } from "@/config/marker-tokens.js";
import type { ResourceSpec } from "../../types.js";
import { VpcResourceId } from "./subnet-plan.js";

const EC2_VPC_GATEWAY_ATTACHMENT = RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT;
const EC2_SUBNET_ROUTE_TABLE_ASSOCIATION =
  RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION;
// Companion reference kept for explicit type readability where route
// tables expose external companion resources (EIP is handled in
// nat-gateway-plan; route-table layer does not consume it directly).
void COMPANION_RESOURCE_TYPES;

/**
 * IGW + VPCGatewayAttachment.
 * CloudControl DOES support AWS::EC2::VPCGatewayAttachment — it must
 * be provisioned for public subnets to have internet access. Without
 * this attachment, the downstream public Route creation fails with
 * "route table and internet gateway belong to different networks".
 */
export const igwResources: ResourceSpec[] = [
  {
    resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
    resourceId: VpcResourceId.IGW,
    displayName: "Internet Gateway",
  },
  {
    resourceType: EC2_VPC_GATEWAY_ATTACHMENT,
    resourceId: VpcResourceId.IGW_ATTACHMENT,
    displayName: "VPC Gateway Attachment (IGW)",
  },
];

export const publicRouteResources: ResourceSpec[] = [
  {
    resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
    resourceId: VpcResourceId.PUBLIC_ROUTE_TABLE,
    displayName: "Public Route Table",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_ROUTE,
    resourceId: VpcResourceId.PUBLIC_ROUTE,
    displayName: "Public Route (0.0.0.0/0 → IGW)",
  },
];

export const privateRouteResources: ResourceSpec[] = [
  {
    resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
    resourceId: VpcResourceId.PRIVATE_ROUTE_TABLE,
    displayName: "Private Route Table",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_ROUTE,
    resourceId: VpcResourceId.PRIVATE_ROUTE,
    displayName: "Private Route (0.0.0.0/0 → NAT)",
  },
];

export const publicSubnetRtAssocResources: ResourceSpec[] = [
  {
    resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    resourceId: VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC,
    displayName: "Public Subnet 1 ↔ Public RT",
  },
  {
    resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    resourceId: VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC,
    displayName: "Public Subnet 2 ↔ Public RT",
  },
];

export const privateSubnetRtAssocResources: ResourceSpec[] = [
  {
    resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    resourceId: VpcResourceId.PRIVATE_SUBNET_1_RT_ASSOC,
    displayName: "Private Subnet 1 ↔ Private RT",
  },
  {
    resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    resourceId: VpcResourceId.PRIVATE_SUBNET_2_RT_ASSOC,
    displayName: "Private Subnet 2 ↔ Private RT",
  },
];

export const routeTableDefaults = {
  [VpcResourceId.IGW]: {},
  [VpcResourceId.IGW_ATTACHMENT]: {
    VpcId: markerRef(VpcResourceId.VPC),
    InternetGatewayId: markerRef(VpcResourceId.IGW),
  },
  [VpcResourceId.PUBLIC_ROUTE_TABLE]: {
    VpcId: markerRef(VpcResourceId.VPC),
  },
  [VpcResourceId.PRIVATE_ROUTE_TABLE]: {
    VpcId: markerRef(VpcResourceId.VPC),
  },
  [VpcResourceId.PUBLIC_ROUTE]: {
    RouteTableId: markerRef(VpcResourceId.PUBLIC_ROUTE_TABLE),
    DestinationCidrBlock: "0.0.0.0/0",
    GatewayId: markerRef(VpcResourceId.IGW),
  },
  [VpcResourceId.PRIVATE_ROUTE]: {
    RouteTableId: markerRef(VpcResourceId.PRIVATE_ROUTE_TABLE),
    DestinationCidrBlock: "0.0.0.0/0",
    NatGatewayId: markerRef(VpcResourceId.NAT_GATEWAY),
  },
  [VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC]: {
    SubnetId: markerRef(VpcResourceId.PUBLIC_SUBNET_1),
    RouteTableId: markerRef(VpcResourceId.PUBLIC_ROUTE_TABLE),
  },
  [VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC]: {
    SubnetId: markerRef(VpcResourceId.PUBLIC_SUBNET_2),
    RouteTableId: markerRef(VpcResourceId.PUBLIC_ROUTE_TABLE),
  },
  [VpcResourceId.PRIVATE_SUBNET_1_RT_ASSOC]: {
    SubnetId: markerRef(VpcResourceId.PRIVATE_SUBNET_1),
    RouteTableId: markerRef(VpcResourceId.PRIVATE_ROUTE_TABLE),
  },
  [VpcResourceId.PRIVATE_SUBNET_2_RT_ASSOC]: {
    SubnetId: markerRef(VpcResourceId.PRIVATE_SUBNET_2),
    RouteTableId: markerRef(VpcResourceId.PRIVATE_ROUTE_TABLE),
  },
} as const;
