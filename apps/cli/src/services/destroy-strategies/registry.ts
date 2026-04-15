/**
 * Registry for CLI destroy strategies keyed by CloudFormation resource
 * type. Replaces the hard-coded `ARN_IDENTIFIED_TYPES` Set (and, in
 * F1b, the inline if/else pre-delete hook chain) in `destroy-service.ts`
 * with a single lookup point.
 *
 * @see Wave-6 F1a
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

  /**
   * Get the strategy for a resource type, or `undefined` for types
   * with no registered behavior (the dispatcher falls back to the
   * generic inline path).
   */
  get(resourceType: string): DestroyStrategy | undefined {
    return this.strategies.get(resourceType);
  }

  /** Check if a strategy is registered for a resource type. */
  has(resourceType: string): boolean {
    return this.strategies.has(resourceType);
  }

  /** Iterate the registered resource types (useful for tests + audits). */
  registeredTypes(): string[] {
    return Array.from(this.strategies.keys());
  }
}
