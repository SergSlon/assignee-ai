/**
 * W6-04 — Per-graph-node span emitter.
 *
 * Emits a structured "span" event at graph-node entry and exit. Spans
 * are published via the existing `exportLogEvent` path (OTEL/HTTP) when
 * the exporter is enabled, and always appear in the local JSONL log as
 * a debug record.
 *
 * Design decisions:
 *   - We hand-roll the span protocol (entry + exit events correlated by
 *     spanId) to avoid pulling in `@opentelemetry/*` SDK packages, which
 *     weigh ~2 MB and conflict with the "no vendor phone-home" invariant
 *     (L1-F52). Downstream OTEL collectors can reconstruct parent/child
 *     span trees from the `spanId` + `traceId` pair.
 *   - `traceId` = `runId` for CLI invocations so every span in a single
 *     `assignee infra apply` session is co-located in one trace.
 *   - Duration is computed at exit and backfilled into the `durationMs`
 *     field on the exit span.
 *
 * Coverage target: ≥13 of 14 graph nodes (per W6-04 acceptance criterion).
 * The HUMAN_APPROVAL node is excluded — it blocks indefinitely on user
 * input and has no meaningful entry/exit timing. Wrap all others.
 *
 * @see packages/core/src/constants/graph-node.ts — node names
 * @see packages/core/src/telemetry/otel-exporter.ts — export machinery
 * @see packages/core/src/telemetry/otel-allowlist.ts — field filtering
 */

import { exportLogEvent } from "./otel-exporter.js";
import { filterAllowlistedFields } from "./otel-allowlist.js";
import type { LogEvent, LogAction } from "../utils/logger/actions.js";

// ── Span ID generation ─────────────────────────────────────────────────

/** Generates a random 16-hex-character span ID. */
function makeSpanId(): string {
  return Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, "0"),
  ).join("");
}

// ── Span event shape ──────────────────────────────────────────────────

export interface SpanEvent {
  spanId: string;
  traceId: string;
  node: string;
  nodeEntry?: boolean;
  nodeExit?: boolean;
  durationMs?: number;
  result?: string;
  errorClass?: string;
}

// ── Nodes excluded from span instrumentation ──────────────────────────

/**
 * Nodes excluded from span instrumentation. HUMAN_APPROVAL blocks
 * indefinitely on user input — measuring entry/exit timing is
 * meaningless and would inflate span open-time metrics.
 */
export const SPAN_EXCLUDED_NODES = new Set(["human_approval"]);

// ── Span tracking ─────────────────────────────────────────────────────

/**
 * In-flight spans keyed by `${runId}:${node}`. Stores the entry
 * timestamp and spanId so the exit emitter can compute durationMs.
 */
const IN_FLIGHT_SPANS = new Map<string, { spanId: string; startMs: number }>();

// ── Emit helper ───────────────────────────────────────────────────────

interface SpanEventInput {
  runId: string;
  action: string;
  level?: LogEvent["level"];
  durationMs?: number;
  result?: string;
}

async function emitSpanEvent(
  event: SpanEventInput,
  extras: SpanEvent,
): Promise<void> {
  const filtered = filterAllowlistedFields(
    extras as unknown as Record<string, unknown>,
  );
  const logEvent: LogEvent = {
    ts: new Date().toISOString(),
    level: event.level ?? "info",
    runId: event.runId,
    // Span actions are dynamic (e.g. "intent_parser.entry") — cast to LogAction
    // since the exporter only uses this for the OTLP body field, not enum dispatch.
    action: event.action as LogAction,
    durationMs: extras.durationMs,
    result: extras.result,
    extras: filtered,
  };

  // Fire-and-forget: OTEL export is best-effort, never blocks graph execution
  void exportLogEvent(logEvent);
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Emit a span-entry event for a graph node. Returns the spanId so
 * the caller can pass it to `emitNodeExit`.
 *
 * @param runId - Current run UUID (acts as the OTEL traceId)
 * @param node - GraphNode constant (e.g. GraphNode.INTENT_PARSER)
 * @returns spanId to pass to emitNodeExit, or undefined if the node is excluded
 */
export async function emitNodeEntry(
  runId: string,
  node: string,
): Promise<string | undefined> {
  if (SPAN_EXCLUDED_NODES.has(node)) return undefined;

  const spanId = makeSpanId();
  const startMs = Date.now();
  const key = `${runId}:${node}`;
  IN_FLIGHT_SPANS.set(key, { spanId, startMs });

  await emitSpanEvent(
    { runId, action: `${node}.entry` },
    { spanId, traceId: runId, node, nodeEntry: true },
  );

  return spanId;
}

/**
 * Emit a span-exit event for a graph node.
 *
 * @param runId - Current run UUID (must match the emitNodeEntry call)
 * @param node - GraphNode constant
 * @param result - "success" | "failure" | "partial" (optional)
 * @param errorClass - Short error class on failure (optional)
 */
export async function emitNodeExit(
  runId: string,
  node: string,
  result?: string,
  errorClass?: string,
): Promise<void> {
  if (SPAN_EXCLUDED_NODES.has(node)) return;

  const key = `${runId}:${node}`;
  const inFlight = IN_FLIGHT_SPANS.get(key);
  IN_FLIGHT_SPANS.delete(key);

  const spanId = inFlight?.spanId ?? makeSpanId();
  const durationMs = inFlight ? Date.now() - inFlight.startMs : undefined;

  const extras: SpanEvent = {
    spanId,
    traceId: runId,
    node,
    nodeExit: true,
    durationMs,
    result,
    errorClass,
  };

  // Remove undefined keys so the filter can tell them apart from "field present with value undefined"
  const cleanExtras = Object.fromEntries(
    Object.entries(extras).filter(([, v]) => v !== undefined),
  ) as SpanEvent;

  await emitSpanEvent(
    { runId, action: `${node}.exit`, durationMs, result },
    cleanExtras,
  );
}

/**
 * Convenience wrapper: instrument a graph-node handler with automatic
 * entry + exit spans. The handler receives the runId and may call
 * other span-emitting functions.
 *
 * Usage:
 * ```ts
 * const result = await withNodeSpan(runId, GraphNode.INTENT_PARSER, async () => {
 *   return await intentParser(state);
 * });
 * ```
 */
export async function withNodeSpan<T>(
  runId: string,
  node: string,
  fn: () => Promise<T>,
): Promise<T> {
  await emitNodeEntry(runId, node);
  let result: T;
  try {
    result = await fn();
    await emitNodeExit(runId, node, "success");
  } catch (err) {
    const errorClass =
      err instanceof Error ? err.constructor.name : "UnknownError";
    await emitNodeExit(runId, node, "failure", errorClass);
    throw err;
  }
  return result;
}

/**
 * @internal Test helper — clears all in-flight spans. Call in afterEach
 * to prevent span state leaking between tests.
 */
export function _clearInFlightSpansForTests(): void {
  IN_FLIGHT_SPANS.clear();
}
