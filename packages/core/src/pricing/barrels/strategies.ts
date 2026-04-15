import { PricingStrategyRegistry } from "../registry.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { s3PricingStrategy } from "../strategies/s3.js";
import { ssmPricingStrategy } from "../strategies/ssm.js";
import { iamRolePricingStrategy } from "../strategies/iam-role.js";
import { ec2PricingStrategy } from "../strategies/ec2.js";
import { rdsPricingStrategy } from "../strategies/rds.js";
import { lambdaPricingStrategy } from "../strategies/lambda.js";
import { securityGroupPricingStrategy } from "../strategies/security-group.js";
import { dynamodbPricingStrategy } from "../strategies/dynamodb.js";
import { vpcPricingStrategy } from "../strategies/vpc.js";
import { subnetPricingStrategy } from "../strategies/subnet.js";
import { sqsPricingStrategy } from "../strategies/sqs.js";
import { snsPricingStrategy } from "../strategies/sns.js";
import { ecsClusterPricingStrategy } from "../strategies/ecs-cluster.js";
import { ecrPricingStrategy } from "../strategies/ecr.js";
import { elbv2PricingStrategy } from "../strategies/elbv2.js";
// Sprint F: Tier 1 pricing strategies (Epic 25)
import { logsPricingStrategy } from "../strategies/logs.js";
import { internetGatewayPricingStrategy } from "../strategies/internet-gateway.js";
import { routeTablePricingStrategy } from "../strategies/route-table.js";
import { routePricingStrategy } from "../strategies/route.js";
import { natGatewayPricingStrategy } from "../strategies/nat-gateway.js";
// Sprint G: Tier 2 pricing strategies (Epic 26)
import { apiGatewayV2PricingStrategy } from "../strategies/apigatewayv2.js";
import { cloudWatchAlarmPricingStrategy } from "../strategies/cloudwatch-alarm.js";
import { secretsManagerPricingStrategy } from "../strategies/secretsmanager.js";
// WV4-A: VPC compound cross-reference free-tier strategies
import { vpcGatewayAttachmentPricingStrategy } from "../strategies/vpc-gateway-attachment.js";
import { subnetRouteTableAssociationPricingStrategy } from "../strategies/subnet-route-table-association.js";
// A1 (2026-04-08) — EFS
import { efsPricingStrategy } from "../strategies/efs.js";
import { efsMountTargetPricingStrategy } from "../strategies/efs-mount-target.js";
// A8 (2026-04-08) — EventBridge Rule
import { eventsRulePricingStrategy } from "../strategies/events-rule.js";
// A9 (2026-04-09) — EventBridge custom event bus
import { eventsEventBusPricingStrategy } from "../strategies/events-eventbus.js";
// A10 (2026-04-09) — SNS Subscription promoted out of CCAPI_FALLBACK_TYPES
import { snsSubscriptionPricingStrategy } from "../strategies/sns-subscription.js";
import { cloudFrontOacPricingStrategy } from "../strategies/cloudfront-origin-access-control.js";
import { s3BucketPolicyPricingStrategy } from "../strategies/s3-bucket-policy.js";
// 2026-04-13: RDS::DBSubnetGroup (free — cost on parent RDS instance)
import { rdsDbSubnetGroupPricingStrategy } from "../strategies/rds-db-subnet-group.js";
// A11 (2026-04-09) — KMS::Key first-class (customer-managed keys)
import { kmsKeyPricingStrategy } from "../strategies/kms-key.js";
// A12 (2026-04-09) — Events::Connection first-class (free)
import { eventsConnectionPricingStrategy } from "../strategies/events-connection.js";
// A13 (2026-04-09) — Events::ApiDestination first-class ($0.20/1M invocations)
import { eventsApiDestinationPricingStrategy } from "../strategies/events-apidestination.js";
// A14 (2026-04-09) — CloudFront::Distribution first-class (data transfer + reqs)
import { cloudFrontDistributionPricingStrategy } from "../strategies/cloudfront-distribution.js";

/**
 * The default pre-populated pricing registry for Assignee.ai.
 * Import this in graph nodes — do not instantiate a new PricingStrategyRegistry elsewhere.
 *
 * To add a new resource type:
 *   1. Create `strategies/<resource>.ts` implementing PricingStrategy
 *   2. Import and register it here
 *   Zero changes to preflight-guard or other nodes are required.
 */
export const defaultPricingRegistry = new PricingStrategyRegistry();
defaultPricingRegistry.register(RESOURCE_TYPES.S3_BUCKET, s3PricingStrategy);
defaultPricingRegistry.register(
  RESOURCE_TYPES.SSM_PARAMETER,
  ssmPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.IAM_ROLE,
  iamRolePricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.EC2_INSTANCE,
  ec2PricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.RDS_DB_INSTANCE,
  rdsPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.LAMBDA_FUNCTION,
  lambdaPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.EC2_SECURITY_GROUP,
  securityGroupPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.DYNAMODB_TABLE,
  dynamodbPricingStrategy,
);
defaultPricingRegistry.register(RESOURCE_TYPES.EC2_VPC, vpcPricingStrategy);
defaultPricingRegistry.register(
  RESOURCE_TYPES.EC2_SUBNET,
  subnetPricingStrategy,
);
defaultPricingRegistry.register(RESOURCE_TYPES.SQS_QUEUE, sqsPricingStrategy);
defaultPricingRegistry.register(RESOURCE_TYPES.SNS_TOPIC, snsPricingStrategy);
defaultPricingRegistry.register(
  RESOURCE_TYPES.ECS_CLUSTER,
  ecsClusterPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.ECR_REPOSITORY,
  ecrPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
  elbv2PricingStrategy,
);
// Sprint F: Tier 1 resources (Epic 25)
defaultPricingRegistry.register(
  RESOURCE_TYPES.LOGS_LOG_GROUP,
  logsPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
  internetGatewayPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.EC2_ROUTE_TABLE,
  routeTablePricingStrategy,
);
defaultPricingRegistry.register(RESOURCE_TYPES.EC2_ROUTE, routePricingStrategy);
defaultPricingRegistry.register(
  RESOURCE_TYPES.EC2_NAT_GATEWAY,
  natGatewayPricingStrategy,
);
// Sprint G: Tier 2 resources (Epic 26)
defaultPricingRegistry.register(
  RESOURCE_TYPES.APIGATEWAYV2_API,
  apiGatewayV2PricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.CLOUDWATCH_ALARM,
  cloudWatchAlarmPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.SECRETSMANAGER_SECRET,
  secretsManagerPricingStrategy,
);
// WV4-A: VPC compound cross-references — free
defaultPricingRegistry.register(
  RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT,
  vpcGatewayAttachmentPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
  subnetRouteTableAssociationPricingStrategy,
);
// A1 (2026-04-08) — EFS
defaultPricingRegistry.register(
  RESOURCE_TYPES.EFS_FILE_SYSTEM,
  efsPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.EFS_MOUNT_TARGET,
  efsMountTargetPricingStrategy,
);
// A8 (2026-04-08) — EventBridge Rule
defaultPricingRegistry.register(
  RESOURCE_TYPES.EVENTS_RULE,
  eventsRulePricingStrategy,
);
// A9 (2026-04-09) — EventBridge custom event bus
defaultPricingRegistry.register(
  RESOURCE_TYPES.EVENTS_EVENT_BUS,
  eventsEventBusPricingStrategy,
);
// A10 (2026-04-09) — SNS Subscription (free — cost owned by topic + target)
defaultPricingRegistry.register(
  RESOURCE_TYPES.SNS_SUBSCRIPTION,
  snsSubscriptionPricingStrategy,
);
// A11 (2026-04-09) — KMS::Key (customer-managed keys, $1/key/month + reqs)
defaultPricingRegistry.register(RESOURCE_TYPES.KMS_KEY, kmsKeyPricingStrategy);
// A12 (2026-04-09) — Events::Connection (free)
defaultPricingRegistry.register(
  RESOURCE_TYPES.EVENTS_CONNECTION,
  eventsConnectionPricingStrategy,
);
// A13 (2026-04-09) — Events::ApiDestination ($0.20 per 1M invocations)
defaultPricingRegistry.register(
  RESOURCE_TYPES.EVENTS_API_DESTINATION,
  eventsApiDestinationPricingStrategy,
);
// A14 (2026-04-09) — CloudFront::Distribution (data transfer + HTTPS reqs)
defaultPricingRegistry.register(
  RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  cloudFrontDistributionPricingStrategy,
);
// (f) 2026-04-09 Task 4b — CloudFront::OriginAccessControl + S3::BucketPolicy
// (both free — cost lives on parent distribution and parent bucket)
defaultPricingRegistry.register(
  RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
  cloudFrontOacPricingStrategy,
);
defaultPricingRegistry.register(
  RESOURCE_TYPES.S3_BUCKET_POLICY,
  s3BucketPolicyPricingStrategy,
);
// 2026-04-13: RDS::DBSubnetGroup (free — cost on parent RDS instance)
defaultPricingRegistry.register(
  RESOURCE_TYPES.RDS_DB_SUBNET_GROUP,
  rdsDbSubnetGroupPricingStrategy,
);

export { PricingStrategyRegistry };
