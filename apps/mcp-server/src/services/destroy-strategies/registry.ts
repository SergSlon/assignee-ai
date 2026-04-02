/**
 * Registry for destroy strategies keyed by CloudFormation resource type.
 *
 * Replaces hard-coded maps (ARN_IDENTIFIER_TYPES, SLOW_DELETE_TYPES) and
 * if/else chains for pre-destroy hooks with a single lookup mechanism.
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools)
 */

import type { DestroyStrategy } from "./types.js";

export class DestroyStrategyRegistry {
  private strategies = new Map<string, DestroyStrategy>();

  /** Register a strategy for a resource type. Overwrites if already registered. */
  register(strategy: DestroyStrategy): void {
    this.strategies.set(strategy.resourceType, strategy);
  }

  /** Bulk-register multiple strategies. */
  registerAll(strategies: DestroyStrategy[]): void {
    for (const s of strategies) {
      this.register(s);
    }
  }

  /** Get the strategy for a resource type, or undefined for types with no custom behavior. */
  get(resourceType: string): DestroyStrategy | undefined {
    return this.strategies.get(resourceType);
  }

  /** Check if a strategy is registered for a resource type. */
  has(resourceType: string): boolean {
    return this.strategies.has(resourceType);
  }
}
