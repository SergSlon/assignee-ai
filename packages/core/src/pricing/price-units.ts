/**
 * Named constants for price unit strings used in decomposer line items.
 * Zero magic strings policy — every price unit literal must reference this map.
 *
 * Per-million suffixes are derived from `formatUnitSuffix` (unit-label.ts) so
 * the canonical "/M <noun>" convention is enforced in one place.
 */

import { formatUnitSuffix } from "./formatters/unit-label.js";

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
  PER_MILLION_REQS: formatUnitSuffix("req"),
  PER_MILLION_READ_REQS: formatUnitSuffix("read req"),
  PER_MILLION_WRITE_REQS: formatUnitSuffix("write req"),
  PER_MILLION_MSGS: formatUnitSuffix("msg"),
  PER_MILLION_MINS: formatUnitSuffix("min"),
  PER_MILLION_PUBLISHES: formatUnitSuffix("publish"),
  PER_MILLION_REQUESTS: formatUnitSuffix("request"),
  PER_MILLION_MESSAGES: formatUnitSuffix("message"),
  PER_1000_REQS: "/1000 reqs",
  PER_100K_NOTIFS: "/100K notifs",
  PER_10K_REQS: "/10K reqs",
  // Long-form variants used in strategy mcpConfig.unit fields
  PER_HOUR_LONG: "/hour",
  PER_GB_MONTH_LONG: "/GB-month",
  // A11 (2026-04-09): AWS::KMS::Key — $1/key-month (symmetric + asymmetric)
  PER_KEY_MONTH: "/key-mo",
  // (f) 2026-04-09: EFS provisioned throughput billing unit.
  PER_MIBPS_MONTH: "/MiB/s-mo",
} as const;
