/**
 * OTLP/HTTP-JSON log exporter — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core`
 * (lifted in Story 50-4 Wave 5 Pass A so the in-core logger can mirror
 * structured events to the OTLP endpoint without reaching back into
 * the CLI app).
 */
export {
  DEFAULT_OTEL_SERVICE_NAME,
  OTLP_LOGS_PATH,
  OTEL_EXPORT_TIMEOUT_MS,
  getOtelEndpoint,
  getOtelServiceName,
  isOtelEnabled,
  buildOtlpPayload,
  exportLogEvent,
  type OtlpLogPayload,
} from "@assignee/core";
