/**
 * Canonical measurement units used in pricing decomposers.
 * Single source of truth — every `unit:` in a decomposer must reference these constants.
 */

export const PricingUnit = {
  GB: "GB",
  REQUESTS: "requests",
  INSTANCE: "instance",
  ADDRESS: "address",
  GATEWAY: "gateway",
  ALB: "ALB",
  NLB: "NLB",
  ALARM: "alarm",
  SECRET: "secret",
  PARAMETER: "parameter",
  MESSAGES: "messages",
  MINUTES: "minutes",
  NOTIFICATIONS: "notifications",
  RCU: "RCU",
  WCU: "WCU",
  GB_SECOND: "GB-second",
  LCU_HR: "LCU-hr",
  NLCU_HR: "NLCU-hr",
  // A11 (2026-04-09): AWS::KMS::Key — $1/key/month prorated to the hour
  KEY: "key",
  // (f) 2026-04-09: EFS provisioned throughput (MiB/s-month).
  // Only emitted when ThroughputMode=provisioned — that's a rare
  // but expensive configuration (~$6/MiB-s-month in us-east-1)
  // that the old decomposer deferred as "rarely-used edge case".
  // Surfacing it explicitly makes the cost visible at plan time
  // instead of waiting for the AWS invoice.
  MIBPS: "MiB/s",
} as const;
