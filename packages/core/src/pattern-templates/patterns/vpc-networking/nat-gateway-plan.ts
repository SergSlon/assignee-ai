/**
 * NAT gateway + EIP layer for the vpc-networking pattern family.
 *
 * Split from vpc-networking.ts (W6d F3). Only loaded for variants that
 * need outbound internet from private subnets (i.e. the full
 * vpc-networking pattern, NOT vpc-public-only).
 */

import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "@/config/resource-types.js";
import { CfnKey, AwsDefault, EIP_AUTO_ALLOCATE } from "@/config/cfn-keys.js";
import { markerRef } from "@/config/marker-tokens.js";
import type { ResourceSpec } from "../../types.js";
import { VpcResourceId } from "./subnet-plan.js";

const EC2_EIP = COMPANION_RESOURCE_TYPES.EC2_EIP;

export const natGatewayResources: ResourceSpec[] = [
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
];

export const natGatewayDefaults = {
  [VpcResourceId.NAT_EIP]: {
    // NAT_EIP is provisionable:false — the EIP is allocated by the
    // resource-provisioner's auto-allocate path (see EIP_AUTO_ALLOCATE
    // handling) when the NAT gateway is created.
    Domain: "vpc",
  },
  [VpcResourceId.NAT_GATEWAY]: {
    SubnetId: markerRef(VpcResourceId.PUBLIC_SUBNET_1),
    ConnectivityType: AwsDefault.CONNECTIVITY_PUBLIC,
    // EIP_AUTO_ALLOCATE is a concrete sentinel string (not a CFN intrinsic)
    // that the resource-provisioner replaces at apply time with a real
    // AllocationId after calling EC2:AllocateAddress.
    [CfnKey.ALLOCATION_ID]: EIP_AUTO_ALLOCATE,
  },
} as const;
