/** AWS Pricing API service codes and filter values used by preflight_guard. */

export const PricingServiceCode = {
  S3: "AmazonS3",
  SSM: "AWSSystemsManager",
  EC2: "AmazonEC2",
  RDS: "AmazonRDS",
  LAMBDA: "AWSLambda",
  // (f) 2026-04-09 Task 8: CloudWatch service code for the Logs
  // storage price lookup in the cost-optimizer analyzeLogsLogGroup
  // retention slice. The CloudWatch Logs storage rate bills under
  // the AmazonCloudWatch service (shared with alarm metric storage
  // and high-resolution alarm surcharges).
  CLOUDWATCH: "AmazonCloudWatch",
} as const;

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

export const PricingUnit = {
  GB_MONTH: "/GB-month",
  PARAM_HOUR: "/param-hour",
  HOUR: "/hour",
  MILLION_REQUESTS: "/million requests",
} as const;

export const PricingScale = {
  ONE: 1,
  MILLION: 1_000_000,
} as const;

/**
 * @deprecated Use AwsDefault from @assignee/core instead.
 * Re-exported for backward compatibility during migration.
 */
export { AwsDefault as PricingDefault } from "@assignee/core";

/**
 * @deprecated Use CostEstimateLabel from @assignee/core instead.
 * Re-exported for backward compatibility during migration.
 */
export { CostEstimateLabel as CostEstimate } from "@assignee/core";

/**
 * Lambda pricing rates — LOCAL FALLBACK ONLY (stable since 2014 — verified 2025).
 * Production code uses the Lambda PricingDecomposer (Story 23.3) which queries
 * Pricing MCP at runtime. These constants are retained only as offline fallback
 * for the legacy lambdaPricingStrategy.estimateLocal().
 *
 * @see Story 23.5 — zero hardcoded prices in display paths
 * @see https://aws.amazon.com/lambda/pricing/
 */
export const LambdaPricing = {
  /** USD per million invocation requests */
  USD_PER_MILLION_REQUESTS: 0.2,
  /** USD per GB-second of compute duration */
  USD_PER_GB_SECOND: 0.0000166667,
  /** Assumed average invocation duration in seconds (used for estimate display) */
  ASSUMED_AVG_DURATION_SEC: 0.1,
  /** Default memory when MemorySize not specified in desiredState */
  DEFAULT_MEMORY_MB: 128,
} as const;
