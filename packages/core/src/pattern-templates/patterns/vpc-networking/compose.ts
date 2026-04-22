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
  /**
   * Epic 92 wave 2.b (finding B-05): bare "Create a VPC" used to
   * short-circuit to this 17-resource compound that includes a
   * ~$32.85/month NAT Gateway — a surprise expense for users who
   * just wanted the single AWS::EC2::VPC resource to poke at.
   *
   * The keyword set is now tightened so only explicit multi-subnet /
   * NAT-bearing intents trigger the full compound. Bare intents like
   * "create a vpc" / "vpc network" now fall through the registry
   * (no match) and the LLM classifier routes them to the standalone
   * AWS::EC2::VPC type (or to the cheaper `vpc-public-only` variant
   * if the user hints at free-tier / no-NAT).
   *
   * The new keyword list requires one of:
   *   - "public and private subnets" — explicit about the 4-subnet
   *     multi-AZ layout
   *   - "networking foundation" — common Well-Architected phrasing
   *   - "with nat" / "with nat gateway" — user knows they want NAT
   *   - "multi-az vpc" — retained from the previous set, clearly
   *     implies a multi-AZ compound
   *   - "vpc with subnets" / "vpc with public and private" — retained
   *     explicit-compound phrases
   */
  keywords: [
    "vpc with public and private subnets",
    "vpc with subnets",
    "vpc with networking",
    "networking foundation",
    "vpc with nat gateway",
    "vpc with nat",
    "multi-az vpc",
    "vpc public private",
  ],
  /**
   * Epic 92 wave 2.b: even with tighter positive keywords, explicit
   * "standalone" or "existing-vpc" intents must never reach this
   * pattern — they signal the user wants the bare VPC resource or
   * has a VPC already. The "public-only" negative keyword avoids
   * collision with the public-only variant.
   */
  negativeKeywords: [
    "standalone",
    "existing-vpc",
    "existing vpc",
    "on its own",
    "without nat",
    "public only",
    "public-only",
    "no nat",
    // Epic 94 N1 (B-03): mirror the new public-only positive cues so
    // mixed intents ("vpc with public and private subnets, but only
    // public subnets") defeat first-match on the full compound and
    // the public-only variant can win.
    "public subnets only",
    "only public subnets",
    "without private subnets",
    "one public subnet",
    "vpc with public access",
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
  /**
   * Epic 92 wave 2.b: added "vpc without nat" / "public-only vpc" /
   * "vpc no nat" aliases because users routinely phrase the
   * "free-tier VPC" intent in multiple ways. The keyword set
   * remains disjoint from the full vpcNetworkingPattern: each
   * entry includes a clear disclaimer ("public only", "no nat",
   * "cheap", "simple") so the registry can cleanly bifurcate
   * positive hits between the two variants.
   */
  keywords: [
    "vpc public only",
    "vpc public-only",
    "public-only vpc",
    "vpc no private subnets",
    "vpc without nat",
    "vpc no nat",
    "cheap vpc",
    "simple vpc",
    "vpc public subnets only",
    "free-tier vpc",
    "free tier vpc",
    // Epic 94 N1 (B-03): natural phrasing cues. The previous list
    // required contiguous substrings like "vpc public subnets only"
    // which miss the natural "vpc WITH public subnets only" (the
    // inserted "with" breaks contiguity). The new cues are
    // disambiguation-complete — each includes an unambiguous
    // public-only signal (a direct "public", "public access",
    // "without nat/private", or "one public") so they never
    // collide with the full-compound vpcNetworkingPattern.
    "public subnets only", // catches "vpc with public subnets only"
    "only public subnets", // catches "with only public subnets"
    "public only", // catches "vpc, public only"
    "without nat", // catches "create a vpc without NAT"
    "without private subnets", // catches "vpc without private subnets"
    "one public subnet", // catches "vpc with one public subnet"
    "vpc with public access", // catches "create a vpc with public access"
  ],
  /**
   * Standalone intents skip this pattern too — user wanted bare VPC.
   */
  negativeKeywords: [
    "standalone",
    "existing-vpc",
    "existing vpc",
    "on its own",
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
