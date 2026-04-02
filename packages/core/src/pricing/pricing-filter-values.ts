/**
 * Named constants for AWS Pricing API filter values used in decomposers
 * and strategies. These are the Value fields passed to TERM_MATCH filters.
 * Zero magic strings policy — every filter value literal must reference this map.
 */

export const PricingFilterValue = {
  // Location types (data transfer)
  AWS_REGION: "AWS Region",
  EXTERNAL: "External",

  // Transfer types
  AWS_OUTBOUND: "AWS Outbound",

  // EC2 / VPC group values
  ELASTIC_IP_ADDRESS: "ElasticIP:Address",

  // DynamoDB group values
  DDB_READ_UNITS: "DDB-ReadUnits",
  DDB_WRITE_UNITS: "DDB-WriteUnits",

  // S3 / DynamoDB usage types
  TIMED_STORAGE_BYTE_HRS: "TimedStorage-ByteHrs",
  REQUESTS_TIER1: "Requests-Tier1",
  REQUESTS_TIER2: "Requests-Tier2",

  // RDS deployment options
  MULTI_AZ: "Multi-AZ",
  SINGLE_AZ: "Single-AZ",
} as const;
