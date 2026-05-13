/**
 * EventBridge Rule cost hints. The rule itself is free on the default
 * bus, but the workload fees (invoked target's invocation cost) scale
 * linearly with the schedule frequency — so surfacing the cadence
 * prompts the user to reality-check their rate/cron before shipping.
 */
import { AdviceIcon } from "../constants.js";
import {
  AdvisoryPriceId,
  EVENTBRIDGE_CUSTOM_PER_MILLION,
  type EnrichedPriceMap,
} from "@/pricing/advisory-prices.js";
import { enrichedLabel } from "./enriched-label.js";

/**
 * Calculates the approximate number of times a `rate(N unit)` schedule
 * fires per calendar month (30.44-day average). Returns 0 if the
 * expression is not a parseable `rate()` expression (e.g. cron).
 *
 * Single source of truth for the fire-count wording used in
 * cost-advisor hints and BP-EVR-XXX INFO lines.
 *
 * Examples:
 *   approxFirePerMonth("rate(5 minutes)")  → 8,767  (30.44 × 24 × 12)
 *   approxFirePerMonth("rate(1 hour)")     → 731    (30.44 × 24)
 *   approxFirePerMonth("rate(1 day)")      → 30     (30.44 / 1)
 *   approxFirePerMonth("cron(0 12 * * ? *)") → 0    (not a rate expression)
 */
export function approxFirePerMonth(scheduleExpression: string): number {
  const rateMatch = scheduleExpression.match(
    /^rate\(\s*(\d+)\s*(minute|hour|day)s?\s*\)$/,
  );
  if (!rateMatch) return 0;
  const n = Number(rateMatch[1]);
  const unit = rateMatch[2];
  if (unit === "minute") return Math.round((60 * 24 * 30.44) / n);
  if (unit === "hour") return Math.round((24 * 30.44) / n);
  if (unit === "day") return Math.round(30.44 / n);
  return 0;
}

export function eventsRuleCostHints(
  ds: Record<string, unknown>,
  hints: string[],
  enriched?: EnrichedPriceMap,
): void {
  const schedule = ds["ScheduleExpression"];
  const eventBusName = ds["EventBusName"];
  const bus =
    typeof eventBusName === "string" ? eventBusName.trim() : "default";

  // Default-bus rule: free rule evaluation + free AWS-service event
  // delivery. The workload fee comes from the target, not the rule.
  if (!bus || bus === "default") {
    hints.push(
      `${AdviceIcon.COST} EventBridge rule evaluation on the default bus is free — the cost you pay is the target's invocation cost (Lambda per-ms, SQS per-request, etc.) multiplied by the schedule frequency.`,
    );
  } else {
    const customBusLabel = enrichedLabel(
      enriched,
      AdvisoryPriceId.EVENTBRIDGE_CUSTOM_PER_MILLION,
      EVENTBRIDGE_CUSTOM_PER_MILLION,
      (v) => `$${v.toFixed(2)}`,
    );
    hints.push(
      `${AdviceIcon.COST} Custom event bus "${bus}" bills ${customBusLabel} per million events published (on top of target invocation fees). Confirm the volume estimate before shipping a high-throughput source.`,
    );
  }

  // Schedule reality-check: short rate() intervals rack up target
  // invocations fast. rate(1 minute) = 43,800/month; rate(10 seconds)
  // via cron = 262,800/month.
  if (typeof schedule === "string") {
    const perMonth = approxFirePerMonth(schedule);
    if (perMonth > 0) {
      hints.push(
        `${AdviceIcon.COST} ${schedule} fires approximately ${perMonth.toLocaleString("en-US")} times per month — budget the target invocation cost against this rate before shipping.`,
      );
    }
  }

  // DLQ reliability reminder — not a cost hint per se, but a
  // workload-cost reminder: failed async invocations retry 185 times
  // by default before dropping, which can amplify a buggy target
  // handler's cost. Tuning RetryPolicy + DeadLetterConfig on the
  // Target turns that into a bounded spend.
  hints.push(
    `${AdviceIcon.COST} Set DeadLetterConfig + RetryPolicy on each Target — the default 185 retries over 24h can turn a failing async handler into a runaway cost amplifier.`,
  );
}
