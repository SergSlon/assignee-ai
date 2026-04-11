import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CostEstimateLabel } from "../filter-constants.js";

/**
 * Pricing strategy for AWS::Events::Rule.
 *
 * EventBridge rule pricing breakdown:
 *   - Rule evaluation: FREE (AWS does not charge for evaluating rules)
 *   - Target invocation from the DEFAULT bus: FREE for AWS service events
 *   - Custom bus events: $1.00 per million events published to the bus
 *     (this is a BUS cost, not a RULE cost — we treat as informational)
 *   - Cross-account/archived events: additional per-million fees
 *
 * The overwhelming common case — a scheduled Lambda or a simple
 * event-pattern filter on the default bus — bills $0 for the rule
 * itself. Workload fees (Lambda invocation, SQS delivery, etc.) come
 * from the respective target resources and are counted there.
 *
 * Custom event buses are handled by returning the canonical
 * "depends on usage" label because the per-month cost depends on the
 * publishing rate, not on any property of the rule itself.
 */
export const eventsRulePricingStrategy: PricingStrategy = {
  estimateLocal(desiredState?: Record<string, unknown>): PricingEstimate {
    const eventBusName = desiredState?.["EventBusName"];
    const bus =
      typeof eventBusName === "string" ? eventBusName.trim() : "default";

    // Default bus — AWS service events are always free; custom events
    // published to the default bus also bill $0 because there is no
    // default-bus charge. The user's spend comes entirely from the
    // downstream target workload.
    if (!bus || bus === "default") {
      return {
        perMonth: 0,
        label: CostEstimateLabel.FREE,
        isFree: true,
        source: "free",
      };
    }

    // Custom event bus — billing depends on publish volume.
    // We intentionally do NOT call Pricing MCP here because the per-
    // month cost is a function of runtime publish rate, which is not
    // knowable at plan time.
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
};
