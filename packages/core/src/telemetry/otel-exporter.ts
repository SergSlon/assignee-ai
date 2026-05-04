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

import { parseBoolEnv } from "../llm/adapter.js";
import { EnvVar } from "../constants/env-vars.js";
import type { LogEvent, LogLevelType } from "../utils/logger/actions.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";

// ── F026 / SEC-023: hostname allowlist ────────────────────────────────
//
// Default-deny: only loopback / LAN-local hostnames are permitted unless
// the operator explicitly extends the list via ASSIGNEE_OTEL_ENDPOINT_ALLOWLIST
// (comma-separated; already in EnvVar enum) or opts out entirely via
// ASSIGNEE_OTEL_ALLOW_ANY_HOSTNAME=1.
//
// Pattern matching: a leading "*." is a suffix wildcard — "*.local" matches
// "myhost.local" but NOT "notlocal". All comparisons are case-insensitive.

/** Built-in safe-core allowlist — loopback and LAN-local only. */
const DEFAULT_OTEL_ALLOWED_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  "*.local",
];

/** Returns true when `hostname` matches a pattern from the combined allowlist. */
function matchesAllowlist(
  hostname: string,
  patterns: readonly string[],
): boolean {
  const h = hostname.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) {
      if (h.endsWith(p.slice(1))) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when the endpoint's hostname is permitted.
 *
 * Decision order:
 * 1. `ASSIGNEE_OTEL_ALLOW_ANY_HOSTNAME=1` → allow all (operator opt-out).
 * 2. `ASSIGNEE_OTEL_ENDPOINT_ALLOWLIST` set → check against that list only
 *    (operator-supplied list replaces the built-in defaults).
 * 3. Otherwise → check against DEFAULT_OTEL_ALLOWED_HOSTS (loopback + *.local).
 */
export function isEndpointHostnameAllowed(
  endpoint: string,
  config: ConfigPort,
): boolean {
  if (parseBoolEnv(EnvVar.ASSIGNEE_OTEL_ALLOW_ANY_HOSTNAME)) return true;

  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return false;
  }

  const raw = config.get(EnvVar.ASSIGNEE_OTEL_ENDPOINT_ALLOWLIST);
  if (raw !== undefined && raw.trim().length > 0) {
    const operatorList = raw
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    return matchesAllowlist(hostname, operatorList);
  }

  return matchesAllowlist(hostname, DEFAULT_OTEL_ALLOWED_HOSTS);
}

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
 *
 * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
 * supply a tenant-scoped lookup. When omitted, falls back to a fresh
 * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
 */
export function getOtelEndpoint(config?: ConfigPort): string | undefined {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  const raw = effectiveConfig.get(EnvVar.ASSIGNEE_OTEL_ENDPOINT);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns the resolved service.name attribute value. Honors
 * `ASSIGNEE_OTEL_SERVICE_NAME`; falls back to `DEFAULT_OTEL_SERVICE_NAME`
 * for absent or empty values.
 *
 * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
 * supply a tenant-scoped lookup. When omitted, falls back to a fresh
 * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
 */
export function getOtelServiceName(config?: ConfigPort): string {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  const raw = effectiveConfig.get(EnvVar.ASSIGNEE_OTEL_SERVICE_NAME);
  if (raw === undefined) return DEFAULT_OTEL_SERVICE_NAME;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_OTEL_SERVICE_NAME;
}

/**
 * Convenience: is the exporter currently active?
 *
 * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
 * supply a tenant-scoped lookup.
 */
export function isOtelEnabled(config?: ConfigPort): boolean {
  return getOtelEndpoint(config) !== undefined;
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
      // SEC-024: non-primitive extras values (object / Array / Error) bypass
      // the PII gate at LogEvent-build time. Reject with a sentinel rather
      // than JSON-stringifying, which could emit nested ARNs/account IDs
      // to the OTEL collector without going through redaction.
      attributes.push({ key: k, value: { stringValue: "[REDACTED_OBJECT]" } });
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
/*  Scheme validation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Returns true when the endpoint URL uses HTTPS, or when the HTTP
 * override flag (`ASSIGNEE_OTEL_ALLOW_HTTP=1`) is explicitly set.
 *
 * Exported for unit testing; production callers use `exportLogEvent`.
 */
export function isEndpointSchemeAllowed(
  endpoint: string,
  config: ConfigPort,
): boolean {
  if (endpoint.startsWith("https://")) return true;
  // Only http:// is eligible for the dev-override — grpc://, ws://, etc.
  // are never allowed, even when ASSIGNEE_OTEL_ALLOW_HTTP=1.
  if (!endpoint.startsWith("http://")) return false;
  const override = config.get(EnvVar.ASSIGNEE_OTEL_ALLOW_HTTP);
  return override?.trim() === "1";
}

/* ------------------------------------------------------------------ */
/*  Export hot path                                                    */
/* ------------------------------------------------------------------ */

/**
 * Fire-and-forget POST a single log event to the configured OTLP
 * endpoint. No-op when the exporter is disabled.
 *
 * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
 * supply a tenant-scoped lookup. When omitted, falls back to a fresh
 * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
 *
 * Scheme guard: rejects non-HTTPS endpoints unless
 * `ASSIGNEE_OTEL_ALLOW_HTTP=1` is set, to prevent accidental telemetry
 * exfiltration over an unencrypted channel. The rejection is logged to
 * stderr and the call is a no-op (fire-and-forget — never throws).
 *
 * Returns a promise that always resolves (never rejects) so callers
 * can `void exportLogEvent(...)` without handling rejections.
 *
 * DEF-10 audit (HEAD 8a856878): This is the **only** exporter function
 * in this module. Metric and span exporters (`exportMetric`,
 * `exportSpan`, batch variants) do not exist — the module header
 * explicitly limits scope to the logs signal (OTLP `v1/logs`). No
 * additional ConfigPort guards or `isEndpointSchemeAllowed` calls are
 * required. DEF-10 is closed: no sibling exporters found.
 */
export async function exportLogEvent(
  event: LogEvent,
  config?: ConfigPort,
): Promise<void> {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  const endpoint = getOtelEndpoint(effectiveConfig);
  if (endpoint === undefined) return;

  // Scheme guard: only HTTPS is allowed unless the dev override is set.
  if (!isEndpointSchemeAllowed(endpoint, effectiveConfig)) {
    // Log to stderr — telemetry is fire-and-forget and must not throw.
    process.stderr.write(
      `[assignee/otel] Endpoint rejected: "${endpoint}" uses a non-HTTPS scheme. ` +
        `Set ASSIGNEE_OTEL_ALLOW_HTTP=1 to allow HTTP (development only).\n`,
    );
    return;
  }

  // F026 / SEC-023: hostname allowlist guard (default-deny).
  // Loopback/LAN-local hosts pass by default. External hosts require
  // ASSIGNEE_OTEL_ENDPOINT_ALLOWLIST (comma-separated patterns) or the
  // full opt-out flag ASSIGNEE_OTEL_ALLOW_ANY_HOSTNAME=1.
  if (!isEndpointHostnameAllowed(endpoint, effectiveConfig)) {
    process.stderr.write(
      `[assignee/otel] Endpoint rejected: hostname of "${endpoint}" is not in the ` +
        `allowlist. Set ASSIGNEE_OTEL_ENDPOINT_ALLOWLIST=<host,...> or ` +
        `ASSIGNEE_OTEL_ALLOW_ANY_HOSTNAME=1 to permit it.\n`,
    );
    return;
  }

  const url = endpoint.replace(/\/$/, "") + OTLP_LOGS_PATH;
  const payload = buildOtlpPayload(event, getOtelServiceName(effectiveConfig));

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
