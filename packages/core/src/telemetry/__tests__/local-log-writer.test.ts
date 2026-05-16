/**
 * Story 108-B-04 — Local JSONL log writer tests.
 *
 * Axes covered:
 *   E — Telemetry disabled: no file created when ASSIGNEE_TELEMETRY_ADAPTER unset.
 *   F — Log persistence: two sequential writes produce two JSONL lines.
 *   I — Write error resilience: mock appendFile throw → result still returned;
 *       debug-level log entry emitted, NOT an ERROR-level crash.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as loggerModule from "../../utils/logger/index.js";
import {
  appendRoutingEvent,
  isTelemetryEnabled,
  resolveTelemetryLogPath,
  TELEMETRY_ADAPTER_ENV,
  LOCAL_ADAPTER_VALUE,
  TELEMETRY_LOG_FILENAME,
} from "../local-log-writer.js";
import type { IntentRoutingEvent } from "../telemetry-event-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "assignee-test-telemetry-"));
}

function makeEvent(
  classifierPath: IntentRoutingEvent["classifierPath"] = "keyword",
): IntentRoutingEvent {
  return {
    eventType: "intent-routing",
    timestamp: new Date().toISOString(),
    classifierPath,
    patternKey: classifierPath === "keyword" ? "sqs-with-dlq" : null,
    resourceType: classifierPath === "llm-primary" ? "AWS::S3::Bucket" : null,
    durationMs: 42,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isTelemetryEnabled", () => {
  afterEach(() => {
    delete process.env[TELEMETRY_ADAPTER_ENV];
  });

  it("returns false when env var is unset", () => {
    delete process.env[TELEMETRY_ADAPTER_ENV];
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("returns true when ASSIGNEE_TELEMETRY_ADAPTER=local", () => {
    process.env[TELEMETRY_ADAPTER_ENV] = LOCAL_ADAPTER_VALUE;
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("returns false when ASSIGNEE_TELEMETRY_ADAPTER is any other value", () => {
    process.env[TELEMETRY_ADAPTER_ENV] = "otel";
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe("resolveTelemetryLogPath", () => {
  it("uses the override dir when provided", () => {
    const logPath = resolveTelemetryLogPath("/tmp/my-assignee");
    expect(logPath).toBe(join("/tmp/my-assignee", TELEMETRY_LOG_FILENAME));
  });
});

describe("appendRoutingEvent — Axis E (telemetry disabled)", () => {
  afterEach(() => {
    delete process.env[TELEMETRY_ADAPTER_ENV];
  });

  it("is a no-op and creates no file when telemetry is disabled", async () => {
    delete process.env[TELEMETRY_ADAPTER_ENV];
    const tmpDir = makeTempDir();

    try {
      await appendRoutingEvent(makeEvent(), "run-1", tmpDir);

      const logPath = join(tmpDir, TELEMETRY_LOG_FILENAME);
      expect(existsSync(logPath)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("appendRoutingEvent — Axis F (log persistence)", () => {
  afterEach(() => {
    delete process.env[TELEMETRY_ADAPTER_ENV];
  });

  it("appends two distinct events across two invocations (both survive)", async () => {
    process.env[TELEMETRY_ADAPTER_ENV] = LOCAL_ADAPTER_VALUE;
    const tmpDir = makeTempDir();

    try {
      const event1 = makeEvent("keyword");
      const event2 = makeEvent("llm-primary");

      // Simulate two separate process invocations.
      await appendRoutingEvent(event1, "run-1", tmpDir);
      await appendRoutingEvent(event2, "run-2", tmpDir);

      const logPath = join(tmpDir, TELEMETRY_LOG_FILENAME);
      expect(existsSync(logPath)).toBe(true);

      const content = readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      expect(lines).toHaveLength(2);

      const parsed1 = JSON.parse(lines[0]!) as IntentRoutingEvent;
      const parsed2 = JSON.parse(lines[1]!) as IntentRoutingEvent;

      expect(parsed1.classifierPath).toBe("keyword");
      expect(parsed2.classifierPath).toBe("llm-primary");
    } finally {
      delete process.env[TELEMETRY_ADAPTER_ENV];
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates the assignee directory when it does not exist", async () => {
    process.env[TELEMETRY_ADAPTER_ENV] = LOCAL_ADAPTER_VALUE;
    const tmpDir = makeTempDir();
    const nestedDir = join(tmpDir, "nested", ".assignee");

    try {
      await appendRoutingEvent(makeEvent(), "run-1", nestedDir);

      const logPath = join(nestedDir, TELEMETRY_LOG_FILENAME);
      expect(existsSync(logPath)).toBe(true);
    } finally {
      delete process.env[TELEMETRY_ADAPTER_ENV];
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("appendRoutingEvent — Axis I (write error resilience)", () => {
  let logSpy: MockInstance;

  beforeEach(() => {
    logSpy = vi.spyOn(loggerModule, "log");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[TELEMETRY_ADAPTER_ENV];
  });

  it("does NOT throw when fsAppend throws; emits debug log instead", async () => {
    process.env[TELEMETRY_ADAPTER_ENV] = LOCAL_ADAPTER_VALUE;

    const throwingAppend = async (_path: string, _data: string) => {
      throw new Error("ENOSPC: no space left on device");
    };
    const noopMkdir = async () => undefined;

    // Must not throw — the error is swallowed.
    await expect(
      appendRoutingEvent(
        makeEvent(),
        "run-1",
        "/tmp/assignee",
        throwingAppend,
        noopMkdir,
      ),
    ).resolves.toBeUndefined();

    // A debug-level log entry must be emitted.
    expect(logSpy).toHaveBeenCalledOnce();
    const [logEvent] = logSpy.mock.calls[0] as [
      Parameters<typeof loggerModule.log>[0],
    ];
    expect(logEvent.level).toBe("debug");
    expect(logEvent.extras?.["error"]).toContain("ENOSPC");
  });

  it("does NOT throw when fsMkdir throws; emits debug log instead", async () => {
    process.env[TELEMETRY_ADAPTER_ENV] = LOCAL_ADAPTER_VALUE;

    const throwingMkdir = async () => {
      throw new Error("EACCES: permission denied");
    };

    await expect(
      appendRoutingEvent(
        makeEvent(),
        "run-1",
        "/tmp/assignee",
        undefined,
        throwingMkdir,
      ),
    ).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledOnce();
    const [logEvent] = logSpy.mock.calls[0] as [
      Parameters<typeof loggerModule.log>[0],
    ];
    expect(logEvent.level).toBe("debug");
  });
});
