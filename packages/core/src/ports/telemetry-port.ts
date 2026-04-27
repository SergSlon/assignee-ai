/**
 * W4-05 (Epic 100 Round 3) — TelemetryPort: hexagonal port for telemetry
 * event emission.
 *
 * Substrate for Epic 102's production collector. Today's adapters:
 *   - InMemoryTelemetryAdapter (development / test — no external calls).
 *   - (Epic 102) FileTelemetryAdapter, OtelTelemetryAdapter, etc.
 *
 * Telemetry is OFF by default (L1-F52 — no vendor phone-home unless the
 * user explicitly sets ASSIGNEE_TELEMETRY_ADAPTER=in-memory|file|...).
 * `isTelemetryEnabled()` reflects this gate; all emit paths MUST check it.
 *
 * Composition with W6 + W1 filters:
 *   - `emitFiltered` runs `filterAllowlistedFields` (W6 OTEL allowlist)
 *     then `filterSensitiveElicitedFields` (W1 sensitive-marker scrub)
 *     before calling `adapter.emit`. Adapters always receive pre-scrubbed
 *     events — they MUST NOT apply additional field-level filtering.
 *
 * @see packages/core/src/telemetry/telemetry-event-schema.ts
 * @see packages/core/src/telemetry/in-memory-telemetry-adapter.ts
 * @see packages/core/src/telemetry/otel-allowlist.ts
 */

import type { TelemetryEvent } from "../telemetry/telemetry-event-schema.js";
import {
  filterAllowlistedFields,
  filterSensitiveElicitedFields,
} from "../telemetry/otel-allowlist.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";

// ── TelemetryPort interface ────────────────────────────────────────────

/**
 * Hexagonal port for telemetry. Adapters MUST be:
 *   - Non-throwing: `emit` must catch all internal errors and handle them
 *     silently (telemetry must never crash the caller).
 *   - Non-blocking: `emit` should complete in < 1 ms for in-process adapters;
 *     network adapters should fire-and-forget (do NOT await the I/O in the
 *     hot path).
 */
export interface TelemetryPort {
  /**
   * Emit a pre-filtered TelemetryEvent to the adapter's sink.
   * Called by `emitFiltered` after W6 + W1 scrubbing. Adapters receive
   * clean events only.
   */
  emit(event: TelemetryEvent): Promise<void>;
}

// ── Opt-in gate ───────────────────────────────────────────────────────

/**
 * Returns true when the caller has explicitly opted in to a telemetry
 * adapter via `ASSIGNEE_TELEMETRY_ADAPTER`. Absent or empty → false
 * (L1-F52 invariant: no vendor phone-home by default).
 *
 * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
 * supply a tenant-scoped lookup. When omitted, falls back to a fresh
 * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
 */
export function isTelemetryEnabled(config?: ConfigPort): boolean {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  const val = effectiveConfig.get("ASSIGNEE_TELEMETRY_ADAPTER");
  return typeof val === "string" && val.trim().length > 0;
}

// ── Filtered emit helper ──────────────────────────────────────────────

/**
 * Emit a TelemetryEvent through an adapter after applying the W6 + W1
 * field-scrubbing pipeline.
 *
 * Execution order:
 *   1. `isTelemetryEnabled()` gate — no-op when telemetry is off.
 *   2. `filterAllowlistedFields` (W6): drop unknown + PII fields.
 *   3. `filterSensitiveElicitedFields` (W1): redact credential values.
 *   4. `adapter.emit(scrubbedEvent)` — fire-and-forget; errors swallowed.
 *
 * @param adapter  - TelemetryPort implementation.
 * @param event    - Raw event from the graph node (may have unfiltered extras).
 * @param sensitiveNames - Set of sensitive elicited-field names (W1).
 *   Pass an empty set when no sensitive fields are in scope (no-op).
 */
export async function emitFiltered(
  adapter: TelemetryPort | undefined,
  event: TelemetryEvent,
  sensitiveNames: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (!adapter || !isTelemetryEnabled()) return;

  try {
    const allowlisted = filterAllowlistedFields(event.extras);
    const scrubbed = filterSensitiveElicitedFields(allowlisted, sensitiveNames);
    await adapter.emit({ ...event, extras: scrubbed });
  } catch {
    // Fire-and-forget: telemetry failures are silently swallowed.
  }
}
