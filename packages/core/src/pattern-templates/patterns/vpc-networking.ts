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
      resourceId: "vpc",
      displayName: "VPC",
    },
    // Public Subnets (multi-AZ)
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "public-subnet-1",
      displayName: "Public Subnet (AZ-1)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "public-subnet-2",
      displayName: "Public Subnet (AZ-2)",
    },
    // Private Subnets (multi-AZ)
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "private-subnet-1",
      displayName: "Private Subnet (AZ-1)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "private-subnet-2",
      displayName: "Private Subnet (AZ-2)",
    },
    // Internet Gateway + VPC attachment
    {
      resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
      resourceId: "igw",
      displayName: "Internet Gateway",
    },
    {
      resourceType: EC2_VPC_GATEWAY_ATTACHMENT,
      resourceId: "igw-attachment",
      displayName: "VPC Gateway Attachment (IGW)",
      provisionable: false,
    },
    // Route Tables
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: "public-route-table",
      displayName: "Public Route Table",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: "private-route-table",
      displayName: "Private Route Table",
    },
    // Routes
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE,
      resourceId: "public-route",
      displayName: "Public Route (0.0.0.0/0 → IGW)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE,
      resourceId: "private-route",
      displayName: "Private Route (0.0.0.0/0 → NAT)",
    },
    // NAT Gateway + EIP
    {
      resourceType: EC2_EIP,
      resourceId: "nat-eip",
      displayName: "Elastic IP (for NAT Gateway)",
      provisionable: false,
    },
    {
      resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
      resourceId: "nat-gateway",
      displayName: "NAT Gateway",
    },
    // Subnet ↔ RouteTable associations
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "public-subnet-1-rt-assoc",
      displayName: "Public Subnet 1 ↔ Public RT",
      provisionable: false,
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "public-subnet-2-rt-assoc",
      displayName: "Public Subnet 2 ↔ Public RT",
      provisionable: false,
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "private-subnet-1-rt-assoc",
      displayName: "Private Subnet 1 ↔ Private RT",
      provisionable: false,
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "private-subnet-2-rt-assoc",
      displayName: "Private Subnet 2 ↔ Private RT",
      provisionable: false,
    },
  ],
  dependencyOrder: [
    // Group 0: VPC first — everything else depends on it
    ["vpc"],
    // Group 1: Subnets + IGW + EIP — all need VpcId (or are independent like EIP)
    [
      "public-subnet-1",
      "public-subnet-2",
      "private-subnet-1",
      "private-subnet-2",
      "igw",
      "nat-eip",
    ],
    // Group 2: IGW attachment + RouteTables — need VpcId + IGW
    ["igw-attachment", "public-route-table", "private-route-table"],
    // Group 3: Public route + NatGateway — public route needs RT + IGW; NAT needs public subnet + EIP
    ["public-route", "nat-gateway"],
    // Group 4: Private route — needs RT + NatGateway
    ["private-route"],
    // Group 5: Subnet ↔ RouteTable associations — need both subnet and RT
    [
      "public-subnet-1-rt-assoc",
      "public-subnet-2-rt-assoc",
      "private-subnet-1-rt-assoc",
      "private-subnet-2-rt-assoc",
    ],
  ],
  defaultOptions: {
    vpc: {
      CidrBlock: "10.0.0.0/16",
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
    },
    "public-subnet-1": {
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: { "Fn::Select": [0, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: true,
      VpcId: { Ref: "vpc" },
    },
    "public-subnet-2": {
      CidrBlock: "10.0.2.0/24",
      AvailabilityZone: { "Fn::Select": [1, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: true,
      VpcId: { Ref: "vpc" },
    },
    "private-subnet-1": {
      CidrBlock: "10.0.3.0/24",
      AvailabilityZone: { "Fn::Select": [0, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: false,
      VpcId: { Ref: "vpc" },
    },
    "private-subnet-2": {
      CidrBlock: "10.0.4.0/24",
      AvailabilityZone: { "Fn::Select": [1, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: false,
      VpcId: { Ref: "vpc" },
    },
    igw: {},
    "igw-attachment": {
      VpcId: { Ref: "vpc" },
      InternetGatewayId: { Ref: "igw" },
    },
    "public-route-table": {
      VpcId: { Ref: "vpc" },
    },
    "private-route-table": {
      VpcId: { Ref: "vpc" },
    },
    "public-route": {
      RouteTableId: { Ref: "public-route-table" },
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: { Ref: "igw" },
    },
    "private-route": {
      RouteTableId: { Ref: "private-route-table" },
      DestinationCidrBlock: "0.0.0.0/0",
      NatGatewayId: { Ref: "nat-gateway" },
    },
    "nat-eip": {
      Domain: "vpc",
    },
    "nat-gateway": {
      SubnetId: { Ref: "public-subnet-1" },
      ConnectivityType: "public",
      [CfnKey.ALLOCATION_ID]: {
        "Fn::GetAtt": ["nat-eip", CfnKey.ALLOCATION_ID],
      },
    },
    "public-subnet-1-rt-assoc": {
      SubnetId: { Ref: "public-subnet-1" },
      RouteTableId: { Ref: "public-route-table" },
    },
    "public-subnet-2-rt-assoc": {
      SubnetId: { Ref: "public-subnet-2" },
      RouteTableId: { Ref: "public-route-table" },
    },
    "private-subnet-1-rt-assoc": {
      SubnetId: { Ref: "private-subnet-1" },
      RouteTableId: { Ref: "private-route-table" },
    },
    "private-subnet-2-rt-assoc": {
      SubnetId: { Ref: "private-subnet-2" },
      RouteTableId: { Ref: "private-route-table" },
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
      resourceId: "vpc",
      displayName: "VPC",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "public-subnet-1",
      displayName: "Public Subnet (AZ-1)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "public-subnet-2",
      displayName: "Public Subnet (AZ-2)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
      resourceId: "igw",
      displayName: "Internet Gateway",
    },
    {
      resourceType: EC2_VPC_GATEWAY_ATTACHMENT,
      resourceId: "igw-attachment",
      displayName: "VPC Gateway Attachment (IGW)",
      provisionable: false,
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: "public-route-table",
      displayName: "Public Route Table",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE,
      resourceId: "public-route",
      displayName: "Public Route (0.0.0.0/0 → IGW)",
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "public-subnet-1-rt-assoc",
      displayName: "Public Subnet 1 ↔ Public RT",
      provisionable: false,
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "public-subnet-2-rt-assoc",
      displayName: "Public Subnet 2 ↔ Public RT",
      provisionable: false,
    },
  ],
  dependencyOrder: [
    ["vpc"],
    ["public-subnet-1", "public-subnet-2", "igw"],
    ["igw-attachment", "public-route-table"],
    ["public-route"],
    ["public-subnet-1-rt-assoc", "public-subnet-2-rt-assoc"],
  ],
  defaultOptions: {
    vpc: {
      CidrBlock: "10.0.0.0/16",
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
    },
    "public-subnet-1": {
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: { "Fn::Select": [0, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: true,
      VpcId: { Ref: "vpc" },
    },
    "public-subnet-2": {
      CidrBlock: "10.0.2.0/24",
      AvailabilityZone: { "Fn::Select": [1, { "Fn::GetAZs": "" }] },
      MapPublicIpOnLaunch: true,
      VpcId: { Ref: "vpc" },
    },
    igw: {},
    "igw-attachment": {
      VpcId: { Ref: "vpc" },
      InternetGatewayId: { Ref: "igw" },
    },
    "public-route-table": {
      VpcId: { Ref: "vpc" },
    },
    "public-route": {
      RouteTableId: { Ref: "public-route-table" },
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: { Ref: "igw" },
    },
    "public-subnet-1-rt-assoc": {
      SubnetId: { Ref: "public-subnet-1" },
      RouteTableId: { Ref: "public-route-table" },
    },
    "public-subnet-2-rt-assoc": {
      SubnetId: { Ref: "public-subnet-2" },
      RouteTableId: { Ref: "public-route-table" },
    },
  },
};
