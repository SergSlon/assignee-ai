import { PricingDecomposerRegistry } from "../decomposer-registry.js";
import { kmsKeyPricingDecomposer } from "../decomposers/kms-key.js";
import { eventsApiDestinationPricingDecomposer } from "../decomposers/events-apidestination.js";
import { cloudFrontDistributionPricingDecomposer } from "../decomposers/cloudfront-distribution.js";
import { ec2PricingDecomposer } from "../decomposers/ec2.js";
import { rdsPricingDecomposer } from "../decomposers/rds.js";
import { s3PricingDecomposer } from "../decomposers/s3.js";
import { lambdaPricingDecomposer } from "../decomposers/lambda.js";
import { dynamodbPricingDecomposer } from "../decomposers/dynamodb.js";
// Epic 39: Pricing decomposers for all resource types
import { natGatewayPricingDecomposer } from "../decomposers/nat-gateway.js";
import { elbv2PricingDecomposer } from "../decomposers/elbv2.js";
import { apigatewayV2PricingDecomposer } from "../decomposers/apigatewayv2.js";
import { sqsPricingDecomposer } from "../decomposers/sqs.js";
import { snsPricingDecomposer } from "../decomposers/sns.js";
import { secretsManagerPricingDecomposer } from "../decomposers/secretsmanager.js";
import { cloudWatchAlarmPricingDecomposer } from "../decomposers/cloudwatch-alarm.js";
import { logsPricingDecomposer } from "../decomposers/logs.js";
import { ecrPricingDecomposer } from "../decomposers/ecr.js";
import { ssmPricingDecomposer } from "../decomposers/ssm.js";
// A1 (2026-04-08) — EFS
import { efsPricingDecomposer } from "../decomposers/efs.js";
import {
  vpcPricingDecomposer,
  subnetPricingDecomposer,
  securityGroupPricingDecomposer,
  iamRolePricingDecomposer,
  internetGatewayPricingDecomposer,
  routeTablePricingDecomposer,
  routePricingDecomposer,
  ecsClusterPricingDecomposer,
  // WV4-A
  vpcGatewayAttachmentPricingDecomposer,
  subnetRouteTableAssociationPricingDecomposer,
  // A1 follow-up
  efsMountTargetPricingDecomposer,
  // A8 (2026-04-08): EventBridge Rule is free on the default bus
  eventsRulePricingDecomposer,
  // A9 (2026-04-09): EventBridge custom event bus
  eventsEventBusPricingDecomposer,
  // A10 (2026-04-09): SNS Subscription — cost owned by topic + target
  snsSubscriptionPricingDecomposer,
  // A12 (2026-04-09): Events::Connection — free (cost on ApiDestination)
  eventsConnectionPricingDecomposer,
  // (f) 2026-04-09 Task 4b: CloudFront OAC + S3 BucketPolicy — both free
  cloudFrontOacPricingDecomposer,
  s3BucketPolicyPricingDecomposer,
  // 2026-04-13: RDS::DBSubnetGroup
  rdsDbSubnetGroupPricingDecomposer,
} from "../decomposers/free.js";

/**
 * The default pre-populated pricing decomposer registry (Story 23.1).
 * Returns line-item breakdowns for resources with multi-component pricing.
 */
export const defaultDecomposerRegistry = new PricingDecomposerRegistry();
defaultDecomposerRegistry.register(ec2PricingDecomposer);
defaultDecomposerRegistry.register(rdsPricingDecomposer);
defaultDecomposerRegistry.register(s3PricingDecomposer);
defaultDecomposerRegistry.register(lambdaPricingDecomposer);
defaultDecomposerRegistry.register(dynamodbPricingDecomposer);
// Epic 39: all remaining decomposers
defaultDecomposerRegistry.register(natGatewayPricingDecomposer);
defaultDecomposerRegistry.register(elbv2PricingDecomposer);
defaultDecomposerRegistry.register(apigatewayV2PricingDecomposer);
defaultDecomposerRegistry.register(sqsPricingDecomposer);
defaultDecomposerRegistry.register(snsPricingDecomposer);
defaultDecomposerRegistry.register(secretsManagerPricingDecomposer);
defaultDecomposerRegistry.register(cloudWatchAlarmPricingDecomposer);
defaultDecomposerRegistry.register(logsPricingDecomposer);
defaultDecomposerRegistry.register(ecrPricingDecomposer);
defaultDecomposerRegistry.register(ssmPricingDecomposer);
defaultDecomposerRegistry.register(vpcPricingDecomposer);
defaultDecomposerRegistry.register(subnetPricingDecomposer);
defaultDecomposerRegistry.register(securityGroupPricingDecomposer);
defaultDecomposerRegistry.register(iamRolePricingDecomposer);
defaultDecomposerRegistry.register(internetGatewayPricingDecomposer);
defaultDecomposerRegistry.register(routeTablePricingDecomposer);
defaultDecomposerRegistry.register(routePricingDecomposer);
defaultDecomposerRegistry.register(ecsClusterPricingDecomposer);
// WV4-A: VPC compound cross-references
defaultDecomposerRegistry.register(vpcGatewayAttachmentPricingDecomposer);
defaultDecomposerRegistry.register(
  subnetRouteTableAssociationPricingDecomposer,
);
// A1 (2026-04-08) — EFS
defaultDecomposerRegistry.register(efsPricingDecomposer);
defaultDecomposerRegistry.register(efsMountTargetPricingDecomposer);
defaultDecomposerRegistry.register(eventsRulePricingDecomposer);
defaultDecomposerRegistry.register(eventsEventBusPricingDecomposer);
// A10 (2026-04-09) — SNS Subscription
defaultDecomposerRegistry.register(snsSubscriptionPricingDecomposer);
// A11 (2026-04-09) — KMS::Key
defaultDecomposerRegistry.register(kmsKeyPricingDecomposer);
// A12 (2026-04-09) — Events::Connection (free)
defaultDecomposerRegistry.register(eventsConnectionPricingDecomposer);
// A13 (2026-04-09) — Events::ApiDestination (usage-based)
defaultDecomposerRegistry.register(eventsApiDestinationPricingDecomposer);
// A14 (2026-04-09) — CloudFront::Distribution (usage-based data + reqs)
defaultDecomposerRegistry.register(cloudFrontDistributionPricingDecomposer);
// (f) 2026-04-09 Task 4b — CloudFront::OriginAccessControl + S3::BucketPolicy
// (both free — cost lives on parent CloudFront distribution and S3 bucket)
defaultDecomposerRegistry.register(cloudFrontOacPricingDecomposer);
defaultDecomposerRegistry.register(s3BucketPolicyPricingDecomposer);
// 2026-04-13: RDS::DBSubnetGroup
defaultDecomposerRegistry.register(rdsDbSubnetGroupPricingDecomposer);

export { PricingDecomposerRegistry };
