/**
 * PricingDecomposerRegistry — maps resource types to their pricing decomposers.
 *
 * @see Story 23.1
 */

import type { PricingDecomposer, PricingLineItem } from "./decomposer-types.js";

export class PricingDecomposerRegistry {
  private readonly decomposers = new Map<string, PricingDecomposer>();

  register(decomposer: PricingDecomposer): void {
    this.decomposers.set(decomposer.resourceType, decomposer);
  }

  has(resourceType: string): boolean {
    return this.decomposers.has(resourceType);
  }

  decompose(
    resourceType: string,
    desiredState: Record<string, unknown>,
  ): PricingLineItem[] {
    const decomposer = this.decomposers.get(resourceType);
    if (!decomposer) return [];
    return decomposer.decompose(desiredState);
  }
}
