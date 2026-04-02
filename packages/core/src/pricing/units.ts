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
} as const;
