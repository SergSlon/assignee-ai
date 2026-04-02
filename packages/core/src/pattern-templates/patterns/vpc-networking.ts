import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ArchitecturePattern } from "../types.js";

/** Shorthand aliases for companion resource type constants used in this pattern. */
const EC2_VPC_GATEWAY_ATTACHMENT =
  COMPANION_RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT;
const EC2_SUBNET_ROUTE_TABLE_ASSOCIATION =
  COMPANION_RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION;
const EC2_EIP = COMPANION_RESOURCE_TYPES.EC2_EIP;

/** Logical resource IDs used in VPC patterns — single source of truth. */
const VpcResourceId = {
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

/**
 * Full VPC networking pattern — produces a complete multi-AZ topology with
 * public and private subnets, internet gateway, NAT gateway, route tables,
 * and all required associations.
 *
 * Resources generated (17 total):
 * - 1 VPC
 * - 2 public subnets (multi-AZ)
 * - 2 private subnets (multi-AZ)
 * - 1 InternetGateway + 1 VPCGatewayAttachment
 * - 1 public RouteTable + 1 public Route (0.0.0.0/0 → IGW)
 * - 1 private RouteTable + 1 private Route (0.0.0.0/0 → NatGateway)
 * - 1 NatGateway + 1 EIP
 * - 4 SubnetRouteTableAssociations
 *
 * Cost note: NatGateway is the dominant cost driver (~$32/month).
 *
 * @see Story 25.5 — VPC Compound Pattern Update
 */
export const vpcNetworkingPattern: ArchitecturePattern = {
  patternId: "vpc-networking",
  displayName: "VPC with Public and Private Subnets",
  keywords: [
    "vpc with subnets",
    "vpc with public and private subnets",
    "vpc with networking",
    "create a vpc",
    "vpc network",
    "vpc public private",
    "multi-az vpc",
  ],
  resourceList: [
    // VPC
    {
      resourceType: RESOURCE_TYPES.EC2_VPC,
      resourceId: VpcResourceId.VPC,
      displayName: "VPC",
    },
    // Public Subnets (multi-AZ)
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
    // Private Subnets (multi-AZ)
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
    // Internet Gateway + VPC attachment
    {
      resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
      resourceId: VpcResourceId.IGW,
      displayName: "Internet Gateway",
    },
    {
      resourceType: EC2_VPC_GATEWAY_ATTACHMENT,
      resourceId: VpcResourceId.IGW_ATTACHMENT,
      displayName: "VPC Gateway Attachment (IGW)",
      provisionable: false,
    },
    // Route Tables
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: VpcResourceId.PUBLIC_ROUTE_TABLE,
      displayName: "Public Route Table",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: VpcResourceId.PRIVATE_ROUTE_TABLE,
      displayName: "Private Route Table",
    },
    // Routes
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE,
      resourceId: VpcResourceId.PUBLIC_ROUTE,
      displayName: "Public Route (0.0.0.0/0 → IGW)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE,
      resourceId: VpcResourceId.PRIVATE_ROUTE,
      displayName: "Private Route (0.0.0.0/0 → NAT)",
    },
    // NAT Gateway + EIP
    {
      resourceType: EC2_EIP,
      resourceId: VpcResourceId.NAT_EIP,
      displayName: "Elastic IP (for NAT Gateway)",
      provisionable: false,
    },
    {
      resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
      resourceId: VpcResourceId.NAT_GATEWAY,
      displayName: "NAT Gateway",
    },
    // Subnet ↔ RouteTable associations
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC,
      displayName: "Public Subnet 1 ↔ Public RT",
      provisionable: false,
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC,
      displayName: "Public Subnet 2 ↔ Public RT",
      provisionable: false,
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: VpcResourceId.PRIVATE_SUBNET_1_RT_ASSOC,
      displayName: "Private Subnet 1 ↔ Private RT",
      provisionable: false,
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: VpcResourceId.PRIVATE_SUBNET_2_RT_ASSOC,
      displayName: "Private Subnet 2 ↔ Private RT",
      provisionable: false,
    },
  ],
  dependencyOrder: [
    // Group 0: VPC first — everything else depends on it
    [VpcResourceId.VPC],
    // Group 1: Subnets + IGW + EIP — all need VpcId (or are independent like EIP)
    [
      VpcResourceId.PUBLIC_SUBNET_1,
      VpcResourceId.PUBLIC_SUBNET_2,
      VpcResourceId.PRIVATE_SUBNET_1,
      VpcResourceId.PRIVATE_SUBNET_2,
      VpcResourceId.IGW,
      VpcResourceId.NAT_EIP,
    ],
    // Group 2: IGW attachment + RouteTables — need VpcId + IGW
    [
      VpcResourceId.IGW_ATTACHMENT,
      VpcResourceId.PUBLIC_ROUTE_TABLE,
      VpcResourceId.PRIVATE_ROUTE_TABLE,
    ],
    // Group 3: Public route + NatGateway — public route needs RT + IGW; NAT needs public subnet + EIP
    [VpcResourceId.PUBLIC_ROUTE, VpcResourceId.NAT_GATEWAY],
    // Group 4: Private route — needs RT + NatGateway
    [VpcResourceId.PRIVATE_ROUTE],
    // Group 5: Subnet ↔ RouteTable associations — need both subnet and RT
    [
      VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC,
      VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC,
      VpcResourceId.PRIVATE_SUBNET_1_RT_ASSOC,
      VpcResourceId.PRIVATE_SUBNET_2_RT_ASSOC,
    ],
  ],
  defaultOptions: {
    [VpcResourceId.VPC]: {
      CidrBlock: "10.0.0.0/16",
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
    },
    [VpcResourceId.PUBLIC_SUBNET_1]: {
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: { "Fn::Select": [0, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: true,
      VpcId: { Ref: VpcResourceId.VPC },
    },
    [VpcResourceId.PUBLIC_SUBNET_2]: {
      CidrBlock: "10.0.2.0/24",
      AvailabilityZone: { "Fn::Select": [1, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: true,
      VpcId: { Ref: VpcResourceId.VPC },
    },
    [VpcResourceId.PRIVATE_SUBNET_1]: {
      CidrBlock: "10.0.3.0/24",
      AvailabilityZone: { "Fn::Select": [0, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: false,
      VpcId: { Ref: VpcResourceId.VPC },
    },
    [VpcResourceId.PRIVATE_SUBNET_2]: {
      CidrBlock: "10.0.4.0/24",
      AvailabilityZone: { "Fn::Select": [1, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: false,
      VpcId: { Ref: VpcResourceId.VPC },
    },
    [VpcResourceId.IGW]: {},
    [VpcResourceId.IGW_ATTACHMENT]: {
      VpcId: { Ref: VpcResourceId.VPC },
      InternetGatewayId: { Ref: VpcResourceId.IGW },
    },
    [VpcResourceId.PUBLIC_ROUTE_TABLE]: {
      VpcId: { Ref: VpcResourceId.VPC },
    },
    [VpcResourceId.PRIVATE_ROUTE_TABLE]: {
      VpcId: { Ref: VpcResourceId.VPC },
    },
    [VpcResourceId.PUBLIC_ROUTE]: {
      RouteTableId: { Ref: VpcResourceId.PUBLIC_ROUTE_TABLE },
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: { Ref: VpcResourceId.IGW },
    },
    [VpcResourceId.PRIVATE_ROUTE]: {
      RouteTableId: { Ref: VpcResourceId.PRIVATE_ROUTE_TABLE },
      DestinationCidrBlock: "0.0.0.0/0",
      NatGatewayId: { Ref: VpcResourceId.NAT_GATEWAY },
    },
    [VpcResourceId.NAT_EIP]: {
      Domain: "vpc",
    },
    [VpcResourceId.NAT_GATEWAY]: {
      SubnetId: { Ref: VpcResourceId.PUBLIC_SUBNET_1 },
      ConnectivityType: "public",
      [CfnKey.ALLOCATION_ID]: {
        "Fn::GetAtt": [VpcResourceId.NAT_EIP, CfnKey.ALLOCATION_ID],
      },
    },
    [VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC]: {
      SubnetId: { Ref: VpcResourceId.PUBLIC_SUBNET_1 },
      RouteTableId: { Ref: VpcResourceId.PUBLIC_ROUTE_TABLE },
    },
    [VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC]: {
      SubnetId: { Ref: VpcResourceId.PUBLIC_SUBNET_2 },
      RouteTableId: { Ref: VpcResourceId.PUBLIC_ROUTE_TABLE },
    },
    [VpcResourceId.PRIVATE_SUBNET_1_RT_ASSOC]: {
      SubnetId: { Ref: VpcResourceId.PRIVATE_SUBNET_1 },
      RouteTableId: { Ref: VpcResourceId.PRIVATE_ROUTE_TABLE },
    },
    [VpcResourceId.PRIVATE_SUBNET_2_RT_ASSOC]: {
      SubnetId: { Ref: VpcResourceId.PRIVATE_SUBNET_2 },
      RouteTableId: { Ref: VpcResourceId.PRIVATE_ROUTE_TABLE },
    },
  },
};

/**
 * Public-only VPC variant — no private subnets, no NAT gateway, no EIP.
 * Suitable for cost-sensitive workloads that only need public internet access.
 *
 * Resources generated (11 total):
 * - 1 VPC
 * - 2 public subnets (multi-AZ)
 * - 1 InternetGateway + 1 VPCGatewayAttachment
 * - 1 public RouteTable + 1 public Route (0.0.0.0/0 → IGW)
 * - 2 SubnetRouteTableAssociations
 *
 * Cost note: $0 networking — IGW and routes are free.
 *
 * @see Story 25.5 — VPC Compound Pattern Update (public-only variant)
 */
export const vpcPublicOnlyPattern: ArchitecturePattern = {
  patternId: "vpc-public-only",
  displayName: "VPC with Public Subnets Only",
  keywords: [
    "vpc public only",
    "vpc no private subnets",
    "vpc without nat",
    "cheap vpc",
    "simple vpc",
    "vpc public subnets only",
  ],
  resourceList: [
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
    {
      resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
      resourceId: VpcResourceId.IGW,
      displayName: "Internet Gateway",
    },
    {
      resourceType: EC2_VPC_GATEWAY_ATTACHMENT,
      resourceId: VpcResourceId.IGW_ATTACHMENT,
      displayName: "VPC Gateway Attachment (IGW)",
      provisionable: false,
    },
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
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC,
      displayName: "Public Subnet 1 ↔ Public RT",
      provisionable: false,
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC,
      displayName: "Public Subnet 2 ↔ Public RT",
      provisionable: false,
    },
  ],
  dependencyOrder: [
    [VpcResourceId.VPC],
    [
      VpcResourceId.PUBLIC_SUBNET_1,
      VpcResourceId.PUBLIC_SUBNET_2,
      VpcResourceId.IGW,
    ],
    [VpcResourceId.IGW_ATTACHMENT, VpcResourceId.PUBLIC_ROUTE_TABLE],
    [VpcResourceId.PUBLIC_ROUTE],
    [
      VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC,
      VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC,
    ],
  ],
  defaultOptions: {
    [VpcResourceId.VPC]: {
      CidrBlock: "10.0.0.0/16",
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
    },
    [VpcResourceId.PUBLIC_SUBNET_1]: {
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: { "Fn::Select": [0, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: true,
      VpcId: { Ref: VpcResourceId.VPC },
    },
    [VpcResourceId.PUBLIC_SUBNET_2]: {
      CidrBlock: "10.0.2.0/24",
      AvailabilityZone: { "Fn::Select": [1, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: true,
      VpcId: { Ref: VpcResourceId.VPC },
    },
    [VpcResourceId.IGW]: {},
    [VpcResourceId.IGW_ATTACHMENT]: {
      VpcId: { Ref: VpcResourceId.VPC },
      InternetGatewayId: { Ref: VpcResourceId.IGW },
    },
    [VpcResourceId.PUBLIC_ROUTE_TABLE]: {
      VpcId: { Ref: VpcResourceId.VPC },
    },
    [VpcResourceId.PUBLIC_ROUTE]: {
      RouteTableId: { Ref: VpcResourceId.PUBLIC_ROUTE_TABLE },
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: { Ref: VpcResourceId.IGW },
    },
    [VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC]: {
      SubnetId: { Ref: VpcResourceId.PUBLIC_SUBNET_1 },
      RouteTableId: { Ref: VpcResourceId.PUBLIC_ROUTE_TABLE },
    },
    [VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC]: {
      SubnetId: { Ref: VpcResourceId.PUBLIC_SUBNET_2 },
      RouteTableId: { Ref: VpcResourceId.PUBLIC_ROUTE_TABLE },
    },
  },
};
