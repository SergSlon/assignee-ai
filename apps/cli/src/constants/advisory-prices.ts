/**
 * Advisory price constants — fallback values for cost advisor hints.
 *
 * Architecture (Epic 46):
 *   - Cost CALCULATIONS use Pricing MCP at runtime (zero hardcoded amounts)
 *   - Cost ADVISORY HINTS use these constants as fallbacks, enriched with
 *     live MCP data when available (Story 46.3). Displayed with "~" prefix
 *     and "(estimated)" suffix when not MCP-enriched.
 *   - This is the SINGLE SOURCE OF TRUTH for advisory fallback values.
 *     Update here when AWS changes fixed-rate pricing — all hints update.
 *
 * These constants exist because advisory hints run in a synchronous code
 * path (cost-advisor.ts) that cannot make async MCP calls today. Story 46.3
 * will make the advisory path async and enrich these with live prices.
 *
 * @see Story 46.1 — Extract price constants from template literals
 * @see Story 46.3 — Runtime enrichment with live MCP data
 * @see docs/mcp-intelligence-audit.md §3.1 — Hardcoded price inventory
 */

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
