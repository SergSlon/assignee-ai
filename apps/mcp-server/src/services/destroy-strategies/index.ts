/**
 * Destroy strategy registry — single entry point for all MCP
 * resource-type-specific destroy behavior. Delegates to the shared
 * `@assignee/core` registry + types; registers MCP-specific
 * custom-logic strategies on top of the core flag-only defaults.
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools)
 * @see Story 49.1 — extraction of interface + registry + defaults to core
 */

export type { DestroyStrategy, DestroyContext } from "@assignee/core";
export { DestroyStrategyRegistry } from "@assignee/core";

import {
  DestroyStrategyRegistry,
  arnIdentifierStrategies,
  slowDeleteStrategies,
} from "@assignee/core";
import { igwStrategy } from "./igw-strategy.js";
import { routeTableStrategy } from "./route-table-strategy.js";
import { sqsStrategy } from "./sqs-strategy.js";
import { dynamodbStrategy } from "./dynamodb-strategy.js";

/** Pre-built registry with all known destroy strategies. */
export function createDestroyRegistry(): DestroyStrategyRegistry {
  const registry = new DestroyStrategyRegistry();

  // Bulk: ARN-identifier types and slow-delete types (shared with CLI).
  registry.registerAll(arnIdentifierStrategies);
  registry.registerAll(slowDeleteStrategies);

  // Custom-logic strategies.
  registry.register(igwStrategy);
  registry.register(routeTableStrategy);
  registry.register(sqsStrategy);
  registry.register(dynamodbStrategy);

  return registry;
}

/** Singleton registry instance for use by the destroy-resource tool. */
export const destroyRegistry = createDestroyRegistry();
