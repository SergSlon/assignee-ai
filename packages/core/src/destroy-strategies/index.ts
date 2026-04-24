/**
 * Barrel for the shared destroy-strategies module consumed by both
 * apps/cli and apps/mcp-server.
 *
 * @see Story 49.1 (Epic 49) — extraction from the duplicated per-app copies.
 */

export type {
  AwsConfig,
  DestroyStrategy,
  DestroyContext,
  DestroyHookOutcome,
  DestroyResourceInput,
} from "./types.js";
export { CCAPIStatus, CCAPI_NOT_FOUND_ERROR_CODE } from "./types.js";
export { DestroyStrategyRegistry } from "./registry.js";
export {
  arnIdentifierStrategies,
  slowDeleteStrategies,
} from "./default-strategies.js";
export { warnDestroy } from "./warn.js";
// Concrete per-resource-type strategies (Story 50-4).
export {
  dynamodbTableStrategy,
  ec2EipStrategy,
  ec2InternetGatewayStrategy,
  ec2RouteTableStrategy,
  efsFileSystemStrategy,
  elbv2LoadBalancerStrategy,
  lambdaFunctionStrategy,
  s3BucketStrategy,
  cloudfrontDistributionStrategy,
  sqsQueueStrategy,
} from "./strategies/index.js";
