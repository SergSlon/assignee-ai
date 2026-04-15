/**
 * CloudFront Distribution cost hints. The decomposer emits data-transfer-out
 * + HTTPS requests as the two always-on usage-based lines; the invalidation
 * trap is the non-obvious one that bites teams who do per-deploy wildcard
 * invalidations. We always surface it because the trap is behavior-driven,
 * not config-driven — knowable only at deploy time.
 *
 * @see A14 (2026-04-09) — CloudFront::Distribution first-class
 * @see (f) 2026-04-09 — wired from decomposer reminder list
 */
import { AdviceIcon } from "../constants.js";
import {
  AdvisoryPriceId,
  CF_INVALIDATION_EACH,
  CF_INVALIDATION_FREE_TIER,
  type EnrichedPriceMap,
} from "../../../constants/advisory-prices.js";
import { enrichedLabel } from "./enriched-label.js";

export function cloudFrontCostHints(
  hints: string[],
  enriched?: EnrichedPriceMap,
): void {
  const invalidationLabel = enrichedLabel(
    enriched,
    AdvisoryPriceId.CF_INVALIDATION_EACH,
    CF_INVALIDATION_EACH,
    (v) => `$${v.toFixed(3)}`,
  );
  hints.push(
    `${AdviceIcon.COST} First ${CF_INVALIDATION_FREE_TIER.toLocaleString("en-US")} invalidation paths/month are free; ${invalidationLabel} each after that. Aggressive per-deploy invalidations can turn into real cost \u2014 prefer cache-busting filenames.`,
  );
}
