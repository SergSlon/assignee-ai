/**
 * Story 108-B-03 — CostBlock type definition.
 *
 * Lives in a dedicated module to avoid the circular-import chain that would
 * arise if display-plan.ts imported from formatters/plan.ts:
 *
 *   display-plan.ts → formatters/plan.ts → utils/display.js → display-plan.ts
 *
 * Both display-plan.ts and formatters/plan.ts import from here.
 */

/**
 * Structured cost summary block for a plan invocation.
 * Primary source for `infraCostMonthly` is `pricingBreakdown.fixedSubtotal`
 * (numeric, accumulator-merged across compound iterations) — NOT the
 * `estimatedMonthlyCost` string label, which can be `"Free"` or unparseable
 * on compound plans (B-02 review advisory F1 + F2).
 */
export interface CostBlock {
  /**
   * Accumulated fixed infra cost in USD/month. Derived from
   * `pricingBreakdown.fixedSubtotal` when available; falls back to
   * parsing `estimatedMonthlyCost` string; `null` when unavailable.
   */
  infraCostMonthly: number | null;
  /** Total Bedrock tokens consumed to generate the plan. */
  bedrockTokens: number;
  /** Free-tier note text, or null when no free-tier applies. */
  freeTierNote: string | null;
  /** Whether the cost estimate is unavailable (no decomposer registered). */
  unavailable: boolean;
  /**
   * Per-resource breakdown entries. Populated when `costDetail: true`.
   * Each entry: resource type → formatted cost string.
   */
  perResourceBreakdown?: Array<{ resourceType: string; cost: string }>;
}
