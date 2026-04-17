/**
 * Destroy strategy registry — single entry point for all CLI
 * resource-type-specific destroy behavior. Delegates to the shared
 * `@assignee/core` registry + types and pulls concrete per-type
 * strategies from core's strategies sub-tree (Story 50-4).
 *
 * @see Wave-6 F1a — original scaffolding
 * @see Wave-6 F1b — complex strategies (preDestroy / destroy / postDestroy)
 * @see Story 49.1 — extraction of interface + registry + defaults to core
 * @see Story 50-4 — extraction of concrete strategy bodies to core
 */

export type {
  DestroyStrategy,
  DestroyContext,
  DestroyHookOutcome,
  DestroyResourceInput,
  AwsConfig,
} from "@assignee/core";
export { DestroyStrategyRegistry } from "@assignee/core";
export {
  warnDestroy,
  CCAPIStatus,
  CCAPI_NOT_FOUND_ERROR_CODE,
} from "@assignee/core";
export { pollDeleteStatus, classifyNotFoundShortCircuit } from "./helpers.js";

import {
  DestroyStrategyRegistry,
  arnIdentifierStrategies,
  slowDeleteStrategies,
  ec2EipStrategy,
  cloudfrontDistributionStrategy,
  dynamodbTableStrategy,
  s3BucketStrategy,
  ec2InternetGatewayStrategy,
  ec2RouteTableStrategy,
  efsFileSystemStrategy,
  elbv2LoadBalancerStrategy,
} from "@assignee/core";

/** Pre-built registry with every destroy strategy. */
export function createDestroyRegistry(): DestroyStrategyRegistry {
  const registry = new DestroyStrategyRegistry();
  registry.registerAll(arnIdentifierStrategies);
  registry.registerAll(slowDeleteStrategies);
  // Complex strategies (Wave-6 F1b; lifted to core by Story 50-4).
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
