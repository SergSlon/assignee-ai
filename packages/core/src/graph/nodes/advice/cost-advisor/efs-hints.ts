/**
 * EFS::FileSystem cost hints. Ordered from most to least impactful — the
 * plugin surfaces at most 5 lines in the inline advice box so the first
 * hint should be the one most likely to save money on the user's workload.
 */
import { CfnKey } from "@/index.js";
import { AdviceIcon } from "../constants.js";
import {
  AdvisoryPriceId,
  EFS_PROVISIONED_PER_MIBS_MONTH,
  EFS_ONE_ZONE_SAVINGS_PCT,
  EFS_LIFECYCLE_SAVINGS_PCT,
  type EnrichedPriceMap,
} from "@/pricing/advisory-prices.js";
import { enrichedLabel } from "./enriched-label.js";

export function efsCostHints(
  ds: Record<string, unknown>,
  hints: string[],
  enriched?: EnrichedPriceMap,
): void {
  const throughputMode = ds[CfnKey.THROUGHPUT_MODE] as string | undefined;
  const provisionedMiBps = ds[CfnKey.PROVISIONED_THROUGHPUT_IN_MIBPS] as
    | number
    | string
    | undefined;
  const azName = ds[CfnKey.AVAILABILITY_ZONE_NAME];

  // Provisioned throughput — expensive and often unnecessary. Wording
  // mirrors the decomposer's FIXED provisioned-throughput line so the
  // plan box and the advisor tell the same story: ~$6/MiB-s-month
  // baseline, bills regardless of utilization, crossover with
  // bursting/elastic sits around ~50 MiB/s for typical workloads.
  if (throughputMode === "provisioned") {
    const provisionedNum =
      typeof provisionedMiBps === "number"
        ? provisionedMiBps
        : typeof provisionedMiBps === "string"
          ? Number(provisionedMiBps)
          : undefined;
    const prefix =
      provisionedNum && provisionedNum > 0
        ? `ThroughputMode=provisioned with ${provisionedNum} MiB/s`
        : `ThroughputMode=provisioned`;
    const efsLabel = enrichedLabel(
      enriched,
      AdvisoryPriceId.EFS_PROVISIONED_PER_MIBS_MONTH,
      EFS_PROVISIONED_PER_MIBS_MONTH,
      (v) => `$${v.toFixed(0)}/MiB-s-month`,
    );
    hints.push(
      `${AdviceIcon.COST} ${prefix} \u2014 ${efsLabel} baseline; the committed rate bills regardless of usage. Switch back to bursting / elastic if steady-state throughput is below ~50 MiB/s.`,
    );
  }

  // One Zone mode — dramatically cheaper for non-critical data.
  if (typeof azName === "string" && azName.length > 0) {
    hints.push(
      `${AdviceIcon.COST} One Zone EFS (AvailabilityZoneName=${azName}) is ~${EFS_ONE_ZONE_SAVINGS_PCT}% cheaper per GB-month than Regional, but has zero multi-AZ redundancy — only use for reproducible or easily-recoverable data.`,
    );
  } else {
    hints.push(
      `${AdviceIcon.COST} Regional EFS (default) stores data across 3 AZs. For non-critical workloads, consider One Zone (AvailabilityZoneName) to save ~${EFS_ONE_ZONE_SAVINGS_PCT}% per GB-month.`,
    );
  }

  // Lifecycle tiering — big lever for cold data.
  hints.push(
    `${AdviceIcon.COST} Enable EFS Lifecycle Management (IA after 30d, Archive after 90d) to move cold data to cheaper tiers automatically — can cut storage bill by ${EFS_LIFECYCLE_SAVINGS_PCT}%+ for write-once-read-rarely workloads.`,
  );
}
