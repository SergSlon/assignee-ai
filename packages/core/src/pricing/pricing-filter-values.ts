/**
 * Named constants for AWS Pricing API filter values used in decomposers
 * and strategies. These are the Value fields passed to TERM_MATCH filters.
 * Zero magic strings policy — every filter value literal must reference this map.
 */

export const PricingFilterValue = {
  // Location types (data transfer)
  AWS_REGION: "AWS Region",
  /** toLocationType value for internet-outbound data transfer in AWS Pricing API. */
  TO_LOCATION_OTHER: "Other",

  // Transfer types
  AWS_OUTBOUND: "AWS Outbound",

  // EC2 / VPC group values
  ELASTIC_IP_ADDRESS: "ElasticIP:Address",

  // DynamoDB group values
  DDB_READ_UNITS: "DDB-ReadUnits",
  DDB_WRITE_UNITS: "DDB-WriteUnits",

  // S3 group values — these are stable cross-region; usagetype is region-prefixed
  // (e.g. "USE1-Requests-Tier1" in us-east-1) and must NOT be used as a filter.
  // The `group` attribute is consistently "S3-API-Tier1" / "S3-API-Tier2" across
  // all regions and is the correct discriminator for PUT vs GET requests.
  S3_API_TIER1: "S3-API-Tier1",
  S3_API_TIER2: "S3-API-Tier2",

  // S3 / DynamoDB usage types
  TIMED_STORAGE_BYTE_HRS: "TimedStorage-ByteHrs",
  REQUESTS_TIER1: "Requests-Tier1",
  REQUESTS_TIER2: "Requests-Tier2",
  // (f) 2026-04-09: S3 Intelligent-Tiering Frequent Access usage type.
  // The Pricing API publishes IT under a separate usagetype family —
  // this matches the Frequent Access tier (the default landing tier
  // for new objects). Other tiers (Infrequent Access, Archive
  // Instant, Archive, Deep Archive) have their own usage types and
  // are surfaced as awareness-only via the cost-advisor when the IT
  // configuration declares lifecycle transitions to them.
  TIMED_STORAGE_INT_BYTE_HRS_FREQ: "TimedStorage-INT-FA-ByteHrs",

  // RDS deployment options
  MULTI_AZ: "Multi-AZ",
  SINGLE_AZ: "Single-AZ",

  // ── Usage type values (pricing API usagetype filter) ──────────
  NAT_GATEWAY_HOURS: "NatGateway-Hours",
  NAT_GATEWAY_BYTES: "NatGateway-Bytes",
  API_GATEWAY_MESSAGE: "ApiGatewayMessage",
  API_GATEWAY_HTTP_REQUEST: "ApiGatewayHttpRequest",
  API_GATEWAY_MINUTE: "ApiGatewayMinute",
  LAMBDA_REQUEST: "Request",
  LAMBDA_GB_SECOND: "Lambda-GB-Second",
  // (f) 2026-04-09: Lambda provisioned concurrency GB-seconds usage type.
  // AWS bills committed provisioned concurrency per GB-second whether or
  // not the warm instances handle any invocations — hence FIXED line item.
  LAMBDA_PROVISIONED_CONCURRENCY_GB_SECOND:
    "Lambda-Provisioned-Concurrency-GB-Second",
  DATA_PROCESSING_BYTES: "DataProcessing-Bytes",
  // SNS group values — stable cross-region (usagetype is region-prefixed, e.g.
  // "USE1-Requests-Tier1", "USE1-DeliveryAttempts-HTTP" in us-east-1).
  // The `group` attribute is consistently the same value across all regions
  // and is the correct stable discriminator — mirrors S3-API-Tier1/Tier2 fix
  // from EPIC-106-8.
  SNS_REQUESTS_TIER1: "SNS-Requests-Tier1",
  SNS_DELIVERY_ATTEMPTS_HTTP: "SNS-HTTP",
  // SQS queue-type discriminator values for the `queueType` attribute
  // returned by the AWS Pricing API `AmazonSQS` service code.
  QUEUE_TYPE_STANDARD: "Standard",
  QUEUE_TYPE_FIFO: "FIFO",
} as const;
