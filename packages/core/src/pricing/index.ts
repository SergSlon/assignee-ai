import { PricingStrategyRegistry } from "./registry.js";
import { s3PricingStrategy } from "./strategies/s3.js";
import { ssmPricingStrategy } from "./strategies/ssm.js";
import { iamRolePricingStrategy } from "./strategies/iam-role.js";
import { ec2PricingStrategy } from "./strategies/ec2.js";
import { rdsPricingStrategy } from "./strategies/rds.js";
import { lambdaPricingStrategy } from "./strategies/lambda.js";

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

export { PricingStrategyRegistry };
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
