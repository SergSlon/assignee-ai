/**
 * Story 108-B-04 — `@assignee/core/telemetry` barrel.
 *
 * Exports:
 *  - Schema types (`TelemetryEvent`, `IntentRoutingEvent`).
 *  - Local log writer public API (`isTelemetryEnabled`, `appendRoutingEvent`,
 *    `resolveTelemetryLogPath`, `TELEMETRY_LOG_FILENAME`, etc.).
 *
 * Used by `apps/cli/src/commands/doctor/checks/intent-routing-health.ts` to
 * read the persisted JSONL and compute miss-rate, and by any future telemetry
 * consumers that need the routing event shape.
 */

export type {
  TelemetryEvent,
  IntentRoutingEvent,
} from "./telemetry-event-schema.js";
export {
  TELEMETRY_ADAPTER_ENV,
  LOCAL_ADAPTER_VALUE,
  TELEMETRY_LOG_FILENAME,
  isTelemetryEnabled,
  resolveTelemetryLogPath,
  appendRoutingEvent,
} from "./local-log-writer.js";
