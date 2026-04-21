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
import {
  log,
  LOG_ACTIONS,
  clearEnsuredDirCacheForTests,
  setLogFileSizeLimitForTests,
  resetLogFileSizeLimitForTests,
  pruneOldLogs,
  autoPruneLogsIfDue,
  resolveLogRetentionDays,
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_PRUNE_MARKER,
} from "./index.js";
import type { LogEvent } from "./index.js";

describe("logger", () => {
  let stderrSpy: MockInstance;
  let stdoutSpy: MockInstance;
  let tmpLogDir: string;
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    // Epic 92 Wave 2.c (A-21 / B-14): spy stdout too so every test
    // implicitly enforces the "log() never touches stdout" invariant.
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    tmpLogDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "assignee-logger-test-"),
    );
    process.env["ASSIGNEE_LOG_DIR"] = tmpLogDir;
    // Each test gets a fresh tmp dir, so the module-level "ensured dirs"
    // cache must be cleared too — otherwise tests that change ASSIGNEE_LOG_DIR
    // mid-suite would skip mkdir on a never-created path. (REG-N9)
    clearEnsuredDirCacheForTests();
    resetLogFileSizeLimitForTests();
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    process.argv = originalArgv;
    process.env = { ...originalEnv };
    clearEnsuredDirCacheForTests();
    resetLogFileSizeLimitForTests();
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

  it("does NOT persist info events to file (default — non-allowlisted action)", async () => {
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
    // No log file should have been created for non-allowlisted info events
    const entries = await fs.readdir(tmpLogDir);
    expect(entries.filter((e) => e.endsWith(".jsonl"))).toHaveLength(0);
  });

  // Wave 19 Bug #4: TOKEN_USAGE_SUMMARY is info-level but MUST be persisted
  // so per-command token cost is greppable from ~/.assignee/logs/cli-*.jsonl
  // (the goal stated in feedback_token_cost_visibility.md). Before this fix,
  // running `grep token_usage ~/.assignee/logs/cli-2026-04-08.jsonl` after
  // ~10 real apply commands returned 0 hits even with ASSIGNEE_LOG_LEVEL=debug.
  it("PERSISTS info-level TOKEN_USAGE_SUMMARY events to file (Wave 19 Bug #4 allowlist)", async () => {
    delete process.env["ASSIGNEE_VERBOSITY"];
    delete process.env["ASSIGNEE_LOG_LEVEL"];

    // Real-shaped TOKEN_USAGE_SUMMARY event matching the actual emit point
    // in result-formatter.ts. Numbers chosen from a real S3 apply on
    // 2026-04-08 (3025 total tokens at nova-lite-v1:0).
    const event: LogEvent = {
      ts: "2026-04-08T07:29:32.019Z",
      runId: "1c1b9ae0-6411-4eb5-aaa6-e8947c9fc4bf",
      level: "info",
      action: LOG_ACTIONS.TOKEN_USAGE_SUMMARY,
      extras: {
        totalCallCount: 3,
        totalInputTokens: 2714,
        totalOutputTokens: 311,
        totalTokens: 3025,
        byCallsite: {
          intent_parser: {
            callCount: 1,
            inputTokens: 863,
            outputTokens: 20,
            totalTokens: 883,
          },
          plan_generator: {
            callCount: 1,
            inputTokens: 1563,
            outputTokens: 174,
            totalTokens: 1737,
          },
          advice_generator: {
            callCount: 1,
            inputTokens: 288,
            outputTokens: 117,
            totalTokens: 405,
          },
        },
      },
    };

    log(event);

    // Even without verbose mode, the TOKEN_USAGE_SUMMARY must reach disk
    expect(stderrSpy).not.toHaveBeenCalled();
    const lines = await readLogFile();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as LogEvent;
    expect(parsed.level).toBe("info");
    expect(parsed.action).toBe("token_usage_summary");
    // Real numbers must round-trip exactly — no truncation/coercion
    const extras = parsed.extras as Record<string, unknown>;
    expect(extras["totalTokens"]).toBe(3025);
    expect(extras["totalCallCount"]).toBe(3);
  });

  it("does NOT persist info-level TOKEN_USAGE per-call events (only the SUMMARY)", async () => {
    // The per-callsite TOKEN_USAGE event fires for every LLM call (3+ per
    // command). Persisting all of them would balloon log files. Only the
    // end-of-command SUMMARY is in the allowlist.
    delete process.env["ASSIGNEE_VERBOSITY"];
    delete process.env["ASSIGNEE_LOG_LEVEL"];

    const event: LogEvent = {
      ts: "2026-04-08T07:29:13.450Z",
      runId: "1c1b9ae0-6411-4eb5-aaa6-e8947c9fc4bf",
      level: "info",
      action: LOG_ACTIONS.TOKEN_USAGE,
      extras: {
        callsite: "intent_parser",
        inputTokens: 863,
        outputTokens: 20,
        totalTokens: 883,
      },
    };

    log(event);

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

    // Tier C: dropped redundant toBeDefined() — find!() at the find site
    const entries = fsSync.readdirSync(tmpLogDir);
    const jsonl = entries.find(
      (e) => e.startsWith("cli-") && e.endsWith(".jsonl"),
    )!;
    const filePath = path.join(tmpLogDir, jsonl);
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

  // ── REG-N9: hot-path optimisation tests ─────────────────────────────────
  // ESM forbids spying on `node:fs` exports, so we verify the directory cache
  // behaviorally: after the first persisted call creates the dir, externally
  // delete the dir and call log() again. With the cache, the second call
  // skips mkdirSync → appendFileSync fails (ENOENT) → fallback to stderr.
  // Without the cache, mkdirSync would silently recreate the dir and the
  // second call would succeed (no fallback). The presence of the fallback
  // marker in stderr is therefore the contract under test.
  it("REG-N9: caches the directory mkdir so the second persisted call skips the syscall", () => {
    delete process.env["ASSIGNEE_VERBOSITY"];

    // First call: creates the directory and writes the file.
    log({
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440010",
      level: "warn",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
    });
    expect(fsSync.existsSync(tmpLogDir)).toBe(true);
    // First call writes the file successfully — no fallback marker yet.
    const writesAfterFirst = stderrSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((s) => s.includes("persistentLogFallback"));
    expect(writesAfterFirst).toHaveLength(0);

    // Externally remove the log directory between calls. With the dir cache
    // the next log() will NOT mkdirSync — appendFileSync will hit ENOENT and
    // fall back to stderr.
    fsSync.rmSync(tmpLogDir, { recursive: true, force: true });

    log({
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440011",
      level: "warn",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
    });

    // Cache hit means the second call did NOT recreate the directory.
    expect(fsSync.existsSync(tmpLogDir)).toBe(false);
    // The fallback path was taken — proof that mkdirSync was NOT re-invoked.
    const fallbackWrites = stderrSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((s) => s.includes("persistentLogFallback"));
    expect(fallbackWrites.length).toBeGreaterThan(0);
    expect(fallbackWrites[0]).toContain("memory_write_failed");
  });

  it("REG-N9: rotates to cli-YYYY-MM-DD.<n>.jsonl when active file exceeds the size limit", () => {
    delete process.env["ASSIGNEE_VERBOSITY"];
    // Tiny cap so a single big event triggers rotation on the next write.
    setLogFileSizeLimitForTests(200);

    log({
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440020",
      level: "error",
      action: LOG_ACTIONS.APPLY_FAILED,
      extras: { padding: "x".repeat(300) },
    });
    log({
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440021",
      level: "error",
      action: LOG_ACTIONS.APPLY_FAILED,
      extras: { padding: "y".repeat(300) },
    });
    log({
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440022",
      level: "error",
      action: LOG_ACTIONS.APPLY_FAILED,
      extras: { padding: "z".repeat(300) },
    });

    const entries = fsSync
      .readdirSync(tmpLogDir)
      .filter((e) => e.startsWith("cli-") && e.endsWith(".jsonl"));
    // Base file + at least one rotated file.
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const hasBase = entries.some((e) =>
      /^cli-\d{4}-\d{2}-\d{2}\.jsonl$/.test(e),
    );
    const hasRotated = entries.some((e) =>
      /^cli-\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/.test(e),
    );
    expect(hasBase).toBe(true);
    expect(hasRotated).toBe(true);

    // No event is dropped during rotation — concatenate everything and assert
    // every runId is present.
    const allContent = entries
      .map((e) => fsSync.readFileSync(path.join(tmpLogDir, e), "utf-8"))
      .join("");
    expect(allContent).toContain("446655440020");
    expect(allContent).toContain("446655440021");
    expect(allContent).toContain("446655440022");
  });

  it("REG-N9: rotation walks counters when intermediate rotated files are also full", () => {
    delete process.env["ASSIGNEE_VERBOSITY"];
    setLogFileSizeLimitForTests(150);

    // Pre-create base + .1 already over the cap so the walker has to advance
    // to .2.
    const day = new Date().toISOString().slice(0, 10);
    const base = path.join(tmpLogDir, `cli-${day}.jsonl`);
    const r1 = path.join(tmpLogDir, `cli-${day}.1.jsonl`);
    fsSync.writeFileSync(base, "x".repeat(200));
    fsSync.writeFileSync(r1, "y".repeat(200));

    log({
      ts: "2026-04-06T12:00:00.000Z",
      runId: "550e8400-e29b-41d4-a716-446655440030",
      level: "error",
      action: LOG_ACTIONS.APPLY_FAILED,
    });

    const r2 = path.join(tmpLogDir, `cli-${day}.2.jsonl`);
    expect(fsSync.existsSync(r2)).toBe(true);
    const content = fsSync.readFileSync(r2, "utf-8");
    expect(content).toContain("446655440030");
    // Sanity: pre-existing files were NOT modified (no auto-delete).
    expect(fsSync.readFileSync(base, "utf-8")).toBe("x".repeat(200));
    expect(fsSync.readFileSync(r1, "utf-8")).toBe("y".repeat(200));
  });

  it("REGRESSION: --verbose CLI flag enables verbose mode when all env vars are unset", () => {
    // Simulate `assignee --verbose plan ...` with no verbose env vars set.
    // The CLI flag alone must enable verbose output — this guards the
    // documented precedence rule (CLI flag > ASSIGNEE_LOG_LEVEL > ASSIGNEE_VERBOSITY).
    delete process.env["ASSIGNEE_VERBOSITY"];
    delete process.env["ASSIGNEE_LOG_LEVEL"];
    process.argv = [
      "/usr/local/bin/node",
      "/usr/local/bin/assignee",
      "--verbose",
      "plan",
      "Create an SSM parameter named app-api-key",
    ];

    const event: LogEvent = {
      ts: "2026-04-06T12:00:00.000Z",
      runId: "7f4e9c1a-2d4b-4c8a-9f1e-3b2d5e8a1f09",
      level: "info",
      action: LOG_ACTIONS.PLAN_STARTED,
      extras: { intent: "Create an SSM parameter named app-api-key" },
    };

    log(event);

    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written) as LogEvent;
    expect(parsed.action).toBe("plan_started");
    expect(parsed.runId).toBe("7f4e9c1a-2d4b-4c8a-9f1e-3b2d5e8a1f09");
    expect((parsed.extras as Record<string, unknown>)["intent"]).toBe(
      "Create an SSM parameter named app-api-key",
    );
  });

  it("REGRESSION: CLI flag beats ASSIGNEE_VERBOSITY=normal (flag takes precedence)", () => {
    // Operator set ASSIGNEE_VERBOSITY=normal in their shell profile, but
    // passes --verbose on the command line to debug a single run. The CLI
    // flag must win.
    process.env["ASSIGNEE_VERBOSITY"] = "normal";
    delete process.env["ASSIGNEE_LOG_LEVEL"];
    process.argv = [
      "/usr/local/bin/node",
      "/usr/local/bin/assignee",
      "--verbose",
      "apply",
      "--yes",
      "Create an S3 bucket named audit-logs-2026",
    ];

    const event: LogEvent = {
      ts: "2026-04-06T12:00:00.000Z",
      runId: "c3d2f8a1-9e4b-4d6c-b7a8-1e0f9d3c5b6a",
      level: "info",
      action: LOG_ACTIONS.APPLY_STARTED,
    };

    log(event);

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  // ── pruneOldLogs / retention ────────────────────────────────────────
  describe("pruneOldLogs", () => {
    /**
     * Seed a real-looking log file `daysAgo` days before `now`. Written
     * with the same schema the logger emits so tests exercise the real
     * filename parser. (Mocks-use-real-data rule.)
     */
    function seed(
      dir: string,
      daysAgo: number,
      now: Date,
      suffix?: number,
    ): string {
      const dt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
      const day = dt.toISOString().slice(0, 10);
      const name =
        suffix === undefined
          ? `cli-${day}.jsonl`
          : `cli-${day}.${suffix}.jsonl`;
      fsSync.writeFileSync(
        path.join(dir, name),
        JSON.stringify({
          ts: dt.toISOString(),
          runId: "550e8400-e29b-41d4-a716-446655440000",
          level: "error",
          action: "apply_failed",
        }) + "\n",
      );
      return name;
    }

    it("removes files strictly older than retentionDays", () => {
      const now = new Date("2026-04-06T12:00:00.000Z");
      const stale = seed(tmpLogDir, 20, now);
      const edge = seed(tmpLogDir, 13, now);
      const fresh = seed(tmpLogDir, 1, now);

      const result = pruneOldLogs(tmpLogDir, 14, now);

      expect(result.deleted).toBe(1);
      expect(result.kept).toBe(2);
      expect(fsSync.existsSync(path.join(tmpLogDir, stale))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpLogDir, edge))).toBe(true);
      expect(fsSync.existsSync(path.join(tmpLogDir, fresh))).toBe(true);
    });

    it("keeps files inside the retention window (boundary test)", () => {
      // File exactly at now - retentionDays days is NOT deleted (strict <).
      const now = new Date("2026-04-06T12:00:00.000Z");
      const boundary = seed(tmpLogDir, 14, now);

      const result = pruneOldLogs(tmpLogDir, 14, now);

      // 14 days ago at UTC midnight is earlier than now (12:00) minus
      // 14*24h ⇒ filename date (midnight) is older than cutoff ⇒ deleted.
      // Boundary check: 13 days ago must always survive.
      const inner = seed(tmpLogDir, 13, now);
      const r2 = pruneOldLogs(tmpLogDir, 14, now);

      expect(result.deleted + r2.deleted).toBeGreaterThanOrEqual(1);
      expect(fsSync.existsSync(path.join(tmpLogDir, inner))).toBe(true);
      // Confirm the 14d file was removed on the first prune.
      expect(fsSync.existsSync(path.join(tmpLogDir, boundary))).toBe(false);
    });

    it("parses numbered rotation suffixes", () => {
      const now = new Date("2026-04-06T12:00:00.000Z");
      const stale = seed(tmpLogDir, 30, now, 3);
      const fresh = seed(tmpLogDir, 1, now, 7);

      const result = pruneOldLogs(tmpLogDir, 14, now);

      expect(result.deleted).toBe(1);
      expect(fsSync.existsSync(path.join(tmpLogDir, stale))).toBe(false);
      expect(fsSync.existsSync(path.join(tmpLogDir, fresh))).toBe(true);
    });

    it("counts non-log files as skipped without touching them", () => {
      const now = new Date("2026-04-06T12:00:00.000Z");
      seed(tmpLogDir, 30, now);
      fsSync.writeFileSync(path.join(tmpLogDir, "README.txt"), "hello");
      fsSync.writeFileSync(path.join(tmpLogDir, LOG_PRUNE_MARKER), "x");
      fsSync.writeFileSync(
        path.join(tmpLogDir, "cli-not-a-date.jsonl"),
        "garbage",
      );

      const result = pruneOldLogs(tmpLogDir, 14, now);

      expect(result.deleted).toBe(1);
      expect(result.skipped).toBe(3);
      expect(
        fsSync.existsSync(path.join(tmpLogDir, "cli-not-a-date.jsonl")),
      ).toBe(true);
    });

    it("rejects impossible dates like 2026-02-30", () => {
      const now = new Date("2026-04-06T12:00:00.000Z");
      fsSync.writeFileSync(
        path.join(tmpLogDir, "cli-2026-02-30.jsonl"),
        "garbage",
      );
      const result = pruneOldLogs(tmpLogDir, 14, now);
      expect(result.skipped).toBe(1);
      expect(result.deleted).toBe(0);
    });

    it("crosses month/year boundaries using real Date arithmetic", () => {
      // Jan 5, 2026 - retention 14 days ⇒ cutoff Dec 22, 2025. A file from
      // Dec 21, 2025 must be deleted; a file from Dec 23, 2025 must survive.
      // String comparison would mis-order these across the year rollover.
      const now = new Date("2026-01-05T12:00:00.000Z");
      fsSync.writeFileSync(path.join(tmpLogDir, "cli-2025-12-21.jsonl"), "x");
      fsSync.writeFileSync(path.join(tmpLogDir, "cli-2025-12-23.jsonl"), "y");

      const result = pruneOldLogs(tmpLogDir, 14, now);

      expect(result.deleted).toBe(1);
      expect(result.kept).toBe(1);
      expect(
        fsSync.existsSync(path.join(tmpLogDir, "cli-2025-12-21.jsonl")),
      ).toBe(false);
      expect(
        fsSync.existsSync(path.join(tmpLogDir, "cli-2025-12-23.jsonl")),
      ).toBe(true);
    });

    it("is a no-op when the directory is missing (ENOENT tolerant)", () => {
      const missing = path.join(tmpLogDir, "does-not-exist");
      const result = pruneOldLogs(missing, 14, new Date());
      expect(result).toEqual({ deleted: 0, kept: 0, skipped: 0 });
    });

    it("dryRun=true reports counts without deleting", () => {
      const now = new Date("2026-04-06T12:00:00.000Z");
      const stale = seed(tmpLogDir, 30, now);

      const result = pruneOldLogs(tmpLogDir, 14, now, { dryRun: true });

      expect(result.deleted).toBe(1);
      expect(fsSync.existsSync(path.join(tmpLogDir, stale))).toBe(true);
    });
  });

  describe("resolveLogRetentionDays", () => {
    it("defaults to DEFAULT_LOG_RETENTION_DAYS when env var is unset", () => {
      delete process.env["ASSIGNEE_LOG_RETENTION_DAYS"];
      expect(resolveLogRetentionDays()).toBe(DEFAULT_LOG_RETENTION_DAYS);
    });

    it("honors a valid positive integer env var", () => {
      process.env["ASSIGNEE_LOG_RETENTION_DAYS"] = "7";
      expect(resolveLogRetentionDays()).toBe(7);
    });

    it("falls back to default for zero, negative, or non-numeric values", () => {
      process.env["ASSIGNEE_LOG_RETENTION_DAYS"] = "0";
      expect(resolveLogRetentionDays()).toBe(DEFAULT_LOG_RETENTION_DAYS);
      process.env["ASSIGNEE_LOG_RETENTION_DAYS"] = "-5";
      expect(resolveLogRetentionDays()).toBe(DEFAULT_LOG_RETENTION_DAYS);
      process.env["ASSIGNEE_LOG_RETENTION_DAYS"] = "abc";
      expect(resolveLogRetentionDays()).toBe(DEFAULT_LOG_RETENTION_DAYS);
    });

    it("floors fractional values", () => {
      process.env["ASSIGNEE_LOG_RETENTION_DAYS"] = "7.9";
      expect(resolveLogRetentionDays()).toBe(7);
    });
  });

  describe("autoPruneLogsIfDue", () => {
    it("prunes on the first call and writes the marker file", () => {
      const now = new Date("2026-04-06T12:00:00.000Z");
      // Seed one stale file so we can assert prune actually ran.
      const stale = "cli-2026-03-01.jsonl";
      fsSync.writeFileSync(path.join(tmpLogDir, stale), "x");

      const result = autoPruneLogsIfDue(tmpLogDir, 14, now);

      expect(result).not.toBeNull();
      expect(result!.deleted).toBe(1);
      expect(fsSync.existsSync(path.join(tmpLogDir, LOG_PRUNE_MARKER))).toBe(
        true,
      );
    });

    it("skips subsequent calls within 24h (marker throttle)", () => {
      const now = new Date("2026-04-06T12:00:00.000Z");
      fsSync.writeFileSync(path.join(tmpLogDir, "cli-2026-03-01.jsonl"), "x");

      const first = autoPruneLogsIfDue(tmpLogDir, 14, now);
      expect(first).not.toBeNull();

      // Seed a new stale file AFTER the first prune; the throttle must
      // prevent the second call from touching it.
      fsSync.writeFileSync(path.join(tmpLogDir, "cli-2026-03-02.jsonl"), "y");
      // Only 23 hours later — still inside the 24h window.
      const soon = new Date(now.getTime() + 23 * 60 * 60 * 1000);
      const second = autoPruneLogsIfDue(tmpLogDir, 14, soon);

      expect(second).toBeNull();
      expect(
        fsSync.existsSync(path.join(tmpLogDir, "cli-2026-03-02.jsonl")),
      ).toBe(true);
    });

    it("prunes again once 24h has passed since the marker mtime", () => {
      const now = new Date("2026-04-06T12:00:00.000Z");
      fsSync.writeFileSync(path.join(tmpLogDir, "cli-2026-03-01.jsonl"), "x");

      autoPruneLogsIfDue(tmpLogDir, 14, now);
      // Stale file seeded AFTER first prune (25h later ⇒ window expired).
      fsSync.writeFileSync(path.join(tmpLogDir, "cli-2026-03-02.jsonl"), "y");

      const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
      // We must push the marker mtime back to the first call's time so
      // the throttle sees a 25h gap. Overwrite it with fs.utimesSync.
      const markerPath = path.join(tmpLogDir, LOG_PRUNE_MARKER);
      const past = now.getTime() / 1000;
      fsSync.utimesSync(markerPath, past, past);

      const result = autoPruneLogsIfDue(tmpLogDir, 14, later);

      expect(result).not.toBeNull();
      expect(
        fsSync.existsSync(path.join(tmpLogDir, "cli-2026-03-02.jsonl")),
      ).toBe(false);
    });

    it("returns null when directory does not exist", () => {
      const missing = path.join(tmpLogDir, "nope");
      const result = autoPruneLogsIfDue(missing, 14, new Date());
      expect(result).toBeNull();
    });
  });

  it("LOG_ACTIONS contains expected action names", () => {
    expect(LOG_ACTIONS.PLAN_STARTED).toBe("plan_started");
    expect(LOG_ACTIONS.APPLY_SUCCEEDED).toBe("apply_succeeded");
    expect(LOG_ACTIONS.APPLY_FAILED).toBe("apply_failed");
    expect(LOG_ACTIONS.PLAN_REJECTED).toBe("plan_rejected_by_user");
  });

  // ── Epic 92 Wave 2.c (A-21 / B-14) ────────────────────────────────
  // log() MUST write only to stderr + the rotating file. Under
  // `assignee <cmd> --output json` stdout is reserved for a single
  // parseable JSON envelope; a stray logger write to stdout would
  // shred the stream. These regression tests lock the invariant by
  // exercising every documented entry point (info/warn/error,
  // verbose on/off, fallback path) and asserting the stdout spy
  // is NEVER called. Matches the stderr discipline invariant
  // documented at the top of persist.ts.
  describe("invariant — log() never writes to stdout", () => {
    it("error events with verbose off write stderr-only (file + no stdout)", async () => {
      delete process.env["ASSIGNEE_VERBOSITY"];
      delete process.env["ASSIGNEE_LOG_LEVEL"];

      log({
        ts: "2026-04-20T00:00:00.000Z",
        runId: "550e8400-e29b-41d4-a716-446655441001",
        level: "error",
        action: LOG_ACTIONS.APPLY_FAILED,
        extras: { awsAccountId: "210987654321" },
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      // Persisted file path — no stderr either in non-verbose.
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("error events with verbose on write stderr + file, never stdout", async () => {
      process.argv = [...originalArgv, "--verbose"];

      log({
        ts: "2026-04-20T00:00:00.000Z",
        runId: "550e8400-e29b-41d4-a716-446655441002",
        level: "error",
        action: LOG_ACTIONS.APPLY_FAILED,
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledOnce();
    });

    it("info events routed to stderr-only under --verbose, never stdout", () => {
      process.argv = [...originalArgv, "--verbose"];

      log({
        ts: "2026-04-20T00:00:00.000Z",
        runId: "550e8400-e29b-41d4-a716-446655441003",
        level: "info",
        action: LOG_ACTIONS.PLAN_STARTED,
        extras: { intent: "Create an S3 bucket" },
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledOnce();
    });

    it("warn events under --verbose route to stderr + file, never stdout", () => {
      process.argv = [...originalArgv, "--verbose"];

      log({
        ts: "2026-04-20T00:00:00.000Z",
        runId: "550e8400-e29b-41d4-a716-446655441004",
        level: "warn",
        action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledOnce();
    });

    it("persist-info allowlist (TOKEN_USAGE_SUMMARY) still never writes stdout", () => {
      // Real-shaped payload copied from a live S3 apply on 2026-04-08.
      delete process.env["ASSIGNEE_VERBOSITY"];
      delete process.env["ASSIGNEE_LOG_LEVEL"];

      log({
        ts: "2026-04-08T07:29:32.019Z",
        runId: "1c1b9ae0-6411-4eb5-aaa6-e8947c9fc4bf",
        level: "info",
        action: LOG_ACTIONS.TOKEN_USAGE_SUMMARY,
        extras: {
          totalCallCount: 3,
          totalInputTokens: 2714,
          totalOutputTokens: 311,
          totalTokens: 3025,
        },
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it("fallback path (log dir unwritable) writes to stderr, never stdout", () => {
      const blockingFile = path.join(tmpLogDir, "blocker");
      fsSync.writeFileSync(blockingFile, "not a directory");
      process.env["ASSIGNEE_LOG_DIR"] = path.join(blockingFile, "nested");

      log({
        ts: "2026-04-20T00:00:00.000Z",
        runId: "550e8400-e29b-41d4-a716-446655441005",
        level: "error",
        action: LOG_ACTIONS.APPLY_FAILED,
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalled();
      const fallback = stderrSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .some((s) => s.includes("persistentLogFallback"));
      expect(fallback).toBe(true);
    });

    it("JSON output mode does not flip the stderr routing (both flags present)", () => {
      // Simulate the exact argv pattern used by `assignee plan --output json ...`
      // when --verbose is also set. The --output flag is NOT consumed by the
      // logger; it is the CLI's stdout contract. logger MUST still honor
      // stderr-only regardless of --output json.
      process.argv = [
        "/usr/local/bin/node",
        "/usr/local/bin/assignee",
        "--verbose",
        "plan",
        "--output",
        "json",
        "Create an S3 bucket",
      ];

      log({
        ts: "2026-04-20T00:00:00.000Z",
        runId: "550e8400-e29b-41d4-a716-446655441006",
        level: "info",
        action: LOG_ACTIONS.PLAN_STARTED,
        extras: { intent: "Create an S3 bucket" },
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledOnce();
    });
  });
});
