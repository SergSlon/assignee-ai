/**
 * Named constants for line item label strings used in decomposers.
 * Zero magic strings policy — every label literal must reference this map.
 */

export const LineItemLabel = {
  STORAGE: "Storage",
  COMPUTE: "Compute",
  DATA_TRANSFER_OUT: "Data transfer out",
  PUBLIC_IPV4: "Public IPv4",
  BACKUP: "Backup",
  REQUESTS: "Requests",
  DURATION: "Duration",
  CLOUDWATCH_LOGS: "CloudWatch Logs",
  READ_CAPACITY: "Read capacity",
  WRITE_CAPACITY: "Write capacity",
  HOURLY: "Hourly",
  HOURLY_RATE: "Hourly rate",
  DATA_PROCESSING: "Data processing",
  LCU: "LCU",
  NLCU: "NLCU",
  PUBLISHES: "Publishes",
  HTTP_NOTIFICATIONS: "HTTP notifications",
  SECRET_STORAGE: "Secret storage",
  API_CALLS: "API calls",
  PARAMETER_STORAGE: "Parameter storage",
  ALARM: "Alarm",
  MESSAGES: "Messages",
  CONNECTION_MINUTES: "Connection minutes",
  LOG_INGESTION: "Log ingestion",
  LOG_STORAGE: "Log storage",
  IMAGE_STORAGE: "Image storage",
  PUT_REQUESTS: "PUT requests",
  GET_REQUESTS: "GET requests",
  // A11 (2026-04-09): AWS::KMS::Key
  KEY_STORAGE: "Key storage",
  // (f) 2026-04-09: EFS provisioned throughput (separate from Standard storage)
  PROVISIONED_THROUGHPUT: "Provisioned throughput",
  // (f) 2026-04-09: Lambda provisioned concurrency (committed warm GB-seconds)
  PROVISIONED_CONCURRENCY: "Provisioned concurrency",
} as const;

/**
 * Named constants for decomposer description strings.
 * Zero magic strings policy — every description literal must reference this map.
 */
export const DecomposerDescription = {
  PER_MILLION: "per million",
  PER_GB: "per GB",
  PER_100K: "per 100K",
  STANDARD: "Standard",
} as const;
