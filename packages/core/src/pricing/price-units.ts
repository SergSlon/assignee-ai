/**
 * Named constants for price unit strings used in decomposer line items.
 * Zero magic strings policy — every price unit literal must reference this map.
 */

export const PriceUnit = {
  PER_HOUR: "/hr",
  PER_GB_MONTH: "/GB-mo",
  PER_GB: "/GB",
  PER_GB_SECOND: "/GB-s",
  PER_GB_INGESTED: "/GB ingested",
  PER_ALARM_MONTH: "/alarm-mo",
  PER_SECRET_MONTH: "/secret-mo",
  PER_PARAM_MONTH: "/param-mo",
  PER_RCU_HOUR: "/RCU-hr",
  PER_WCU_HOUR: "/WCU-hr",
  PER_LCU_HOUR: "/LCU-hr",
  PER_NLCU_HOUR: "/NLCU-hr",
  PER_MILLION_REQS: "/M reqs",
  PER_MILLION_READ_REQS: "/M read reqs",
  PER_MILLION_WRITE_REQS: "/M write reqs",
  PER_MILLION_MSGS: "/M msgs",
  PER_MILLION_MINS: "/M mins",
  PER_MILLION_PUBLISHES: "/M publishes",
  PER_1000_REQS: "/1000 reqs",
  PER_100K_NOTIFS: "/100K notifs",
  PER_10K_REQS: "/10K reqs",
  // Long-form variants used in strategy mcpConfig.unit fields
  PER_HOUR_LONG: "/hour",
  PER_GB_MONTH_LONG: "/GB-month",
  PER_MILLION_REQUESTS_LONG: "/million requests",
} as const;
