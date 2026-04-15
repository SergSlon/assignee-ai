/**
 * Compose the three-tier-web pattern from its layer modules.
 *
 * Split from three-tier-web.ts (W6d F3). VPC + App + DB + ALB layers
 * are assembled into the final ArchitecturePattern, and the
 * dependencyOrder here encodes the provisioning sequence required by
 * CloudControl (VPC → IGW → subnets → RTs → routes → associations →
 * SGs + DBSubnetGroup → compute + DB).
 */

import type { ArchitecturePattern } from "../../types.js";
import { ThreeTierWebResourceId as R } from "../../pattern-resource-ids.js";
import { PatternId } from "../../pattern-ids.js";
import { vpcLayerResources, vpcLayerDefaults } from "./vpc-layer.js";
import { appLayerResources, appLayerDefaults } from "./app-layer.js";
import { dbLayerResources, dbLayerDefaults } from "./db-layer.js";
import { albLayerResources, albLayerDefaults } from "./alb-layer.js";

/**
 * Three-Tier Web Application compound pattern.
 *
 * Embeds a full VPC (public + private subnets, no NAT gateway) so the
 * ALB gets multi-AZ public subnets, EC2 goes in public subnets (with
 * internet access for updates), and RDS goes in private subnets via a
 * DBSubnetGroup. No NAT because RDS doesn't need internet access and
 * the EC2 instance uses public subnets.
 *
 * Resources (22 total):
 *   VPC layer (14):
 *     1 VPC, 2 public subnets, 2 private subnets (multi-AZ),
 *     1 IGW, 1 IGW attachment, 2 route tables (public + private),
 *     1 public Route, 4 SubnetRouteTableAssociations
 *   Application layer (8):
 *     3 SecurityGroups (ALB + App + DB), 1 IAM Instance Profile Role,
 *     1 RDS DBSubnetGroup, 1 ALB, 1 EC2 Instance, 1 RDS DBInstance
 *
 * Cost note: $0 networking (IGW and routes are free, no NAT gateway).
 * ALB bills per-hour + LCU. EC2 bills per instance-hour. RDS bills per
 * instance-hour + storage. All three have free-tier eligible options.
 *
 * @see container-service.ts for the public-only VPC variant.
 * @see efs-with-vpc.ts for the private-only VPC variant.
 */
export const threeTierWebPattern: ArchitecturePattern = {
  patternId: PatternId.THREE_TIER_WEB,
  displayName: "Three-Tier Web Application",
  keywords: [
    "three tier",
    "3 tier",
    "three-tier",
    "web application with database",
    "alb ec2 rds",
    "load balanced web app",
    "traditional web stack",
  ],
  resourceList: [
    ...vpcLayerResources,
    ...appLayerResources,
    ...dbLayerResources,
    ...albLayerResources,
  ],
  dependencyOrder: [
    // Group 0: VPC first
    [R.VPC],
    // Group 1: Subnets + IGW + VPC-independent resources (role)
    [
      R.PUBLIC_SUBNET_1,
      R.PUBLIC_SUBNET_2,
      R.PRIVATE_SUBNET_1,
      R.PRIVATE_SUBNET_2,
      R.IGW,
      R.INSTANCE_PROFILE_ROLE,
    ],
    // Group 2: IGW attachment + route tables + SGs + DB subnet group
    [
      R.IGW_ATTACHMENT,
      R.PUBLIC_ROUTE_TABLE,
      R.PRIVATE_ROUTE_TABLE,
      R.ALB_SG,
      R.APP_SG,
      R.DB_SG,
      R.DB_SUBNET_GROUP,
    ],
    // Group 3: Public route (needs RT + IGW attachment)
    [R.PUBLIC_ROUTE],
    // Group 4: Subnet ↔ RT associations
    [
      R.PUBLIC_SUBNET_1_RT_ASSOC,
      R.PUBLIC_SUBNET_2_RT_ASSOC,
      R.PRIVATE_SUBNET_1_RT_ASSOC,
      R.PRIVATE_SUBNET_2_RT_ASSOC,
    ],
    // Group 5: Compute + DB (need subnets + SGs + DBSubnetGroup)
    [R.ALB, R.EC2_INSTANCE, R.RDS_INSTANCE],
  ],
  defaultOptions: {
    ...vpcLayerDefaults,
    ...appLayerDefaults,
    ...dbLayerDefaults,
    ...albLayerDefaults,
  },
};
