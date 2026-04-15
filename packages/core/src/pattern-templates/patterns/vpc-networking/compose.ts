/**
 * Compose the VPC networking pattern variants from the layer modules.
 *
 * Split from vpc-networking.ts (W6d F3). Assembly order matters — CFN
 * requires VPC → IGW → subnets → route-tables → NAT → SGs → instances,
 * and the dependencyOrder here reflects that constraint.
 */

import type { ArchitecturePattern } from "../../types.js";
import {
  VpcResourceId,
  vpcAndPublicSubnetResources,
  privateSubnetResources,
  subnetDefaults,
} from "./subnet-plan.js";
import {
  igwResources,
  publicRouteResources,
  privateRouteResources,
  publicSubnetRtAssocResources,
  privateSubnetRtAssocResources,
  routeTableDefaults,
} from "./route-table-plan.js";
import { natGatewayResources, natGatewayDefaults } from "./nat-gateway-plan.js";
import {
  securityGroupResources,
  securityGroupDefaults,
} from "./security-group-plan.js";

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
    ...vpcAndPublicSubnetResources,
    ...privateSubnetResources,
    ...igwResources,
    ...publicRouteResources,
    ...privateRouteResources,
    ...natGatewayResources,
    ...publicSubnetRtAssocResources,
    ...privateSubnetRtAssocResources,
    ...securityGroupResources,
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
    ...subnetDefaults,
    ...routeTableDefaults,
    ...natGatewayDefaults,
    ...securityGroupDefaults,
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
    ...vpcAndPublicSubnetResources,
    ...igwResources,
    // Public-only variant keeps just the public route table (no private RT)
    ...publicRouteResources,
    ...publicSubnetRtAssocResources,
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
    // Reuse the shared VPC+subnet+route-table defaults but filter out the
    // private-subnet + private-route-table keys that this variant does
    // not ship. Using explicit picks keeps the compose step declarative.
    [VpcResourceId.VPC]: subnetDefaults[VpcResourceId.VPC],
    [VpcResourceId.PUBLIC_SUBNET_1]:
      subnetDefaults[VpcResourceId.PUBLIC_SUBNET_1],
    [VpcResourceId.PUBLIC_SUBNET_2]:
      subnetDefaults[VpcResourceId.PUBLIC_SUBNET_2],
    [VpcResourceId.IGW]: routeTableDefaults[VpcResourceId.IGW],
    [VpcResourceId.IGW_ATTACHMENT]:
      routeTableDefaults[VpcResourceId.IGW_ATTACHMENT],
    [VpcResourceId.PUBLIC_ROUTE_TABLE]:
      routeTableDefaults[VpcResourceId.PUBLIC_ROUTE_TABLE],
    [VpcResourceId.PUBLIC_ROUTE]:
      routeTableDefaults[VpcResourceId.PUBLIC_ROUTE],
    [VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC]:
      routeTableDefaults[VpcResourceId.PUBLIC_SUBNET_1_RT_ASSOC],
    [VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC]:
      routeTableDefaults[VpcResourceId.PUBLIC_SUBNET_2_RT_ASSOC],
  },
};
