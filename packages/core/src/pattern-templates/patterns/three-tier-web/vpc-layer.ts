/**
 * VPC layer for the three-tier-web pattern.
 *
 * Split from three-tier-web.ts (W6d F3). Public + private subnets, one
 * IGW, public-only route table (no NAT — RDS stays private, EC2 uses
 * public subnet for updates).
 */

import { RESOURCE_TYPES } from "@/config/resource-types.js";
import { markerRef, markerAz } from "@/config/marker-tokens.js";
import type { ResourceSpec } from "../../types.js";
import { ThreeTierWebResourceId as R } from "../../pattern-resource-ids.js";

const EC2_VPC_GATEWAY_ATTACHMENT = RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT;
const EC2_SUBNET_ROUTE_TABLE_ASSOCIATION =
  RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION;

export const VPC_CIDR = "10.0.0.0/16";

export const vpcLayerResources: ResourceSpec[] = [
  {
    resourceType: RESOURCE_TYPES.EC2_VPC,
    resourceId: R.VPC,
    displayName: "VPC",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_SUBNET,
    resourceId: R.PUBLIC_SUBNET_1,
    displayName: "Public Subnet (AZ-1)",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_SUBNET,
    resourceId: R.PUBLIC_SUBNET_2,
    displayName: "Public Subnet (AZ-2)",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_SUBNET,
    resourceId: R.PRIVATE_SUBNET_1,
    displayName: "Private Subnet (AZ-1)",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_SUBNET,
    resourceId: R.PRIVATE_SUBNET_2,
    displayName: "Private Subnet (AZ-2)",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
    resourceId: R.IGW,
    displayName: "Internet Gateway",
  },
  {
    resourceType: EC2_VPC_GATEWAY_ATTACHMENT,
    resourceId: R.IGW_ATTACHMENT,
    displayName: "VPC Gateway Attachment (IGW)",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
    resourceId: R.PUBLIC_ROUTE_TABLE,
    displayName: "Public Route Table",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
    resourceId: R.PRIVATE_ROUTE_TABLE,
    displayName: "Private Route Table",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_ROUTE,
    resourceId: R.PUBLIC_ROUTE,
    displayName: "Public Route (0.0.0.0/0 → IGW)",
  },
  {
    resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    resourceId: R.PUBLIC_SUBNET_1_RT_ASSOC,
    displayName: "Public Subnet 1 ↔ Public RT",
  },
  {
    resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    resourceId: R.PUBLIC_SUBNET_2_RT_ASSOC,
    displayName: "Public Subnet 2 ↔ Public RT",
  },
  {
    resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    resourceId: R.PRIVATE_SUBNET_1_RT_ASSOC,
    displayName: "Private Subnet 1 ↔ Private RT",
  },
  {
    resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    resourceId: R.PRIVATE_SUBNET_2_RT_ASSOC,
    displayName: "Private Subnet 2 ↔ Private RT",
  },
];

export const vpcLayerDefaults = {
  [R.VPC]: {
    CidrBlock: VPC_CIDR,
    EnableDnsSupport: true,
    EnableDnsHostnames: true,
  },
  [R.PUBLIC_SUBNET_1]: {
    CidrBlock: "10.0.1.0/24",
    AvailabilityZone: markerAz(0),
    MapPublicIpOnLaunch: true,
    VpcId: markerRef(R.VPC),
  },
  [R.PUBLIC_SUBNET_2]: {
    CidrBlock: "10.0.2.0/24",
    AvailabilityZone: markerAz(1),
    MapPublicIpOnLaunch: true,
    VpcId: markerRef(R.VPC),
  },
  [R.PRIVATE_SUBNET_1]: {
    CidrBlock: "10.0.3.0/24",
    AvailabilityZone: markerAz(0),
    MapPublicIpOnLaunch: false,
    VpcId: markerRef(R.VPC),
  },
  [R.PRIVATE_SUBNET_2]: {
    CidrBlock: "10.0.4.0/24",
    AvailabilityZone: markerAz(1),
    MapPublicIpOnLaunch: false,
    VpcId: markerRef(R.VPC),
  },
  [R.IGW]: {},
  [R.IGW_ATTACHMENT]: {
    VpcId: markerRef(R.VPC),
    InternetGatewayId: markerRef(R.IGW),
  },
  [R.PUBLIC_ROUTE_TABLE]: {
    VpcId: markerRef(R.VPC),
  },
  [R.PRIVATE_ROUTE_TABLE]: {
    VpcId: markerRef(R.VPC),
  },
  [R.PUBLIC_ROUTE]: {
    RouteTableId: markerRef(R.PUBLIC_ROUTE_TABLE),
    DestinationCidrBlock: "0.0.0.0/0",
    GatewayId: markerRef(R.IGW),
  },
  [R.PUBLIC_SUBNET_1_RT_ASSOC]: {
    SubnetId: markerRef(R.PUBLIC_SUBNET_1),
    RouteTableId: markerRef(R.PUBLIC_ROUTE_TABLE),
  },
  [R.PUBLIC_SUBNET_2_RT_ASSOC]: {
    SubnetId: markerRef(R.PUBLIC_SUBNET_2),
    RouteTableId: markerRef(R.PUBLIC_ROUTE_TABLE),
  },
  [R.PRIVATE_SUBNET_1_RT_ASSOC]: {
    SubnetId: markerRef(R.PRIVATE_SUBNET_1),
    RouteTableId: markerRef(R.PRIVATE_ROUTE_TABLE),
  },
  [R.PRIVATE_SUBNET_2_RT_ASSOC]: {
    SubnetId: markerRef(R.PRIVATE_SUBNET_2),
    RouteTableId: markerRef(R.PRIVATE_ROUTE_TABLE),
  },
} as const;
