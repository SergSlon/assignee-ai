/**
 * W4-05 (Epic 100 Round 3) — TelemetryPort + InMemoryTelemetryAdapter tests.
 *
 * Covers:
 *   - InMemoryTelemetryAdapter round-trip (emit → getEvents).
 *   - Ring-buffer cap (oldest event discarded when full).
 *   - `isTelemetryEnabled()` opt-in gate (off by default; on with env var).
 *   - `emitFiltered` composition: W6 allowlist + W1 sensitive-marker scrub.
 *   - `emitFiltered` no-ops when telemetry is off.
 *   - Fire-and-forget: adapter errors are swallowed by `emitFiltered`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryTelemetryAdapter } from "./in-memory-telemetry-adapter.js";
import {
  isTelemetryEnabled,
  emitFiltered,
  type TelemetryPort,
} from "./telemetry-port.js";
import type { TelemetryEvent } from "./telemetry-event-schema.js";

// ── Fixture factory ───────────────────────────────────────────────────

function makeEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    event_name: "intent_parser.entry",
    timestamp: new Date().toISOString(),
    node_id: "intent_parser",
    tenant_id: "local",
    extras: { node: "intent_parser", nodeEntry: true },
    ...overrides,
  };
}

// ── InMemoryTelemetryAdapter ──────────────────────────────────────────

describe("InMemoryTelemetryAdapter", () => {
  it("buffers emitted events", async () => {
    const adapter = new InMemoryTelemetryAdapter();
    const event = makeEvent();
    await adapter.emit(event);
    expect(adapter.getEvents()).toHaveLength(1);
    expect(adapter.getEvents()[0]!.event_name).toBe("intent_parser.entry");
  });

  it("returns a copy — mutations do not affect the buffer", async () => {
    const adapter = new InMemoryTelemetryAdapter();
    await adapter.emit(makeEvent());
    const copy = adapter.getEvents();
    copy.length = 0;
    expect(adapter.size).toBe(1);
  });

  it("getEventsByName filters correctly", async () => {
    const adapter = new InMemoryTelemetryAdapter();
    await adapter.emit(makeEvent({ event_name: "intent_parser.entry" }));
    await adapter.emit(makeEvent({ event_name: "schema_fetcher.entry" }));
    const results = adapter.getEventsByName("intent_parser.entry");
    expect(results).toHaveLength(1);
    expect(results[0]!.event_name).toBe("intent_parser.entry");
  });

  it("getEventsByNode filters correctly", async () => {
    const adapter = new InMemoryTelemetryAdapter();
    await adapter.emit(makeEvent({ node_id: "intent_parser" }));
    await adapter.emit(makeEvent({ node_id: "schema_fetcher" }));
    expect(adapter.getEventsByNode("intent_parser")).toHaveLength(1);
    expect(adapter.getEventsByNode("schema_fetcher")).toHaveLength(1);
  });

  it("respects the ring-buffer cap — discards oldest when full", async () => {
    const cap = 3;
    const adapter = new InMemoryTelemetryAdapter(cap);
    for (let i = 0; i < cap + 1; i++) {
      await adapter.emit(makeEvent({ event_name: `event_${i}` }));
    }
    expect(adapter.size).toBe(cap);
    // event_0 was discarded; event_1 is now oldest
    expect(adapter.getEvents()[0]!.event_name).toBe("event_1");
    expect(adapter.getEvents()[cap - 1]!.event_name).toBe(`event_${cap}`);
  });

  it("clear empties the buffer", async () => {
    const adapter = new InMemoryTelemetryAdapter();
    await adapter.emit(makeEvent());
    adapter.clear();
    expect(adapter.size).toBe(0);
    expect(adapter.getEvents()).toHaveLength(0);
  });
});

// ── isTelemetryEnabled ────────────────────────────────────────────────

describe("isTelemetryEnabled", () => {
  const ORIGINAL = process.env["ASSIGNEE_TELEMETRY_ADAPTER"];

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env["ASSIGNEE_TELEMETRY_ADAPTER"];
    } else {
      process.env["ASSIGNEE_TELEMETRY_ADAPTER"] = ORIGINAL;
    }
  });

  it("returns false when env var is absent (L1-F52 invariant)", () => {
    delete process.env["ASSIGNEE_TELEMETRY_ADAPTER"];
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("returns false when env var is empty string", () => {
    process.env["ASSIGNEE_TELEMETRY_ADAPTER"] = "";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("returns true when env var is 'in-memory'", () => {
    process.env["ASSIGNEE_TELEMETRY_ADAPTER"] = "in-memory";
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("returns true when env var is any non-empty string", () => {
    process.env["ASSIGNEE_TELEMETRY_ADAPTER"] = "file";
    expect(isTelemetryEnabled()).toBe(true);
  });
});

// ── emitFiltered ─────────────────────────────────────────────────────

describe("emitFiltered", () => {
  let adapter: InMemoryTelemetryAdapter;
  const ORIGINAL = process.env["ASSIGNEE_TELEMETRY_ADAPTER"];

  beforeEach(() => {
    adapter = new InMemoryTelemetryAdapter();
    process.env["ASSIGNEE_TELEMETRY_ADAPTER"] = "in-memory";
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env["ASSIGNEE_TELEMETRY_ADAPTER"];
    } else {
      process.env["ASSIGNEE_TELEMETRY_ADAPTER"] = ORIGINAL;
    }
  });

  it("emits when telemetry is enabled", async () => {
    const event = makeEvent();
    await emitFiltered(adapter, event);
    expect(adapter.size).toBe(1);
  });

  it("no-ops when adapter is undefined", async () => {
    await emitFiltered(undefined, makeEvent());
    expect(adapter.size).toBe(0);
  });

  it("no-ops when telemetry is disabled (L1-F52)", async () => {
    delete process.env["ASSIGNEE_TELEMETRY_ADAPTER"];
    await emitFiltered(adapter, makeEvent());
    expect(adapter.size).toBe(0);
  });

  it("strips W6 unknown fields from extras", async () => {
    const event = makeEvent({
      extras: {
        node: "intent_parser",
        nodeEntry: true,
        // rawIntent is PII — should be stripped (no ASSIGNEE_OTEL_INCLUDE_PII set)
        rawIntent: "create an S3 bucket",
        // unknownField not in allowlist — always dropped
        unknownField: "should-be-stripped",
      },
    });
    delete process.env["ASSIGNEE_OTEL_INCLUDE_PII"];
    await emitFiltered(adapter, event);
    expect(adapter.size).toBe(1);
    const emitted = adapter.getEvents()[0]!;
    expect(emitted.extras["unknownField"]).toBeUndefined();
    expect(emitted.extras["rawIntent"]).toBeUndefined();
    expect(emitted.extras["node"]).toBe("intent_parser");
  });

  it("strips W1 sensitive elicited field values", async () => {
    const event = makeEvent({
      extras: {
        node: "option_elicitor",
        // "action" is in allowlist; "Password" is a sensitive field name
        action: "Password",
      },
    });
    const sensitiveNames = new Set(["action"]);
    await emitFiltered(adapter, event, sensitiveNames);
    expect(adapter.size).toBe(1);
    const emitted = adapter.getEvents()[0]!;
    // W1: the "action" key was in sensitiveNames → value should be redacted
    expect(emitted.extras["action"]).not.toBe("Password");
  });

  it("swallows adapter errors (fire-and-forget)", async () => {
    const throwingAdapter: TelemetryPort = {
      emit: async () => {
        throw new Error("adapter failure");
      },
    };
    // Must not throw
    await expect(
      emitFiltered(throwingAdapter, makeEvent()),
    ).resolves.toBeUndefined();
  });
});
