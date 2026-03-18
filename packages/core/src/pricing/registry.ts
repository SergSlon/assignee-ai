import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "./types.js";

/** Fallback for resource types with no registered strategy. */
const unknownPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "Pricing unavailable" };
  },
};

/**
 * Registry mapping CloudFormation resource types to their PricingStrategy implementations.
 * Adding a new resource type requires only:
 *   1. Create a strategy in `strategies/<resource>.ts`
 *   2. Register it in `index.ts` via `defaultPricingRegistry.register(type, strategy)`
 *   Zero changes to graph nodes or preflight-guard are required.
 */
export class PricingStrategyRegistry {
  private readonly strategies = new Map<string, PricingStrategy>();

  register(resourceType: string, strategy: PricingStrategy): void {
    this.strategies.set(resourceType, strategy);
  }

  private getStrategy(resourceType: string): PricingStrategy {
    return this.strategies.get(resourceType) ?? unknownPricingStrategy;
  }

  /**
   * Returns a local cost estimate for the resource type.
   * Used when MCP pricing is unavailable or as unit-testable baseline.
   */
  estimate(
    resourceType: string,
    desiredState: Record<string, unknown> | undefined,
  ): PricingEstimate {
    return this.getStrategy(resourceType).estimateLocal(desiredState);
  }

  /**
   * Returns MCP query config if the strategy supports live pricing, else null.
   * When non-null, the caller (preflight-guard) executes the MCP query and
   * calls `extractFirstTierPrice` on the response.
   */
  getMcpConfig(
    resourceType: string,
    desiredState: Record<string, unknown> | undefined,
  ): McpPricingConfig | null {
    const strategy = this.getStrategy(resourceType);
    return strategy.mcpConfig?.(desiredState) ?? null;
  }
}
