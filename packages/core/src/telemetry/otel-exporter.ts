/**
 * Minimal OTLP/HTTP-JSON log exporter for Assignee.ai CLI.
 *
 * Lifted from `apps/cli/src/telemetry/otel-exporter.ts` in Story 50-4
 * Wave 5 Pass A so the in-core logger can mirror structured events to
 * the OTLP endpoint without reaching back into the CLI app.
 *
 * Closes the M-6.4 NFR concern from `docs/nfr-assessment-2026-04-08.md`:
 * "no OTEL/X-Ray exporter — observability stops at the local log file."
 *
 * **Scope:** logs signal only (OTLP `v1/logs`). Spans are out of scope —
 * the CLI does not yet construct a parent/child span tree, and shipping
 * logs is enough to clear the "no exporter present" concern.
 *
 * **Activation:** opt-in via `ASSIGNEE_OTEL_ENDPOINT`. Absent/empty →
 * `isOtelEnabled()` returns false and `exportLogEvent()` is a no-op
 * (zero allocations, zero network calls).
 *
 * **Failure mode:** every error is swallowed (network failures, slow
 * collector, schema mismatch). The exporter is fire-and-forget — it
 * MUST NOT block, throw, or affect the CLI exit code. Telemetry that
 * crashes the tool it instruments is worse than no telemetry.
 *
 * **Format:** OTLP/HTTP JSON encoding per the OpenTelemetry spec
 * (https://opentelemetry.io/docs/specs/otlp/#otlphttp-request). We hand-
 * roll the JSON to avoid pulling in `@opentelemetry/*` packages — those
 * weigh ~2 MB on disk and would force every CLI install to carry the
 * full OTEL SDK whether or not the user enables it.
 */

import { EnvVar } from "../constants/env-vars.js";
import type { LogEvent, LogLevelType } from "../utils/logger/actions.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Default service.name when ASSIGNEE_OTEL_SERVICE_NAME is unset. */
export const DEFAULT_OTEL_SERVICE_NAME = "assignee-cli";

/** OTLP HTTP path for the logs signal. Appended to the user-supplied endpoint. */
export const OTLP_LOGS_PATH = "/v1/logs";

/**
 * Network timeout for the export POST. Telemetry is best-effort — a slow
 * collector should never stall a CLI command. 1 s is generous for a
 * loopback collector and bounded for a misbehaving remote.
 */
export const OTEL_EXPORT_TIMEOUT_MS = 1000;

/**
 * OpenTelemetry severity number mapping per the spec
 * (https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber).
 * INFO = 9, WARN = 13, ERROR = 17. Anything else falls through to
 * UNSPECIFIED (0).
 */
const SEVERITY_NUMBERS: Record<LogLevelType, number> = {
  info: 9,
  warn: 13,
  error: 17,
};

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Returns the configured OTLP endpoint URL, or undefined when the
 * exporter is disabled. Empty/whitespace strings count as disabled.
 *
 * Read on every call (not cached) so tests and runtime overrides apply
 * immediately.
 */
export function getOtelEndpoint(): string | undefined {
  const raw = process.env[EnvVar.ASSIGNEE_OTEL_ENDPOINT];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns the resolved service.name attribute value. Honors
 * `ASSIGNEE_OTEL_SERVICE_NAME`; falls back to `DEFAULT_OTEL_SERVICE_NAME`
 * for absent or empty values.
 */
export function getOtelServiceName(): string {
  const raw = process.env[EnvVar.ASSIGNEE_OTEL_SERVICE_NAME];
  if (raw === undefined) return DEFAULT_OTEL_SERVICE_NAME;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_OTEL_SERVICE_NAME;
}

/** Convenience: is the exporter currently active? */
export function isOtelEnabled(): boolean {
  return getOtelEndpoint() !== undefined;
}

/* ------------------------------------------------------------------ */
/*  Payload construction                                               */
/* ------------------------------------------------------------------ */

/** OTLP/HTTP JSON shape for a single emitted log event — exported for tests. */
export interface OtlpLogPayload {
  resourceLogs: [
    {
      resource: {
        attributes: Array<{
          key: string;
          value: { stringValue: string };
        }>;
      };
      scopeLogs: [
        {
          scope: { name: string; version?: string };
          logRecords: Array<{
            timeUnixNano: string;
            severityNumber: number;
            severityText: string;
            body: { stringValue: string };
            attributes: Array<{
              key: string;
              value: {
                stringValue?: string;
                intValue?: string;
                boolValue?: boolean;
                doubleValue?: number;
              };
            }>;
          }>;
        },
      ];
    },
  ];
}

/**
 * Convert a structured LogEvent into the OTLP/HTTP JSON shape. Pure
 * function — no I/O, no env reads — so it can be unit-tested without
 * mocking fetch. The runId is exposed both as an attribute (for filtering)
 * and as the body's primary correlation key.
 */
export function buildOtlpPayload(
  event: LogEvent,
  serviceName: string,
): OtlpLogPayload {
  // OpenTelemetry timestamps are nanoseconds since the Unix epoch as a
  // string (because uint64 doesn't fit in a JSON number). Date.parse gives
  // us ms; multiply by 1_000_000 and stringify.
  const timeMs = Date.parse(event.ts);
  const timeUnixNano = Number.isFinite(timeMs)
    ? String(BigInt(timeMs) * 1_000_000n)
    : String(BigInt(Date.now()) * 1_000_000n);

  const severityNumber = SEVERITY_NUMBERS[event.level] ?? 0;

  // Flatten the structured event into OTLP attribute records. We always
  // include runId + action; durationMs and result are optional. The
  // freeform `extras` map is fanned out as one attribute per key, with
  // string/int/bool/double dispatch — anything else (objects, arrays) is
  // JSON-stringified into a stringValue so the receiver can re-parse.
  const attributes: OtlpLogPayload["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["attributes"] =
    [
      { key: "runId", value: { stringValue: event.runId } },
      { key: "action", value: { stringValue: event.action } },
    ];
  if (event.durationMs !== undefined) {
    // ms is small enough to fit in a double; use doubleValue rather than
    // intValue to preserve fractional millisecond precision when present.
    attributes.push({
      key: "durationMs",
      value: { doubleValue: event.durationMs },
    });
  }
  if (event.result !== undefined) {
    attributes.push({ key: "result", value: { stringValue: event.result } });
  }
  for (const [k, v] of Object.entries(event.extras ?? {})) {
    if (typeof v === "string") {
      attributes.push({ key: k, value: { stringValue: v } });
    } else if (typeof v === "number") {
      // Use doubleValue to preserve floats; integers fit too.
      attributes.push({ key: k, value: { doubleValue: v } });
    } else if (typeof v === "boolean") {
      attributes.push({ key: k, value: { boolValue: v } });
    } else if (v === null || v === undefined) {
      // OTLP has no explicit null type; emit empty string so the attribute
      // is still present (so users can filter on "key exists").
      attributes.push({ key: k, value: { stringValue: "" } });
    } else {
      // Object/array/etc. — JSON-stringify so the receiver can re-parse.
      // try/catch the stringify in case of circular references.
      let serialized: string;
      try {
        serialized = JSON.stringify(v);
      } catch {
        serialized = "[unserializable]";
      }
      attributes.push({ key: k, value: { stringValue: serialized } });
    }
  }

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "assignee.cli" },
            logRecords: [
              {
                timeUnixNano,
                severityNumber,
                severityText: event.level.toUpperCase(),
                body: { stringValue: event.action },
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Export hot path                                                    */
/* ------------------------------------------------------------------ */

/**
 * Fire-and-forget POST a single log event to the configured OTLP
 * endpoint. No-op when the exporter is disabled.
 *
 * Returns a promise that always resolves (never rejects) so callers
 * can `void exportLogEvent(...)` without handling rejections.
 */
export async function exportLogEvent(event: LogEvent): Promise<void> {
  const endpoint = getOtelEndpoint();
  if (endpoint === undefined) return;

  const url = endpoint.replace(/\/$/, "") + OTLP_LOGS_PATH;
  const payload = buildOtlpPayload(event, getOtelServiceName());

  // AbortController gives us a deterministic timeout; the global fetch
  // in Node 20.11+ supports it natively.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    OTEL_EXPORT_TIMEOUT_MS,
  );

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Telemetry is best-effort. Network failures, DNS errors, slow
    // collectors, schema rejections — all swallowed silently. The local
    // ~/.assignee/logs/cli-*.jsonl file remains the source of truth.
  } finally {
    clearTimeout(timeoutHandle);
  }
}
