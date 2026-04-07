import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { log, LOG_ACTIONS } from "./logger.js";
import type { LogEvent } from "./logger.js";

describe("logger", () => {
  let stderrSpy: MockInstance;
  let tmpLogDir: string;
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    tmpLogDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "assignee-logger-test-"),
    );
    process.env["ASSIGNEE_LOG_DIR"] = tmpLogDir;
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    process.argv = originalArgv;
    process.env = { ...originalEnv };
    try {
      await fs.rm(tmpLogDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function readLogFile(): Promise<string[]> {
    const entries = await fs.readdir(tmpLogDir);
    const jsonl = entries.filter(
      (e) => e.startsWith("cli-") && e.endsWith(".jsonl"),
    );
    if (jsonl.length === 0) return [];
    const contents = await fs.readFile(
      path.join(tmpLogDir, jsonl[0]!),
      "utf-8",
    );
    return contents.split("\n").filter((l) => l.length > 0);
  }

  it("writes valid JSON to stderr when --verbose is set", () => {
    process.argv = [...originalArgv, "--verbose"];

    const event: LogEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      runId: "00000000-0000-0000-0000-000000000001",
      level: "info",
      action: LOG_ACTIONS.PLAN_STARTED,
    };

    log(event);

    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it("outputs all required LogEvent fields", () => {
    process.argv = [...originalArgv, "--verbose"];

    const event: LogEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      runId: "00000000-0000-0000-0000-000000000002",
      level: "error",
      action: LOG_ACTIONS.APPLY_FAILED,
      durationMs: 1240,
      result: "FAILED",
    };

    log(event);

    const written = stderrSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written) as Record<string, unknown>;

    expect(parsed["ts"]).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed["runId"]).toBe("00000000-0000-0000-0000-000000000002");
    expect(parsed["level"]).toBe("error");
    expect(parsed["action"]).toBe("apply_failed");
    expect(parsed["durationMs"]).toBe(1240);
    expect(parsed["result"]).toBe("FAILED");
  });

  it("writes single-line JSON (no pretty-printing)", () => {
    process.argv = [...originalArgv, "--verbose"];

    const event: LogEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      runId: "00000000-0000-0000-0000-000000000003",
      level: "info",
      action: LOG_ACTIONS.SCHEMA_FETCHED,
    };

    log(event);

    const written = stderrSpy.mock.calls[0]?.[0] as string;
    // Should be exactly one line (JSON + newline)
    const lines = written.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("suppresses logs when --verbose is not set", () => {
    // No --verbose flag, no env var — logs should be suppressed
    delete process.env["ASSIGNEE_VERBOSITY"];
    delete process.env["ASSIGNEE_LOG_LEVEL"];

    const event: LogEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      runId: "00000000-0000-0000-0000-000000000004",
      level: "info",
      action: LOG_ACTIONS.PLAN_STARTED,
    };

    log(event);

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("emits logs when ASSIGNEE_VERBOSITY=verbose", () => {
    process.env["ASSIGNEE_VERBOSITY"] = "verbose";

    const event: LogEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      runId: "00000000-0000-0000-0000-000000000005",
      level: "info",
      action: LOG_ACTIONS.PLAN_STARTED,
    };

    log(event);

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it("emits logs when ASSIGNEE_LOG_LEVEL=debug", () => {
    process.env["ASSIGNEE_LOG_LEVEL"] = "debug";

    const event: LogEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      runId: "00000000-0000-0000-0000-000000000006",
      level: "info",
      action: LOG_ACTIONS.PLAN_STARTED,
    };

    log(event);

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it("suppresses logs when ASSIGNEE_VERBOSITY=normal", () => {
    process.env["ASSIGNEE_VERBOSITY"] = "normal";
    delete process.env["ASSIGNEE_LOG_LEVEL"];

    const event: LogEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      runId: "00000000-0000-0000-0000-000000000007",
      level: "info",
      action: LOG_ACTIONS.PLAN_STARTED,
    };

    log(event);

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("persists error events to file even without --verbose (H19)", async () => {
    // No verbose flag — stderr should NOT be called but the file SHOULD exist.
    delete process.env["ASSIGNEE_VERBOSITY"];
    delete process.env["ASSIGNEE_LOG_LEVEL"];

    const event: LogEvent = {
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440000",
      level: "error",
      action: LOG_ACTIONS.APPLY_FAILED,
      extras: { awsAccountId: "123456789012", resourceType: "AWS::S3::Bucket" },
    };

    log(event);

    // stderr not touched — no verbose
    expect(stderrSpy).not.toHaveBeenCalled();

    // File contains exactly one JSON line with our event
    const lines = await readLogFile();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as LogEvent;
    expect(parsed.level).toBe("error");
    expect(parsed.action).toBe("apply_failed");
    expect(parsed.runId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect((parsed.extras as Record<string, unknown>)["awsAccountId"]).toBe(
      "123456789012",
    );
  });

  it("persists warn events to file even without --verbose", async () => {
    delete process.env["ASSIGNEE_VERBOSITY"];
    delete process.env["ASSIGNEE_LOG_LEVEL"];

    const event: LogEvent = {
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440001",
      level: "warn",
      action: LOG_ACTIONS.MCP_OPTIONAL_INIT_FAILED,
    };

    log(event);

    expect(stderrSpy).not.toHaveBeenCalled();
    const lines = await readLogFile();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as LogEvent;
    expect(parsed.level).toBe("warn");
  });

  it("does NOT persist info events to file", async () => {
    delete process.env["ASSIGNEE_VERBOSITY"];
    delete process.env["ASSIGNEE_LOG_LEVEL"];

    const event: LogEvent = {
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440002",
      level: "info",
      action: LOG_ACTIONS.PLAN_STARTED,
    };

    log(event);

    expect(stderrSpy).not.toHaveBeenCalled();
    // No log file should have been created for info events
    const entries = await fs.readdir(tmpLogDir);
    expect(entries.filter((e) => e.endsWith(".jsonl"))).toHaveLength(0);
  });

  it("verbose mode still emits info events to stderr", () => {
    process.argv = [...originalArgv, "--verbose"];

    const event: LogEvent = {
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440003",
      level: "info",
      action: LOG_ACTIONS.SCHEMA_FETCHED,
    };

    log(event);

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it("verbose mode emits error events BOTH to stderr and to file", async () => {
    process.argv = [...originalArgv, "--verbose"];

    const event: LogEvent = {
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440004",
      level: "error",
      action: LOG_ACTIONS.APPLY_FAILED,
    };

    log(event);

    expect(stderrSpy).toHaveBeenCalledOnce();
    const lines = await readLogFile();
    expect(lines).toHaveLength(1);
  });

  it("persists log file with mode 0o600 and dir mode 0o700", async () => {
    delete process.env["ASSIGNEE_VERBOSITY"];

    log({
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440005",
      level: "error",
      action: LOG_ACTIONS.APPLY_FAILED,
    });

    const entries = fsSync.readdirSync(tmpLogDir);
    const jsonl = entries.find(
      (e) => e.startsWith("cli-") && e.endsWith(".jsonl"),
    );
    expect(jsonl).toBeDefined();
    const filePath = path.join(tmpLogDir, jsonl!);
    const mode = fsSync.statSync(filePath).mode & 0o777;
    // On macOS/Linux we expect 0o600. Skip strict check on Windows (non-POSIX).
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  it("appends multiple events to the same daily file", async () => {
    delete process.env["ASSIGNEE_VERBOSITY"];

    for (let i = 0; i < 3; i++) {
      log({
        ts: "2026-04-06T12:00:00.000Z",
        runId: `550e8400-e29b-41d4-a716-44665544000${i}`,
        level: "warn",
        action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      });
    }

    const lines = await readLogFile();
    expect(lines).toHaveLength(3);
  });

  it("falls back to stderr without crashing when log directory is unwritable", () => {
    // Point ASSIGNEE_LOG_DIR at a file path — mkdir will fail because the
    // parent path is a file, not a directory.
    const blockingFile = path.join(tmpLogDir, "blocker");
    fsSync.writeFileSync(blockingFile, "not a directory");
    process.env["ASSIGNEE_LOG_DIR"] = path.join(blockingFile, "nested", "logs");

    expect(() =>
      log({
        ts: "2026-04-06T12:00:00.000Z",
        runId: "550e8400-e29b-41d4-a716-446655440099",
        level: "error",
        action: LOG_ACTIONS.APPLY_FAILED,
      }),
    ).not.toThrow();

    // Fallback should have written the event to stderr
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls[
      stderrSpy.mock.calls.length - 1
    ]?.[0] as string;
    expect(written).toContain("apply_failed");
    expect(written).toContain("persistentLogFallback");
  });

  it("LOG_ACTIONS contains expected action names", () => {
    expect(LOG_ACTIONS.PLAN_STARTED).toBe("plan_started");
    expect(LOG_ACTIONS.APPLY_SUCCEEDED).toBe("apply_succeeded");
    expect(LOG_ACTIONS.APPLY_FAILED).toBe("apply_failed");
    expect(LOG_ACTIONS.PLAN_REJECTED).toBe("plan_rejected_by_user");
  });
});
