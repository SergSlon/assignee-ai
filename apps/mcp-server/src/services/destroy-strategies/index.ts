/**
 * Destroy strategy registry — single entry point for all resource-type-specific
 * destroy behavior. Replaces hard-coded maps and if/else chains in destroy-resource.ts.
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools)
 */

export type { DestroyStrategy } from "./types.js";
export { DestroyStrategyRegistry } from "./registry.js";

import { DestroyStrategyRegistry } from "./registry.js";
import { igwStrategy } from "./igw-strategy.js";
import { sqsStrategy } from "./sqs-strategy.js";
import { dynamodbStrategy } from "./dynamodb-strategy.js";
import {
  arnIdentifierStrategies,
  slowDeleteStrategies,
} from "./default-strategies.js";

/** Pre-built registry with all known destroy strategies. */
export function createDestroyRegistry(): DestroyStrategyRegistry {
  const registry = new DestroyStrategyRegistry();

  // Custom logic strategies
  registry.register(igwStrategy);
  registry.register(sqsStrategy);
  registry.register(dynamodbStrategy);

  // Bulk: ARN-identifier types and slow-delete types
  registry.registerAll(arnIdentifierStrategies);
  registry.registerAll(slowDeleteStrategies);

  return registry;
}

/** Singleton registry instance for use by destroy-resource tool. */
export const destroyRegistry = createDestroyRegistry();
