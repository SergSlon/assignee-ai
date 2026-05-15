/**
 * AWS Pricing API filter values + terms + units used by the pricing-lookup
 * tree (EC2/RDS/Lambda/CW-Logs helpers consumed by the preflight-guard + plan
 * nodes).
 *
 * NOTE: `PricingServiceCode` is NOT defined here — it is already owned by
 * `packages/core/src/pricing/filter-constants.ts` with a superset of entries
 * (including DynamoDB/SQS/SNS/ELB/etc). Callers from the pricing-lookup
 * tree import it directly from `@assignee/core` via the existing barrel.
 *
 * Lifted into @assignee/core in Story 50-4 Wave 5 Pass C-2 so the
 * pricing-lookup tree can live inside @assignee/core.
 */

export const PricingFilter = {
  Field: {
    PRODUCT_FAMILY: "productFamily",
    USAGE_TYPE: "usagetype",
    INSTANCE_TYPE: "instanceType",
    OPERATING_SYSTEM: "operatingSystem",
    TENANCY: "tenancy",
    CAPACITY_STATUS: "capacitystatus",
    PRE_INSTALLED_SW: "preInstalledSw",
    DATABASE_ENGINE: "databaseEngine",
    DEPLOYMENT_OPTION: "deploymentOption",
    GROUP: "group",
  },
  Value: {
    S3_STORAGE: "Storage",
    S3_USAGE_TYPE: "TimedStorage-ByteHrs",
    SSM_PRODUCT_FAMILY: "AWS Systems Manager",
    EC2_PRODUCT_FAMILY: "Compute Instance",
    EC2_OS_LINUX: "Linux",
    EC2_TENANCY_SHARED: "Shared",
    EC2_CAPACITY_USED: "Used",
    EC2_NO_PREINSTALL: "NA",
    RDS_PRODUCT_FAMILY: "Database Instance",
    RDS_SINGLE_AZ: "Single-AZ",
    LAMBDA_PRODUCT_FAMILY: "Serverless",
    LAMBDA_REQUESTS_GROUP: "AWS-Lambda-Requests",
    // (f) 2026-04-09 Task 8: CloudWatch Logs pricing filter values
    // used by the cost-optimizer analyzeLogsLogGroup retention check.
    // The LogGroup storage line bills under productFamily=Storage
    // Snapshot (mirrors what logsPricingDecomposer uses) — the
    // usagetype differentiates Standard vs Infrequent Access
    // classes. StorageByteHrs is a usagetype suffix; the prefix is
    // "CW:DataStorage-Bytes" for Standard and
    // "CW:LogInfrequentAccess-DataStorage-Bytes" for IA.
    CLOUDWATCH_STORAGE_SNAPSHOT: "Storage Snapshot",
    CW_LOG_STORAGE_STANDARD_USAGE_TYPE: "CW:DataStorage-Bytes",
  },
} as const;

export const PricingTerm = {
  ON_DEMAND: "OnDemand",
} as const;

export const PricingScale = {
  ONE: 1,
  MILLION: 1_000_000,
} as const;

/**
 * Lambda wizard defaults — NOT pricing rates.
 *
 * Story 46.7 (2026-04-12): this module previously exported duplicate Lambda
 * pricing-rate constants (USD_PER_MILLION_REQUESTS, USD_PER_GB_SECOND,
 * ASSUMED_AVG_DURATION_SEC) that NO display path read. The live fallback
 * rates consumed by `lambdaPricingStrategy.estimateLocal()` live in
 * `packages/core/src/pricing/strategies/lambda.ts`, and that strategy
 * already tags its output with `source: "fallback"` — the DataSource
 * attribution requested by Story 46.7 is therefore already wired where it
 * matters. The duplicate constants here were dead weight that drifted
 * from the real ones, so they are removed rather than tagged.
 *
 * Only `DEFAULT_MEMORY_MB` is retained — it is consumed by the
 * preflight-guard test suite as the canonical "no memory specified →
 * default to 128MB" assumption that drives the cost-estimate preview
 * when the user's intent does not set MemorySize.
 *
 * @see packages/core/src/pricing/strategies/lambda.ts — real fallback rates
 * @see Story 46.7 — ghost constant cleanup
 */
export const LambdaPricing = {
  /** Default memory when MemorySize not specified in desiredState */
  DEFAULT_MEMORY_MB: 128,
} as const;
