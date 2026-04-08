/**
 * Tests for the OTLP/HTTP-JSON log exporter.
 *
 * @see otel-exporter.ts — closes M-6.4 from the post-Wave-20 NFR re-score
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isOtelEnabled,
  getOtelEndpoint,
  getOtelServiceName,
  buildOtlpPayload,
  exportLogEvent,
  DEFAULT_OTEL_SERVICE_NAME,
  OTLP_LOGS_PATH,
} from "./otel-exporter.js";
import type { LogEvent } from "../utils/logger.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env["ASSIGNEE_OTEL_ENDPOINT"];
  delete process.env["ASSIGNEE_OTEL_SERVICE_NAME"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

// ── Activation gate ─────────────────────────────────────────────────────────

describe("OTEL exporter activation", () => {
  it("isOtelEnabled() = false when ASSIGNEE_OTEL_ENDPOINT is unset", () => {
    expect(isOtelEnabled()).toBe(false);
    expect(getOtelEndpoint()).toBeUndefined();
  });

  it("isOtelEnabled() = false when ASSIGNEE_OTEL_ENDPOINT is empty/whitespace", () => {
    process.env["ASSIGNEE_OTEL_ENDPOINT"] = "";
    expect(isOtelEnabled()).toBe(false);
    process.env["ASSIGNEE_OTEL_ENDPOINT"] = "   ";
    expect(isOtelEnabled()).toBe(false);
  });

  it("isOtelEnabled() = true when ASSIGNEE_OTEL_ENDPOINT is a real URL", () => {
    process.env["ASSIGNEE_OTEL_ENDPOINT"] = "http://localhost:4318";
    expect(isOtelEnabled()).toBe(true);
    expect(getOtelEndpoint()).toBe("http://localhost:4318");
  });

  it("getOtelEndpoint() trims surrounding whitespace", () => {
    process.env["ASSIGNEE_OTEL_ENDPOINT"] = "  https://otel.example.com  ";
    expect(getOtelEndpoint()).toBe("https://otel.example.com");
  });

  it("getOtelServiceName() defaults to DEFAULT_OTEL_SERVICE_NAME when unset", () => {
    expect(getOtelServiceName()).toBe(DEFAULT_OTEL_SERVICE_NAME);
    expect(DEFAULT_OTEL_SERVICE_NAME).toBe("assignee-cli");
  });

  it("getOtelServiceName() honors ASSIGNEE_OTEL_SERVICE_NAME", () => {
    process.env["ASSIGNEE_OTEL_SERVICE_NAME"] = "my-service";
    expect(getOtelServiceName()).toBe("my-service");
  });

  it("getOtelServiceName() falls back to default for empty/whitespace", () => {
    process.env["ASSIGNEE_OTEL_SERVICE_NAME"] = "";
    expect(getOtelServiceName()).toBe(DEFAULT_OTEL_SERVICE_NAME);
    process.env["ASSIGNEE_OTEL_SERVICE_NAME"] = "   ";
    expect(getOtelServiceName()).toBe(DEFAULT_OTEL_SERVICE_NAME);
  });
});

// ── Payload construction ───────────────────────────────────────────────────

describe("buildOtlpPayload", () => {
  const baseEvent: LogEvent = {
    ts: "2026-04-08T12:34:56.789Z",
    runId: "11111111-2222-3333-4444-555555555555",
    level: "info",
    action: "plan_complete",
  };

  it("produces OTLP/HTTP shape with service.name resource attribute", () => {
    const payload = buildOtlpPayload(baseEvent, "assignee-cli");
    const resource = payload.resourceLogs[0].resource;
    expect(resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "assignee-cli" },
    });
  });

  it("uses 'assignee.cli' as the instrumentation scope name", () => {
    const payload = buildOtlpPayload(baseEvent, "assignee-cli");
    expect(payload.resourceLogs[0].scopeLogs[0].scope.name).toBe(
      "assignee.cli",
    );
  });

  it("converts ISO timestamp to nanoseconds-since-epoch string", () => {
    const payload = buildOtlpPayload(baseEvent, "assignee-cli");
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0]!;
    // Compute the expected nanoseconds from the same parse path the
    // exporter uses, so the assertion stays correct independent of the
    // host's interpretation of the ISO string.
    const expectedNs = String(BigInt(Date.parse(baseEvent.ts)) * 1_000_000n);
    expect(record.timeUnixNano).toBe(expectedNs);
    // Sanity: should also be a string of digits with no decimal/sign.
    expect(record.timeUnixNano).toMatch(/^\d+$/);
  });

  it("falls back to Date.now when ts is unparseable", () => {
    const broken: LogEvent = { ...baseEvent, ts: "not-a-date" };
    const payload = buildOtlpPayload(broken, "assignee-cli");
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0]!;
    // Must be a valid uint64-shaped string of digits
    expect(record.timeUnixNano).toMatch(/^\d+$/);
  });

  it.each([
    ["info", 9, "INFO"],
    ["warn", 13, "WARN"],
    ["error", 17, "ERROR"],
  ] as const)(
    "maps level=%s to severityNumber=%d / severityText=%s",
    (level, expectedNumber, expectedText) => {
      const payload = buildOtlpPayload({ ...baseEvent, level }, "assignee-cli");
      const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0]!;
      expect(record.severityNumber).toBe(expectedNumber);
      expect(record.severityText).toBe(expectedText);
    },
  );

  it("emits runId and action as required attributes", () => {
    const payload = buildOtlpPayload(baseEvent, "assignee-cli");
    const attrs =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0]!.attributes;
    expect(attrs).toContainEqual({
      key: "runId",
      value: { stringValue: baseEvent.runId },
    });
    expect(attrs).toContainEqual({
      key: "action",
      value: { stringValue: "plan_complete" },
    });
  });

  it("emits durationMs as doubleValue when present", () => {
    const payload = buildOtlpPayload(
      { ...baseEvent, durationMs: 1234.5 },
      "assignee-cli",
    );
    const attrs =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0]!.attributes;
    expect(attrs).toContainEqual({
      key: "durationMs",
      value: { doubleValue: 1234.5 },
    });
  });

  it("omits durationMs attribute when undefined", () => {
    const payload = buildOtlpPayload(baseEvent, "assignee-cli");
    const attrs =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0]!.attributes;
    expect(attrs.find((a) => a.key === "durationMs")).toBeUndefined();
  });

  it("emits result as stringValue when present", () => {
    const payload = buildOtlpPayload(
      { ...baseEvent, result: "success" },
      "assignee-cli",
    );
    const attrs =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0]!.attributes;
    expect(attrs).toContainEqual({
      key: "result",
      value: { stringValue: "success" },
    });
  });

  it("dispatches extras by JS type — string/number/boolean/null/object", () => {
    const payload = buildOtlpPayload(
      {
        ...baseEvent,
        extras: {
          stringExtra: "hello",
          intExtra: 42,
          floatExtra: 3.14,
          boolExtra: true,
          nullExtra: null,
          objExtra: { nested: "value" },
          arrExtra: [1, 2, 3],
        },
      },
      "assignee-cli",
    );
    const attrs =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0]!.attributes;

    expect(attrs).toContainEqual({
      key: "stringExtra",
      value: { stringValue: "hello" },
    });
    expect(attrs).toContainEqual({
      key: "intExtra",
      value: { doubleValue: 42 },
    });
    expect(attrs).toContainEqual({
      key: "floatExtra",
      value: { doubleValue: 3.14 },
    });
    expect(attrs).toContainEqual({
      key: "boolExtra",
      value: { boolValue: true },
    });
    expect(attrs).toContainEqual({
      key: "nullExtra",
      value: { stringValue: "" },
    });
    expect(attrs).toContainEqual({
      key: "objExtra",
      value: { stringValue: '{"nested":"value"}' },
    });
    expect(attrs).toContainEqual({
      key: "arrExtra",
      value: { stringValue: "[1,2,3]" },
    });
  });

  it("emits the action as the body stringValue (so collectors can filter without unpacking attributes)", () => {
    const payload = buildOtlpPayload(baseEvent, "assignee-cli");
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0]!;
    expect(record.body).toEqual({ stringValue: "plan_complete" });
  });

  it("survives extras with circular references", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;
    expect(() =>
      buildOtlpPayload(
        { ...baseEvent, extras: { loop: circular } },
        "assignee-cli",
      ),
    ).not.toThrow();
    const payload = buildOtlpPayload(
      { ...baseEvent, extras: { loop: circular } },
      "assignee-cli",
    );
    const attrs =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0]!.attributes;
    const loopAttr = attrs.find((a) => a.key === "loop");
    expect(loopAttr?.value.stringValue).toBe("[unserializable]");
  });
});

// ── Export hot path ─────────────────────────────────────────────────────────

describe("exportLogEvent", () => {
  const event: LogEvent = {
    ts: "2026-04-08T12:34:56.789Z",
    runId: "11111111-2222-3333-4444-555555555555",
    level: "info",
    action: "plan_complete",
  };

  it("is a no-op (zero fetch calls) when ASSIGNEE_OTEL_ENDPOINT is unset", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await exportLogEvent(event);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs OTLP JSON to <endpoint>/v1/logs when enabled", async () => {
    process.env["ASSIGNEE_OTEL_ENDPOINT"] = "http://collector.local:4318";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await exportLogEvent(event);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://collector.local:4318" + OTLP_LOGS_PATH);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    // Body must be valid JSON containing the runId.
    const parsed = JSON.parse(init?.body as string);
    expect(
      parsed.resourceLogs[0].scopeLogs[0].logRecords[0].attributes,
    ).toContainEqual({
      key: "runId",
      value: { stringValue: event.runId },
    });
  });

  it("strips a single trailing slash from the endpoint", async () => {
    process.env["ASSIGNEE_OTEL_ENDPOINT"] = "http://localhost:4318/";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await exportLogEvent(event);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:4318/v1/logs");
  });

  it("swallows fetch rejection silently — never throws to the caller", async () => {
    process.env["ASSIGNEE_OTEL_ENDPOINT"] = "http://collector.local:4318";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(exportLogEvent(event)).resolves.toBeUndefined();
  });

  it("swallows non-2xx responses silently (collector may reject schema)", async () => {
    process.env["ASSIGNEE_OTEL_ENDPOINT"] = "http://collector.local:4318";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("schema error", { status: 400 }),
    );
    await expect(exportLogEvent(event)).resolves.toBeUndefined();
  });

  it("aborts the request after the timeout window so a slow collector cannot stall the CLI", async () => {
    process.env["ASSIGNEE_OTEL_ENDPOINT"] = "http://collector.local:4318";

    // Stall fetch indefinitely until the AbortController fires.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, init) => {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      });

    // The exporter swallows the rejection — `await` should still resolve.
    await expect(exportLogEvent(event)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
