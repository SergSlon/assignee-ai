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
// A1 follow-up: EFS MountTarget is free — the billable cost lives
// on the parent EFS::FileSystem (storage) and the NFS data transfer
// across the VPC.
export const efsMountTargetPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EFS_MOUNT_TARGET,
);
// A8 (2026-04-08): EventBridge Rule is free on the default bus. Rule
// evaluation and AWS-service-event delivery to targets on the default
// bus bill $0. Custom event buses bill $1/million events at the BUS
// level, not the rule level — the decomposer returns [] because the
// per-month cost of a rule is not knowable from its desiredState
// (depends on publish volume, which is a workload fact). Target
// workload fees (Lambda invocation, SQS delivery) come from the
// target's own decomposer and are counted there.
export const eventsRulePricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EVENTS_RULE,
);
// A9 (2026-04-09): AWS::Events::EventBus bills $1.00 per million
// events PUBLISHED to the bus. The per-event rate is fixed but the
// publish volume is workload-dependent — not knowable from the
// desiredState — so the decomposer returns []. The cost-advisor
// surfaces the $1/M rate as a workload-cost reminder when the user
// creates a non-default event bus.
export const eventsEventBusPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EVENTS_EVENT_BUS,
);
// A10 (2026-04-09): AWS::SNS::Subscription is pure plumbing — it
// has no per-subscription charge. All billable traffic is counted
// by the parent SNS::Topic (publish + delivery fees) and the
// target service (SQS/Lambda/Firehose/etc.). Decomposer returns []
// so the subscription shows up in the plan box without double-
// counting what the topic is already charging for.
export const snsSubscriptionPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.SNS_SUBSCRIPTION,
);
// A12 (2026-04-09): AWS::Events::Connection is free — the cost
// lives on the ApiDestination that references it (per-invocation
// HTTP fee) and on the target service if there is one. The
// managed Secrets Manager secret that Connection creates on your
// behalf is NOT separately billed; it's bundled into the Connection
// lifecycle. Decomposer returns [] accordingly.
export const eventsConnectionPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.EVENTS_CONNECTION,
);
// (f) 2026-04-09 Task 4b: AWS::CloudFront::OriginAccessControl is
// free. OAC itself has no meter; the SigV4 signing work happens on
// CloudFront's edge nodes whose cost is already captured by the
// parent distribution's per-request pricing. Decomposer returns [].
export const cloudFrontOacPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
);
// (f) 2026-04-09 Task 4b: AWS::S3::BucketPolicy is free — the policy
// IS an attribute of the bucket, and S3 does not bill for policy
// evaluation. The bucket itself is billed (storage, requests,
// transfer) by the s3PricingDecomposer. Returns [] accordingly.
export const s3BucketPolicyPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.S3_BUCKET_POLICY,
);
// 2026-04-13: AWS::RDS::DBSubnetGroup is free — the subnet group is
// pure VPC wiring that tells RDS which subnets to place ENIs in. The
// billable cost lives entirely on the parent RDS::DBInstance (compute,
// storage, I/O, backups). Decomposer returns [] accordingly.
export const rdsDbSubnetGroupPricingDecomposer = createFreeDecomposer(
  RESOURCE_TYPES.RDS_DB_SUBNET_GROUP,
);
