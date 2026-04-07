/**
 * Free Resource Pricing Decomposers — resources that have no billable
 * components (VPC, Subnet, Security Group, IAM Role, etc.).
 *
 * Each decomposer returns an empty array since these resources are free.
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

function createFreeDecomposer(resourceType: string): PricingDecomposer {
  return {
    resourceType,
    decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
      return [];
    },
  };
}

export const vpcPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EC2_VPC,
);
export const subnetPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EC2_SUBNET,
);
export const securityGroupPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EC2_SECURITY_GROUP,
);
export const iamRolePricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.IAM_ROLE,
);
export const internetGatewayPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
);
export const routeTablePricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EC2_ROUTE_TABLE,
);
export const routePricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EC2_ROUTE,
);
export const ecsClusterPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.ECS_CLUSTER,
);
// WV4-A: VPC compound cross-references — pure CFN linkage with no
// billable cost (the underlying VPC/IGW/Subnet/RouteTable carry any
// charges; the attachment/association resources themselves are free).
export const vpcGatewayAttachmentPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT,
);
export const subnetRouteTableAssociationPricingDecomposer =
  createFreeDecomposer(RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION);
