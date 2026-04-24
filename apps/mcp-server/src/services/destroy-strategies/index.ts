/**
 * Destroy strategy registry — single entry point for all MCP
 * resource-type-specific destroy behavior. Delegates to the shared
 * `@assignee/core` registry + types; registers MCP-specific
 * custom-logic strategies on top of the core flag-only defaults.
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools)
 * @see Story 49.1 — extraction of interface + registry + defaults to core
 * @see Story 50-4 — extraction of concrete strategy bodies to core
 */

export type { DestroyStrategy, DestroyContext } from "@assignee/core";
export { DestroyStrategyRegistry } from "@assignee/core";

import {
  DestroyStrategyRegistry,
  arnIdentifierStrategies,
  slowDeleteStrategies,
  ec2InternetGatewayStrategy,
  ec2RouteTableStrategy,
  lambdaFunctionStrategy,
  sqsQueueStrategy,
  dynamodbTableStrategy,
} from "@assignee/core";

/** Pre-built registry with all known destroy strategies. */
export function createDestroyRegistry(): DestroyStrategyRegistry {
  const registry = new DestroyStrategyRegistry();

  // Bulk: ARN-identifier types and slow-delete types (shared with CLI).
  registry.registerAll(arnIdentifierStrategies);
  registry.registerAll(slowDeleteStrategies);

  // Custom-logic strategies — now sourced from @assignee/core (Story 50-4).
  registry.register(ec2InternetGatewayStrategy);
  registry.register(ec2RouteTableStrategy);
  registry.register(lambdaFunctionStrategy);
  registry.register(sqsQueueStrategy);
  registry.register(dynamodbTableStrategy);

  return registry;
}

/** Singleton registry instance for use by the destroy-resource tool. */
export const destroyRegistry = createDestroyRegistry();
