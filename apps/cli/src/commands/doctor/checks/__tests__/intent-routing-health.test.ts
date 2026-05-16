/**
 * Story 108-B-04 — Intent-routing health doctor check tests.
 *
 * Axes covered:
 *   G — Doctor miss-rate calculation: 10/100-event window, 30% miss, capped at 100.
 *   H — Doctor no-file state: renders "Telemetry not enabled" without crash.
 *
 * Also covers:
 *   AC-3 contract: `assignee doctor` includes "Intent routing miss-rate" line.
 *   AC-4 contract: without opt-in, shows "Telemetry not enabled".
 */

import { describe, it, expect } from "vitest";
import {
  checkIntentRoutingHealth,
  parseRoutingEvents,
  computeMissRate,
  MAX_EVENTS,
} from "../intent-routing-health.js";
import type { IntentRoutingEvent } from "@assignee/core/telemetry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  classifierPath: IntentRoutingEvent["classifierPath"],
): IntentRoutingEvent {
  return {
    eventType: "intent-routing",
    timestamp: new Date().toISOString(),
    classifierPath,
    patternKey: null,
    resourceType: null,
    durationMs: 10,
  };
}

function makeJsonl(events: IntentRoutingEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// parseRoutingEvents tests
// ---------------------------------------------------------------------------

describe("parseRoutingEvents", () => {
  it("parses valid JSONL and filters to intent-routing events only", () => {
    const events = [makeEvent("keyword"), makeEvent("unsupported")];
    const content = makeJsonl(events);
    const parsed = parseRoutingEvents(content, 100);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.classifierPath).toBe("keyword");
    expect(parsed[1]!.classifierPath).toBe("unsupported");
  });

  it("skips malformed JSON lines without throwing", () => {
    const content = [
      JSON.stringify(makeEvent("keyword")),
      "this is not json",
      JSON.stringify(makeEvent("llm-primary")),
    ].join("\n");

    const parsed = parseRoutingEvents(content, 100);
    expect(parsed).toHaveLength(2);
  });

  it("skips non-intent-routing events", () => {
    const content = [
      JSON.stringify({ eventType: "something-else", data: 1 }),
      JSON.stringify(makeEvent("keyword")),
    ].join("\n");

    const parsed = parseRoutingEvents(content, 100);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.classifierPath).toBe("keyword");
  });

  it("handles empty content", () => {
    expect(parseRoutingEvents("", 100)).toHaveLength(0);
    expect(parseRoutingEvents("   \n  \n", 100)).toHaveLength(0);
  });

  it("caps the window to the last maxEvents entries (Axis G — 150 → last 100)", () => {
    // Build 150 events: first 50 keyword, last 100 unsupported.
    const events = [
      ...Array.from({ length: 50 }, () => makeEvent("keyword")),
      ...Array.from({ length: 100 }, () => makeEvent("unsupported")),
    ];
    const content = makeJsonl(events);

    const parsed = parseRoutingEvents(content, MAX_EVENTS);
    expect(parsed).toHaveLength(100);
    // All 100 retained should be "unsupported" (the tail).
    expect(parsed.every((e) => e.classifierPath === "unsupported")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeMissRate tests
// ---------------------------------------------------------------------------

describe("computeMissRate", () => {
  it("returns null for an empty event list", () => {
    expect(computeMissRate([])).toBeNull();
  });

  it("returns '0.0' when no unsupported events", () => {
    const events = Array.from({ length: 10 }, () => makeEvent("keyword"));
    expect(computeMissRate(events)).toBe("0.0");
  });

  it("returns '30.0' for 3 unsupported out of 10 (Axis G)", () => {
    const events = [
      ...Array.from({ length: 7 }, () => makeEvent("keyword")),
      ...Array.from({ length: 3 }, () => makeEvent("unsupported")),
    ];
    expect(computeMissRate(events)).toBe("30.0");
  });

  it("returns '100.0' when all events are unsupported", () => {
    const events = Array.from({ length: 5 }, () => makeEvent("unsupported"));
    expect(computeMissRate(events)).toBe("100.0");
  });
});

// ---------------------------------------------------------------------------
// checkIntentRoutingHealth integration tests
// ---------------------------------------------------------------------------

describe("checkIntentRoutingHealth", () => {
  // ── Axis H — Doctor no-file state ─────────────────────────────────────────

  it("Axis H: renders 'Telemetry not enabled' when log file does not exist (ok status)", () => {
    const section = checkIntentRoutingHealth({
      exists: (_path) => false,
    });

    expect(section.name).toBe("Intent routing");
    expect(section.status).toBe("ok");
    expect(section.subs).toHaveLength(1);
    expect(section.subs[0]!.detail).toContain("Telemetry not enabled");
  });

  it("Axis H: does NOT crash when file does not exist", () => {
    expect(() =>
      checkIntentRoutingHealth({ exists: () => false }),
    ).not.toThrow();
  });

  // ── Axis G — Miss-rate calculation ───────────────────────────────────────

  it("Axis G: renders '30.0%' for 7 keyword + 3 unsupported events (10 total)", () => {
    const events = [
      ...Array.from({ length: 7 }, () => makeEvent("keyword")),
      ...Array.from({ length: 3 }, () => makeEvent("unsupported")),
    ];
    const content = makeJsonl(events);

    const section = checkIntentRoutingHealth({
      exists: () => true,
      readFile: () => content,
    });

    expect(section.subs[0]!.detail).toContain("30.0%");
    expect(section.subs[0]!.detail).toContain("10 events");
    expect(section.status).toBe("warn"); // ≥ 10% threshold
  });

  it("Axis G: uses only the last 100 events when file has 150 (window cap)", () => {
    // First 50 keyword, last 100 unsupported → 100% miss-rate in window.
    const events = [
      ...Array.from({ length: 50 }, () => makeEvent("keyword")),
      ...Array.from({ length: 100 }, () => makeEvent("unsupported")),
    ];
    const content = makeJsonl(events);

    const section = checkIntentRoutingHealth({
      exists: () => true,
      readFile: () => content,
    });

    // Window is capped at 100 — only the 100 unsupported events are used.
    expect(section.subs[0]!.detail).toContain("100 events");
    expect(section.subs[0]!.detail).toContain("100.0%");
  });

  it("renders 'ok' when miss-rate is 0%", () => {
    const events = Array.from({ length: 10 }, () => makeEvent("keyword"));
    const content = makeJsonl(events);

    const section = checkIntentRoutingHealth({
      exists: () => true,
      readFile: () => content,
    });

    expect(section.status).toBe("ok");
    expect(section.subs[0]!.detail).toContain("0.0%");
  });

  it("renders 'warn' when miss-rate is exactly 10%", () => {
    const events = [
      ...Array.from({ length: 9 }, () => makeEvent("keyword")),
      makeEvent("unsupported"),
    ];
    const content = makeJsonl(events);

    const section = checkIntentRoutingHealth({
      exists: () => true,
      readFile: () => content,
    });

    expect(section.status).toBe("warn");
    expect(section.subs[0]!.detail).toContain("10.0%");
  });

  it("renders 'ok' when miss-rate is below 10% (9%)", () => {
    // 9/100 = 9.0%
    const events = [
      ...Array.from({ length: 91 }, () => makeEvent("keyword")),
      ...Array.from({ length: 9 }, () => makeEvent("unsupported")),
    ];
    const content = makeJsonl(events);

    const section = checkIntentRoutingHealth({
      exists: () => true,
      readFile: () => content,
    });

    expect(section.status).toBe("ok");
  });

  it("renders 'No routing data available' when file has no valid intent-routing events", () => {
    const content = [
      JSON.stringify({ eventType: "other", ts: "2026-05-16" }),
      "bad json line",
    ].join("\n");

    const section = checkIntentRoutingHealth({
      exists: () => true,
      readFile: () => content,
    });

    expect(section.status).toBe("ok");
    expect(section.subs[0]!.detail).toContain("No routing data available");
  });

  it("renders 'warn' with error message when readFile throws", () => {
    const section = checkIntentRoutingHealth({
      exists: () => true,
      readFile: () => {
        throw new Error("EACCES: permission denied");
      },
    });

    expect(section.status).toBe("warn");
    expect(section.subs[0]!.detail).toContain("EACCES");
  });

  // ── AC-3 contract ─────────────────────────────────────────────────────────

  it("AC-3: section name is 'Intent routing' (surfaced in assignee doctor output)", () => {
    const section = checkIntentRoutingHealth({ exists: () => false });
    expect(section.name).toBe("Intent routing");
  });

  it("AC-3: sub-check detail contains 'miss-rate' when routing data present", () => {
    const events = Array.from({ length: 5 }, () => makeEvent("keyword"));
    const section = checkIntentRoutingHealth({
      exists: () => true,
      readFile: () => makeJsonl(events),
    });
    expect(section.subs[0]!.label).toContain("miss-rate");
  });

  // ── AC-4 contract ─────────────────────────────────────────────────────────

  it("AC-4: shows 'Telemetry not enabled' message when file is absent", () => {
    const section = checkIntentRoutingHealth({ exists: () => false });
    expect(section.subs[0]!.detail).toContain("Telemetry not enabled");
    expect(section.subs[0]!.detail).toContain(
      "ASSIGNEE_TELEMETRY_ADAPTER=local",
    );
  });
});
