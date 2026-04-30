/**
 * P053 — Audit-log silent-swallow + no-alerting regression tests.
 *
 * Story R9b-04: commit 65f3d91 (W6-02) explicitly deferred "the audit-log unit
 * test … explicit injection test is a Round-2 follow-up" (commit body, W6-02
 * paragraph). This test file is that Round-2 follow-up.
 *
 * The deferred test surface is `apps/mcp-server/src/utils/audit-log.ts` — the
 * base JSONL writer used by every MCP tool. Three vectors are covered:
 *
 * 1. Happy-path write: `auditLog()` creates the directory + file with correct
 *    permissions, appends a valid JSONL record, and the record contains all six
 *    expected fields (`tool`, `runId`, `resourceType`, `identifier`, `success`,
 *    `errorClass`) plus `timestamp`.
 *
 * 2. Silent-swallow with `mcpLogError` routing (the deferred P053 test): when
 *    `fs.appendFile` cannot write (disk full / permission denied), `auditLog()`
 *    MUST NOT throw or reject (never break the handler) but MUST route the
 *    failure to `mcpLogError` with structured fields (`tool`, `runId`,
 *    `errorClass`). The DD finding §P053 called this "silent-swallow + no-
 *    alerting" — the audit pipeline keeps the "never throw" contract while the
 *    operator sees the error surface in their log scrape.
 *
 * 3. `auditLogDir` / `auditLogPath` honour the `ASSIGNEE_MCP_AUDIT_DIR`
 *    override and fall back to `~/.assignee/logs` when the env var is absent,
 *    producing a date-stamped filename that rotates on UTC date change.
 *
 * Note on HTTP Bearer: the MCP server uses `StdioServerTransport` (not HTTP).
 * The DD §P053 "HTTP Bearer detect" title describes the original finding
 * context (SaaS-phase HTTP transport) — there is no Bearer-token layer today.
 * The concrete deferred item was always the base audit-log swallow test.
 *
 * Implementation note: `mcpLogError` is mocked via `vi.spyOn` on
 * `process.stderr.write` (the actual emission surface) rather than via ESM
 * module hoisting. `auditLog` imports `structured-log.js` at module load; the
 * spy on stderr is transparent to that import chain and avoids the ESM hoisting
 * fragility documented in the neighbouring test files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  auditLog,
  auditLogDir,
  auditLogPath,
  _resetAuditEnvForTests,
} from "../audit-log.js";

// ── Helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-audit-log-"));
  process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
});

afterEach(async () => {
  _resetAuditEnvForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function readSingleRecord(): Promise<Record<string, unknown>> {
  const files = (await fs.readdir(tmpDir)).filter((f) =>
    f.startsWith("mcp-audit-"),
  );
  expect(files).toHaveLength(1);
  const raw = await fs.readFile(path.join(tmpDir, files[0]!), "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

// ── 1. Happy-path write ──────────────────────────────────────────────────

describe("auditLog — happy-path write", () => {
  it("creates the audit directory and log file on first write", async () => {
    await auditLog({
      tool: "apply_plan",
      runId: "aaaaaaaa-0000-0000-0000-000000000001",
      resourceType: "AWS::S3::Bucket",
      identifier: "arn:aws:s3:::audit-p053-fixture",
      success: true,
      errorClass: "",
    });

    const files = await fs.readdir(tmpDir);
    const logFile = files.find((f) => f.startsWith("mcp-audit-"));
    expect(logFile).toBeDefined();
  });

  it("writes all seven JSONL fields (6 AuditRecord + timestamp) for a success record", async () => {
    await auditLog({
      tool: "apply_plan",
      runId: "aaaaaaaa-0000-0000-0000-000000000002",
      resourceType: "AWS::S3::Bucket",
      identifier: "arn:aws:s3:::my-real-fixture-bucket",
      success: true,
      errorClass: "",
    });

    const record = await readSingleRecord();

    // Exact field set (schema-pin per Story 50-5 H-3 contract)
    expect(Object.keys(record).sort()).toEqual(
      [
        "errorClass",
        "identifier",
        "resourceType",
        "runId",
        "success",
        "timestamp",
        "tool",
      ].sort(),
    );

    expect(record["tool"]).toBe("apply_plan");
    expect(record["runId"]).toBe("aaaaaaaa-0000-0000-0000-000000000002");
    expect(record["resourceType"]).toBe("AWS::S3::Bucket");
    expect(record["identifier"]).toBe("arn:aws:s3:::my-real-fixture-bucket");
    expect(record["success"]).toBe(true);
    expect(record["errorClass"]).toBe("");
    expect(typeof record["timestamp"]).toBe("string");
    expect(new Date(record["timestamp"] as string).toISOString()).toBe(
      record["timestamp"],
    );
  });

  it("writes a failure record for destroy_resource with a non-empty errorClass", async () => {
    await auditLog({
      tool: "destroy_resource",
      runId: "",
      resourceType: "AWS::Lambda::Function",
      identifier: "arn:aws:lambda:us-east-1:111122223333:function:my-fn",
      success: false,
      errorClass: "PollFailure",
    });

    const record = await readSingleRecord();
    expect(record["tool"]).toBe("destroy_resource");
    expect(record["runId"]).toBe("");
    expect(record["identifier"]).toBe(
      "arn:aws:lambda:us-east-1:111122223333:function:my-fn",
    );
    expect(record["success"]).toBe(false);
    expect(record["errorClass"]).toBe("PollFailure");
  });

  it("appends a second record on the same file (two JSONL lines)", async () => {
    await auditLog({
      tool: "apply_plan",
      runId: "aaaaaaaa-0000-0000-0000-000000000003",
      resourceType: "AWS::S3::Bucket",
      identifier: "arn:aws:s3:::bucket-a",
      success: true,
      errorClass: "",
    });
    await auditLog({
      tool: "destroy_resource",
      runId: "",
      resourceType: "AWS::EC2::Instance",
      identifier:
        "arn:aws:ec2:us-east-1:111122223333:instance/i-0123456789abcdef0",
      success: false,
      errorClass: "DestroyError",
    });

    const files = (await fs.readdir(tmpDir)).filter((f) =>
      f.startsWith("mcp-audit-"),
    );
    expect(files).toHaveLength(1);
    const raw = await fs.readFile(path.join(tmpDir, files[0]!), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const r0 = JSON.parse(lines[0]!) as Record<string, unknown>;
    const r1 = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(r0["tool"]).toBe("apply_plan");
    expect(r1["tool"]).toBe("destroy_resource");
    expect(r1["errorClass"]).toBe("DestroyError");
  });

  it("creates the log file with mode 0o600 (owner-only read/write)", async () => {
    await auditLog({
      tool: "apply_plan",
      runId: "aaaaaaaa-0000-0000-0000-000000000004",
      resourceType: "AWS::S3::Bucket",
      identifier: "arn:aws:s3:::mode-test-bucket",
      success: true,
      errorClass: "",
    });

    const files = (await fs.readdir(tmpDir)).filter((f) =>
      f.startsWith("mcp-audit-"),
    );
    const stat = await fs.stat(path.join(tmpDir, files[0]!));
    // On Linux/macOS: mode & 0o777 gives rwxrwxrwx bits; expect 0o600.
    // On Windows, stat.mode is unreliable — skip the assertion there.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});

// ── 2. Silent-swallow + mcpLogError routing (P053 deferred test) ─────────

describe("auditLog — silent-swallow + mcpLogError routing (P053)", () => {
  /**
   * The P053 "silent-swallow + no-alerting" finding states that when the
   * audit-log write fails (full disk, bad permissions, etc.) the failure
   * MUST surface to operators via the structured logger — not be discarded
   * silently. Commit 65f3d91 added the mcpLogError call but deferred the
   * test that asserts it fires.
   *
   * These tests prove: (a) auditLog never throws on write failure, and
   * (b) mcpLogError is called with tool + runId + errorClass fields so
   * a log scraper can reconstruct "which tool invocation lost its audit
   * record and why."
   */

  it("does NOT throw or reject when the audit directory cannot be created", async () => {
    // Point the audit dir at a path whose parent is an existing FILE —
    // fs.mkdir will fail with ENOTDIR. The handler must swallow this.
    const blockerFile = path.join(tmpDir, "not-a-dir");
    await fs.writeFile(blockerFile, "I am a file, not a directory");
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = path.join(
      blockerFile,
      "cannot-nest-here",
    );

    await expect(
      auditLog({
        tool: "apply_plan",
        runId: "bbbbbbbb-0000-0000-0000-000000000001",
        resourceType: "AWS::S3::Bucket",
        identifier: "arn:aws:s3:::silent-swallow-test",
        success: false,
        errorClass: "GraphExecutionError",
      }),
    ).resolves.toBeUndefined();
  });

  it("routes write-failure to mcpLogError with tool + runId + errorClass fields", async () => {
    // Spy on stderr to capture the mcpLogError output — mcpLogError
    // writes JSON-lines to process.stderr. We inspect the written
    // payload rather than using ESM mock hoisting.
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrChunks.push(String(chunk));
        return true;
      });

    const blockerFile = path.join(tmpDir, "blocker-for-mcplog");
    await fs.writeFile(blockerFile, "blocker");
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = path.join(
      blockerFile,
      "nested-dir",
    );

    await auditLog({
      tool: "destroy_resource",
      runId: "bbbbbbbb-0000-0000-0000-000000000002",
      resourceType: "AWS::EC2::SecurityGroup",
      identifier:
        "arn:aws:ec2:us-east-1:111122223333:security-group/sg-0abc1234",
      success: false,
      errorClass: "CrossAccountNotFound",
    });

    stderrSpy.mockRestore();

    // mcpLogError must have fired at least once
    expect(stderrChunks.length).toBeGreaterThan(0);

    // Parse the stderr output as JSON-lines and find the audit-log error record
    const parsedRecords: Array<Record<string, unknown>> = [];
    for (const chunk of stderrChunks) {
      for (const line of chunk.split("\n").filter((l) => l.trim())) {
        try {
          parsedRecords.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not JSON — skip
        }
      }
    }

    const auditErrRecord = parsedRecords.find(
      (r) => r["source"] === "audit-log" && r["action"] === "append-failed",
    );
    expect(auditErrRecord).toBeDefined();

    // The structured extras must carry enough context for triage
    const extras = auditErrRecord!["extras"] as Record<string, unknown>;
    expect(extras).toBeDefined();
    expect(extras["tool"]).toBe("destroy_resource");
    expect(extras["runId"]).toBe("bbbbbbbb-0000-0000-0000-000000000002");
    // errorClass field in extras: the error class of the fs failure
    // (constructor name of the thrown Error), not the tool-level class.
    // Verify it's present and is a non-empty string (the exact class
    // depends on the OS — ENOTDIR, SystemError, etc.).
    expect(typeof extras["errorClass"]).toBe("string");
    expect((extras["errorClass"] as string).length).toBeGreaterThan(0);
  });

  it("redacts AKIA-like patterns from err.message before passing to mcpLogError (M-β-17)", async () => {
    // Regression guard for W5-S4: a filesystem error whose message contains
    // an AKIA-format access-key identifier (e.g. a per-tenant cache path
    // that embeds a credential fragment) must NOT reach the stderr log
    // scraper verbatim.  The redactSensitive wrapper on the mcpLogError
    // call should replace the AKIA token with "[AKIA]".
    //
    // The AKIA token is embedded in the audit directory path so that the
    // resulting OS ENOTDIR error message echoes the path — which is the
    // realistic failure scenario (a per-tenant cache dir derived from a
    // credential-fragment key).  We use a blocker-file approach (same
    // pattern as the other P053 tests) so the error originates from a real
    // OS syscall rather than a synthetic throw, exercising the full path.
    const fakeAkiaKey = "AKIAIOSFODNN7EXAMPLE";

    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrChunks.push(String(chunk));
        return true;
      });

    // Create a regular file at a path whose segment contains the AKIA token,
    // then point the audit dir at a sub-path of that file (ENOTDIR).
    const blockerFile = path.join(tmpDir, `tenant-${fakeAkiaKey}`);
    await fs.writeFile(blockerFile, "blocker");
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = path.join(
      blockerFile,
      "audit-nested",
    );

    await auditLog({
      tool: "apply_plan",
      runId: "cccccccc-0000-0000-0000-000000000001",
      resourceType: "AWS::S3::Bucket",
      identifier: "arn:aws:s3:::akia-redaction-test",
      success: false,
      errorClass: "StorageError",
    });

    stderrSpy.mockRestore();

    // The raw AKIA token must not appear anywhere in the stderr output.
    const allStderr = stderrChunks.join("");
    expect(allStderr).not.toContain(fakeAkiaKey);

    // The mcpLogError record must still carry the structured extras (tool,
    // runId, errorClass) — redaction must only affect the message field.
    const parsedRecords: Array<Record<string, unknown>> = [];
    for (const chunk of stderrChunks) {
      for (const line of chunk.split("\n").filter((l) => l.trim())) {
        try {
          parsedRecords.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not JSON — skip
        }
      }
    }

    const auditErrRecord = parsedRecords.find(
      (r) => r["source"] === "audit-log" && r["action"] === "append-failed",
    );
    expect(auditErrRecord).toBeDefined();

    const extras = auditErrRecord!["extras"] as Record<string, unknown>;
    expect(extras["tool"]).toBe("apply_plan");
    expect(extras["runId"]).toBe("cccccccc-0000-0000-0000-000000000001");
    expect(typeof extras["errorClass"]).toBe("string");
    expect((extras["errorClass"] as string).length).toBeGreaterThan(0);
  });

  it("routes write-failure to mcpLogError even for an empty-runId destroy call", async () => {
    // Empty runId is the Story 50-5 H-3 sentinel for destroy_resource
    // (no checkpoint). The audit-log must still surface the error with
    // an empty-string runId, not silently omit the field.
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrChunks.push(String(chunk));
        return true;
      });

    const blockerFile = path.join(tmpDir, "blocker-empty-runid");
    await fs.writeFile(blockerFile, "blocker");
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = path.join(blockerFile, "nested");

    await auditLog({
      tool: "destroy_resource",
      runId: "",
      resourceType: "AWS::SQS::Queue",
      identifier: "arn:aws:sqs:us-east-1:111122223333:my-queue",
      success: false,
      errorClass: "PollFailure",
    });

    stderrSpy.mockRestore();

    const parsedRecords: Array<Record<string, unknown>> = [];
    for (const chunk of stderrChunks) {
      for (const line of chunk.split("\n").filter((l) => l.trim())) {
        try {
          parsedRecords.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not JSON — skip
        }
      }
    }

    const auditErrRecord = parsedRecords.find(
      (r) => r["source"] === "audit-log" && r["action"] === "append-failed",
    );
    expect(auditErrRecord).toBeDefined();

    const extras = auditErrRecord!["extras"] as Record<string, unknown>;
    expect(extras["tool"]).toBe("destroy_resource");
    expect(extras["runId"]).toBe("");
  });

  it("emits level=error (not warn/info) for audit write failure", async () => {
    // The DD finding §P053 specifically notes "no-alerting" — using
    // info or warn level would under-alert operators. Assert error level.
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrChunks.push(String(chunk));
        return true;
      });

    const blockerFile = path.join(tmpDir, "blocker-level");
    await fs.writeFile(blockerFile, "blocker");
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = path.join(blockerFile, "nested");

    await auditLog({
      tool: "apply_plan",
      runId: "bbbbbbbb-0000-0000-0000-000000000003",
      resourceType: "AWS::DynamoDB::Table",
      identifier:
        "arn:aws:dynamodb:us-east-1:111122223333:table/audit-level-test",
      success: false,
      errorClass: "CheckpointError",
    });

    stderrSpy.mockRestore();

    const parsedRecords: Array<Record<string, unknown>> = [];
    for (const chunk of stderrChunks) {
      for (const line of chunk.split("\n").filter((l) => l.trim())) {
        try {
          parsedRecords.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not JSON — skip
        }
      }
    }

    const auditErrRecord = parsedRecords.find(
      (r) => r["source"] === "audit-log" && r["action"] === "append-failed",
    );
    expect(auditErrRecord).toBeDefined();
    expect(auditErrRecord!["level"]).toBe("error");
  });
});

// ── 3. auditLogDir / auditLogPath helpers ─────────────────────────────────

describe("auditLogDir + auditLogPath", () => {
  it("auditLogDir returns the ASSIGNEE_MCP_AUDIT_DIR override when set", () => {
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = "/custom/audit/path";
    expect(auditLogDir()).toBe("/custom/audit/path");
  });

  it("auditLogDir falls back to ~/.assignee/logs when env var is absent", () => {
    delete process.env["ASSIGNEE_MCP_AUDIT_DIR"];
    const dir = auditLogDir();
    expect(dir).toBe(path.join(os.homedir(), ".assignee", "logs"));
  });

  it("auditLogPath returns a path under auditLogDir with date-stamped filename", () => {
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
    const now = new Date("2026-04-26T10:00:00.000Z");
    const logPath = auditLogPath(now);
    expect(logPath).toBe(path.join(tmpDir, "mcp-audit-2026-04-26.jsonl"));
  });

  it("auditLogPath rotates on UTC date boundary (different date → different file)", () => {
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
    const day1 = new Date("2026-04-26T23:59:59.000Z");
    const day2 = new Date("2026-04-27T00:00:00.000Z");
    expect(auditLogPath(day1)).toBe(
      path.join(tmpDir, "mcp-audit-2026-04-26.jsonl"),
    );
    expect(auditLogPath(day2)).toBe(
      path.join(tmpDir, "mcp-audit-2026-04-27.jsonl"),
    );
    expect(auditLogPath(day1)).not.toBe(auditLogPath(day2));
  });

  it("auditLogPath pads single-digit months and days with a leading zero", () => {
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
    const date = new Date("2026-01-05T00:00:00.000Z");
    const logPath = auditLogPath(date);
    expect(logPath).toMatch(/mcp-audit-2026-01-05\.jsonl$/);
  });
});
