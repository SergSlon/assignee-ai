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
} from "../../../../pricing/advisory-prices.js";
import { enrichedLabel } from "./enriched-label.js";

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
    const rateMatch = schedule.match(
      /^rate\(\s*(\d+)\s*(minute|hour|day)s?\s*\)$/,
    );
    if (rateMatch) {
      const n = Number(rateMatch[1]);
      const unit = rateMatch[2];
      let perMonth = 0;
      if (unit === "minute") perMonth = Math.round((60 * 24 * 30.44) / n);
      else if (unit === "hour") perMonth = Math.round((24 * 30.44) / n);
      else if (unit === "day") perMonth = Math.round(30.44 / n);
      if (perMonth > 0) {
        hints.push(
          `${AdviceIcon.COST} ${schedule} fires approximately ${perMonth.toLocaleString("en-US")} times per month — budget the target invocation cost against this rate before shipping.`,
        );
      }
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
