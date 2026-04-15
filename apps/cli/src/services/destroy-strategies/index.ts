/**
 * Destroy strategy registry — single entry point for all CLI
 * resource-type-specific destroy behavior. Replaces the hard-coded
 * per-type branches and `ARN_IDENTIFIED_TYPES` Set previously in
 * `destroy-service.ts`.
 *
 * @see Wave-6 F1a — scaffolding + flag-only strategies
 * @see Wave-6 F1b — complex strategies (preDestroy / destroy / postDestroy)
 */

export type {
  DestroyStrategy,
  DestroyContext,
  DestroyHookOutcome,
  DestroyResourceInput,
} from "./types.js";
export { DestroyStrategyRegistry } from "./registry.js";
export {
  warnDestroy,
  pollDeleteStatus,
  classifyNotFoundShortCircuit,
  CCAPIStatus,
  CCAPI_NOT_FOUND_ERROR_CODE,
} from "./helpers.js";

import { DestroyStrategyRegistry } from "./registry.js";
import {
  arnIdentifierStrategies,
  slowDeleteStrategies,
} from "./default-strategies.js";
import { ec2EipStrategy } from "./ec2-eip.js";
import { cloudfrontDistributionStrategy } from "./cloudfront-distribution.js";
import { dynamodbTableStrategy } from "./dynamodb-table.js";
import { s3BucketStrategy } from "./s3-bucket.js";
import { ec2InternetGatewayStrategy } from "./ec2-internetgateway.js";
import { ec2RouteTableStrategy } from "./ec2-routetable.js";
import { efsFileSystemStrategy } from "./efs-filesystem.js";
import { elbv2LoadBalancerStrategy } from "./elbv2-loadbalancer.js";

/** Pre-built registry with every destroy strategy. */
export function createDestroyRegistry(): DestroyStrategyRegistry {
  const registry = new DestroyStrategyRegistry();
  registry.registerAll(arnIdentifierStrategies);
  registry.registerAll(slowDeleteStrategies);
  // Complex strategies (Wave-6 F1b).
  registry.registerAll([
    ec2EipStrategy,
    cloudfrontDistributionStrategy,
    dynamodbTableStrategy,
    s3BucketStrategy,
    ec2InternetGatewayStrategy,
    ec2RouteTableStrategy,
    efsFileSystemStrategy,
    elbv2LoadBalancerStrategy,
  ]);
  return registry;
}

/** Singleton registry instance for the CLI destroy-service dispatcher. */
export const destroyRegistry = createDestroyRegistry();
