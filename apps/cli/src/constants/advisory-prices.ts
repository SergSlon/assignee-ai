/**
 * Advisory price constants — thin re-export shim.
 *
 * Canonical implementation lives in `@assignee/core` (lifted in Story
 * 50-4 Wave 5 Pass G so the in-core advisory-price-enricher can
 * reference these constants without reaching back into the CLI app).
 */
export {
  NAT_GATEWAY_MONTHLY_APPROX,
  ALB_MONTHLY_APPROX,
  EFS_PROVISIONED_PER_MIBS_MONTH,
  CW_ALARM_PER_MONTH,
  CW_LOGS_INGESTION_PER_GB,
  CF_INVALIDATION_EACH,
  CF_INVALIDATION_FREE_TIER,
  EVENTBRIDGE_CUSTOM_PER_MILLION,
  ARM_GRAVITON_SAVINGS_PCT,
  EFS_ONE_ZONE_SAVINGS_PCT,
  S3_INTELLIGENT_TIERING_SAVINGS_PCT,
  CW_HIGH_RES_ALARM_MULTIPLIER,
  SPOT_SAVINGS_UP_TO_PCT,
  DYNAMODB_PROVISIONED_SAVINGS_PCT,
  SQS_FIFO_SURCHARGE_PCT,
  EFS_LIFECYCLE_SAVINGS_PCT,
  AdvisoryPriceId,
  type EnrichedPrice,
  type EnrichedPriceMap,
} from "@assignee/core";
