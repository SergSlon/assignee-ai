import { PricingStrategyRegistry } from "./registry.js";
import { PricingDecomposerRegistry } from "./decomposer-registry.js";
import { RESOURCE_TYPES } from "../config/resource-types.js";
import { s3PricingStrategy } from "./strategies/s3.js";
import { ssmPricingStrategy } from "./strategies/ssm.js";
import { iamRolePricingStrategy } from "./strategies/iam-role.js";
import { ec2PricingStrategy } from "./strategies/ec2.js";
import { rdsPricingStrategy } from "./strategies/rds.js";
import { lambdaPricingStrategy } from "./strategies/lambda.js";
import { securityGroupPricingStrategy } from "./strategies/security-group.js";
import { dynamodbPricingStrategy } from "./strategies/dynamodb.js";
import { vpcPricingStrategy } from "./strategies/vpc.js";
import { subnetPricingStrategy } from "./strategies/subnet.js";
import { sqsPricingStrategy } from "./strategies/sqs.js";
import { snsPricingStrategy } from "./strategies/sns.js";
import { ecsClusterPricingStrategy } from "./strategies/ecs-cluster.js";
import { ecrPricingStrategy } from "./strategies/ecr.js";
import { elbv2PricingStrategy } from "./strategies/elbv2.js";
// Sprint F: Tier 1 pricing strategies (Epic 25)
import { logsPricingStrategy } from "./strategies/logs.js";
import { internetGatewayPricingStrategy } from "./strategies/internet-gateway.js";
import { routeTablePricingStrategy } from "./strategies/route-table.js";
import { routePricingStrategy } from "./strategies/route.js";
import { natGatewayPricingStrategy } from "./strategies/nat-gateway.js";
// Sprint G: Tier 2 pricing strategies (Epic 26)
import { apiGatewayV2PricingStrategy } from "./strategies/apigatewayv2.js";
import { cloudWatchAlarmPricingStrategy } from "./strategies/cloudwatch-alarm.js";
import { secretsManagerPricingStrategy } from "./strategies/secretsmanager.js";
// WV4-A: VPC compound cross-reference free-tier strategies
import { vpcGatewayAttachmentPricingStrategy } from "./strategies/vpc-gateway-attachment.js";
import { subnetRouteTableAssociationPricingStrategy } from "./strategies/subnet-route-table-association.js";
// A1 (2026-04-08) — EFS
import { efsPricingStrategy } from "./strategies/efs.js";
import { efsMountTargetPricingStrategy } from "./strategies/efs-mount-target.js";
import { ec2PricingDecomposer } from "./decomposers/ec2.js";
import { rdsPricingDecomposer } from "./decomposers/rds.js";
import { s3PricingDecomposer } from "./decomposers/s3.js";
import { lambdaPricingDecomposer } from "./decomposers/lambda.js";
import { dynamodbPricingDecomposer } from "./decomposers/dynamodb.js";
// Epic 39: Pricing decomposers for all resource types
import { natGatewayPricingDecomposer } from "./decomposers/nat-gateway.js";
import { elbv2PricingDecomposer } from "./decomposers/elbv2.js";
import { apigatewayV2PricingDecomposer } from "./decomposers/apigatewayv2.js";
import { sqsPricingDecomposer } from "./decomposers/sqs.js";
import { snsPricingDecomposer } from "./decomposers/sns.js";
import { secretsManagerPricingDecomposer } from "./decomposers/secretsmanager.js";
import { cloudWatchAlarmPricingDecomposer } from "./decomposers/cloudwatch-alarm.js";
import { logsPricingDecomposer } from "./decomposers/logs.js";
import { ecrPricingDecomposer } from "./decomposers/ecr.js";
import { ssmPricingDecomposer } from "./decomposers/ssm.js";
// A1 (2026-04-08) — EFS
import { efsPricingDecomposer } from "./decomposers/efs.js";
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
} from "./decomposers/free.js";

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

export { PricingStrategyRegistry };
export { PricingDecomposerRegistry } from "./decomposer-registry.js";
export { extractFirstTierPrice } from "./mcp-parser.js";
export type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
  McpPricingFilter,
  AwsPricingResponse,
  AwsPricingItem,
  AwsPricingTerm,
  AwsPriceDimension,
} from "./types.js";
export type {
  PricingDecomposer,
  PricingLineItem,
  PricingLineItemKind,
  PricingLineItemResult,
  PricingBreakdown,
} from "./decomposer-types.js";
export {
  PricingMatchType,
  PricingField,
  PricingKind,
  PricingServiceCode,
  PricingProductFamily,
  CostEstimateLabel,
  FREE_TIER_MESSAGE,
} from "./filter-constants.js";
export { PriceUnit } from "./price-units.js";
export { PricingUnit } from "./units.js";
export { LineItemLabel, DecomposerDescription } from "./line-item-labels.js";
export { PricingFilterValue } from "./pricing-filter-values.js";
