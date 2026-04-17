/**
 * Advisory price constants — fallback values for cost advisor hints.
 *
 * Architecture (Epic 46):
 *   - Cost CALCULATIONS use Pricing MCP at runtime (zero hardcoded amounts)
 *   - Cost ADVISORY HINTS use these constants as fallbacks, enriched with
 *     live MCP data via {@link AdvisoryPriceId} +
 *     `services/advisory-price-enricher.ts` (Story 46.3). When live data
 *     is available the hint shows "$X.XX/mo (live)"; otherwise the hint
 *     falls back to the constant tagged "(estimated)".
 *   - This is the SINGLE SOURCE OF TRUTH for advisory fallback values.
 *     Update here when AWS changes fixed-rate pricing — every hint that
 *     references the constant via the enrichment registry updates.
 *
 * Story 46.1 extracted the magic numbers; Story 46.2 added the
 * `DataSource` provenance tag; Story 46.3 wires the two together via the
 * enricher so each hint can render "(live)" or "(estimated)" honestly.
 *
 * Lifted from apps/cli/src/constants/advisory-prices.ts in Story 50-4
 * Wave 5 Pass G so the in-core advisory-price-enricher can reference
 * them without reaching back into the CLI app.
 *
 * @see Story 46.1 — Extract price constants from template literals
 * @see Story 46.2 — DataSource provenance tagging
 * @see Story 46.3 — Runtime enrichment with live MCP data
 * @see docs/mcp-intelligence-audit.md §3.1 — Hardcoded price inventory
 */

import type { DataSource } from "./types.js";

// ── Fixed monthly costs ─────────────────────────────────────────────────────

/** NAT Gateway approximate monthly fixed cost ($0.045/hr × 730h ≈ $32.85, rounded). */
export const NAT_GATEWAY_MONTHLY_APPROX = 32;

/** ALB approximate monthly fixed cost ($0.0225/hr × 730h ≈ $16.43, rounded). */
export const ALB_MONTHLY_APPROX = 16;

/** EFS provisioned throughput per MiB/s per month. */
export const EFS_PROVISIONED_PER_MIBS_MONTH = 6;

// ── Per-unit costs ──────────────────────────────────────────────────────────

/** CloudWatch standard alarm cost per month. */
export const CW_ALARM_PER_MONTH = 0.1;

/** CloudWatch Logs ingestion per GB. */
export const CW_LOGS_INGESTION_PER_GB = 0.5;

/** CloudFront invalidation cost per path (after first 1,000 free). */
export const CF_INVALIDATION_EACH = 0.005;

/** CloudFront free invalidation paths per month. */
export const CF_INVALIDATION_FREE_TIER = 1000;

/** EventBridge custom bus cost per million events published. */
export const EVENTBRIDGE_CUSTOM_PER_MILLION = 1.0;

// ── Percentage-based savings (no dollar amounts) ────────────────────────────

/** ARM/Graviton savings vs x86 equivalent. */
export const ARM_GRAVITON_SAVINGS_PCT = 20;

/** EFS One Zone savings vs Regional. */
export const EFS_ONE_ZONE_SAVINGS_PCT = 47;

/** S3 Intelligent-Tiering savings vs Standard. */
export const S3_INTELLIGENT_TIERING_SAVINGS_PCT = 45;

/** CW high-resolution alarm cost multiplier vs standard. */
export const CW_HIGH_RES_ALARM_MULTIPLIER = 3;

/** Spot Instance savings vs on-demand (up to). */
export const SPOT_SAVINGS_UP_TO_PCT = 90;

/** DynamoDB provisioned capacity savings vs on-demand for steady workloads. */
export const DYNAMODB_PROVISIONED_SAVINGS_PCT = 70;

/** SQS FIFO queue surcharge vs standard. */
export const SQS_FIFO_SURCHARGE_PCT = 25;

/** EFS Lifecycle Management savings for cold data. */
export const EFS_LIFECYCLE_SAVINGS_PCT = 80;

// ── Story 46.3: enrichment registry (live MCP → fallback constant) ─────────

/**
 * Stable identifiers for every advisory price that can be enriched with
 * live AWS Pricing API data. The enricher service
 * (`services/advisory-price-enricher.ts`) keys its query registry by
 * these IDs, and `cost-advisor.ts` reads `enriched.get(id).label` to
 * format hints. Adding a new enrichable price means: (1) add an enum
 * entry here, (2) add a query spec in the enricher, (3) reference the
 * enum in the relevant hint string. The TypeScript compiler enforces
 * step #2 because the enricher's query record is keyed by this enum.
 *
 * Percentage / ratio constants (ARM_GRAVITON_SAVINGS_PCT, etc.) are
 * intentionally absent — they're behavioral, not directly fetchable
 * from the AWS Pricing API.
 *
 * @see Story 46.3
 */
export enum AdvisoryPriceId {
  NAT_GATEWAY_MONTHLY = "nat-gateway-monthly",
  ALB_MONTHLY = "alb-monthly",
  EFS_PROVISIONED_PER_MIBS_MONTH = "efs-provisioned-per-mibs-month",
  CW_ALARM_PER_MONTH = "cw-alarm-per-month",
  CW_LOGS_INGESTION_PER_GB = "cw-logs-ingestion-per-gb",
  CF_INVALIDATION_EACH = "cf-invalidation-each",
  EVENTBRIDGE_CUSTOM_PER_MILLION = "eventbridge-custom-per-million",
}

/**
 * Per-price enrichment outcome. The `label` is the formatted display
 * string that already carries the source-provenance suffix from
 * `formatLabelWithSource` — `cost-advisor.ts` interpolates `.label`
 * directly into hint strings.
 */
export interface EnrichedPrice {
  /** Numeric rate (e.g. 32.85 for $32.85/mo). */
  value: number;
  /** Pre-formatted display label, e.g. `"~$32.85/mo (live)"`. */
  label: string;
  /** Provenance tag — `"mcp"` when live, `"fallback"` when constant. */
  source: DataSource;
}

/** Map type returned by the enricher. */
export type EnrichedPriceMap = Map<AdvisoryPriceId, EnrichedPrice>;
