/**
 * Shared advisory-price label helper for cost-advisor hint modules.
 *
 * When the enriched price map contains the requested AdvisoryPriceId,
 * returns the enricher-provided "(live)" label. Otherwise synthesizes a
 * `(estimated)`-tagged fallback from the hand-coded constant + the same
 * formatter the enricher would use. This keeps every code path reading
 * a single shape without needing to know how enrichment works.
 */
import { formatLabelWithSource } from "@assignee/core";
import {
  type AdvisoryPriceId,
  type EnrichedPriceMap,
} from "../../../../pricing/advisory-prices.js";

export function enrichedLabel(
  enriched: EnrichedPriceMap | undefined,
  id: AdvisoryPriceId,
  fallbackValue: number,
  formatter: (v: number) => string,
): string {
  const hit = enriched?.get(id);
  if (hit) return hit.label;
  return formatLabelWithSource(formatter(fallbackValue), "fallback");
}
