import { PricingStrategyRegistry } from "./registry.js";
import { PricingDecomposerRegistry } from "./decomposer-registry.js";
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
import { ec2PricingDecomposer } from "./decomposers/ec2.js";
import { rdsPricingDecomposer } from "./decomposers/rds.js";
import { s3PricingDecomposer } from "./decomposers/s3.js";
import { lambdaPricingDecomposer } from "./decomposers/lambda.js";
import { dynamodbPricingDecomposer } from "./decomposers/dynamodb.js";

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
defaultPricingRegistry.register("AWS::S3::Bucket", s3PricingStrategy);
defaultPricingRegistry.register("AWS::SSM::Parameter", ssmPricingStrategy);
defaultPricingRegistry.register("AWS::IAM::Role", iamRolePricingStrategy);
defaultPricingRegistry.register("AWS::EC2::Instance", ec2PricingStrategy);
defaultPricingRegistry.register("AWS::RDS::DBInstance", rdsPricingStrategy);
defaultPricingRegistry.register("AWS::Lambda::Function", lambdaPricingStrategy);
defaultPricingRegistry.register(
  "AWS::EC2::SecurityGroup",
  securityGroupPricingStrategy,
);
defaultPricingRegistry.register(
  "AWS::DynamoDB::Table",
  dynamodbPricingStrategy,
);
defaultPricingRegistry.register("AWS::EC2::VPC", vpcPricingStrategy);
defaultPricingRegistry.register("AWS::EC2::Subnet", subnetPricingStrategy);
defaultPricingRegistry.register("AWS::SQS::Queue", sqsPricingStrategy);
defaultPricingRegistry.register("AWS::SNS::Topic", snsPricingStrategy);
defaultPricingRegistry.register("AWS::ECS::Cluster", ecsClusterPricingStrategy);
defaultPricingRegistry.register("AWS::ECR::Repository", ecrPricingStrategy);
defaultPricingRegistry.register(
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  elbv2PricingStrategy,
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
