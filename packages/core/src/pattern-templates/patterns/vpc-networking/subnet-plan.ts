/**
 * Subnet layer for the vpc-networking pattern family.
 *
 * Split from vpc-networking.ts (W6d F3). Exposes the logical resource IDs,
 * ResourceSpec entries, and defaultOptions fragments for VPC + subnets.
 */

import { RESOURCE_TYPES } from "@/config/resource-types.js";
import { markerRef, markerAz } from "@/config/marker-tokens.js";
import type { ResourceSpec } from "../../types.js";

/** Logical resource IDs used in VPC patterns — single source of truth. */
export const VpcResourceId = {
  VPC: "vpc",
  PUBLIC_SUBNET_1: "public-subnet-1",
  PUBLIC_SUBNET_2: "public-subnet-2",
  PRIVATE_SUBNET_1: "private-subnet-1",
  PRIVATE_SUBNET_2: "private-subnet-2",
  IGW: "igw",
  IGW_ATTACHMENT: "igw-attachment",
  PUBLIC_ROUTE_TABLE: "public-route-table",
  PRIVATE_ROUTE_TABLE: "private-route-table",
  PUBLIC_ROUTE: "public-route",
  PRIVATE_ROUTE: "private-route",
  NAT_EIP: "nat-eip",
  NAT_GATEWAY: "nat-gateway",
  PUBLIC_SUBNET_1_RT_ASSOC: "public-subnet-1-rt-assoc",
  PUBLIC_SUBNET_2_RT_ASSOC: "public-subnet-2-rt-assoc",
  PRIVATE_SUBNET_1_RT_ASSOC: "private-subnet-1-rt-assoc",
  PRIVATE_SUBNET_2_RT_ASSOC: "private-subnet-2-rt-assoc",
} as const;

/** VPC + public subnets — present in every VPC variant. */
export const vpcAndPublicSubnetResources: ResourceSpec[] = [
  {
    resourceType: RESOURCE_TYPES.EC2_VPC,
    resourceId: VpcResourceId.VPC,
    displayName: "VPC",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_SUBNET,
    resourceId: VpcResourceId.PUBLIC_SUBNET_1,
    displayName: "Public Subnet (AZ-1)",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_SUBNET,
    resourceId: VpcResourceId.PUBLIC_SUBNET_2,
    displayName: "Public Subnet (AZ-2)",
  },
];

/** Private subnets — present only when a private tier is needed. */
export const privateSubnetResources: ResourceSpec[] = [
  {
    resourceType: RESOURCE_TYPES.EC2_SUBNET,
    resourceId: VpcResourceId.PRIVATE_SUBNET_1,
    displayName: "Private Subnet (AZ-1)",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_SUBNET,
    resourceId: VpcResourceId.PRIVATE_SUBNET_2,
    displayName: "Private Subnet (AZ-2)",
  },
];

export const subnetDefaults = {
  [VpcResourceId.VPC]: {
    CidrBlock: "10.0.0.0/16",
    EnableDnsSupport: true,
    EnableDnsHostnames: true,
  },
  [VpcResourceId.PUBLIC_SUBNET_1]: {
    CidrBlock: "10.0.1.0/24",
    AvailabilityZone: markerAz(0),
    MapPublicIpOnLaunch: true,
    VpcId: markerRef(VpcResourceId.VPC),
  },
  [VpcResourceId.PUBLIC_SUBNET_2]: {
    CidrBlock: "10.0.2.0/24",
    AvailabilityZone: markerAz(1),
    MapPublicIpOnLaunch: true,
    VpcId: markerRef(VpcResourceId.VPC),
  },
  [VpcResourceId.PRIVATE_SUBNET_1]: {
    CidrBlock: "10.0.3.0/24",
    AvailabilityZone: markerAz(0),
    MapPublicIpOnLaunch: false,
    VpcId: markerRef(VpcResourceId.VPC),
  },
  [VpcResourceId.PRIVATE_SUBNET_2]: {
    CidrBlock: "10.0.4.0/24",
    AvailabilityZone: markerAz(1),
    MapPublicIpOnLaunch: false,
    VpcId: markerRef(VpcResourceId.VPC),
  },
} as const;
