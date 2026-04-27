/**
 * W4-05 (Epic 100 Round 3) — InMemoryTelemetryAdapter.
 *
 * In-memory implementation of TelemetryPort for development, testing,
 * and opt-in local observability (ASSIGNEE_TELEMETRY_ADAPTER=in-memory).
 *
 * Events are buffered in a capped ring-buffer (default cap: 1000 events).
 * When the buffer is full, the oldest event is discarded to prevent
 * unbounded memory growth during long-running sessions.
 *
 * This adapter NEVER makes network calls — it is safe to enable in CI.
 */

import type { TelemetryPort } from "../ports/telemetry-port.js";
import type { TelemetryEvent } from "./telemetry-event-schema.js";

/** Default maximum number of events retained in the ring-buffer. */
export const IN_MEMORY_TELEMETRY_DEFAULT_CAP = 1000;

export class InMemoryTelemetryAdapter implements TelemetryPort {
  private readonly events: TelemetryEvent[] = [];
  private readonly cap: number;

  constructor(cap: number = IN_MEMORY_TELEMETRY_DEFAULT_CAP) {
    this.cap = cap;
  }

  /** Receive and buffer a pre-scrubbed TelemetryEvent. */
  async emit(event: TelemetryEvent): Promise<void> {
    if (this.events.length >= this.cap) {
      this.events.shift(); // discard oldest
    }
    this.events.push(event);
  }

  /**
   * Return a shallow copy of all buffered events, in emission order.
   * Callers that mutate the returned array do not affect the buffer.
   */
  getEvents(): TelemetryEvent[] {
    return [...this.events];
  }

  /**
   * Return events matching a given event_name (exact string match).
   * Useful in tests for asserting a specific lifecycle stage was emitted.
   */
  getEventsByName(name: string): TelemetryEvent[] {
    return this.events.filter((e) => e.event_name === name);
  }

  /**
   * Return events for a specific graph node_id.
   */
  getEventsByNode(nodeId: string): TelemetryEvent[] {
    return this.events.filter((e) => e.node_id === nodeId);
  }

  /** Clear the ring-buffer. Used in test teardown. */
  clear(): void {
    this.events.length = 0;
  }

  /** Current number of buffered events. */
  get size(): number {
    return this.events.length;
  }
}
