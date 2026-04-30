/**
 * W3-01 + W3-02 — Audit log write/read path tests.
 * P045 — Audit log retention floor enforcement tests.
 * W8-S1 — Single-call append + fsync gate tests.
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
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { randomBytes } from "node:crypto";
import {
  appendAuditRecord,
  readAuditLog,
  auditLogExists,
  isAuditEntryWithinRetentionFloor,
  guardAuditLogTruncation,
  type AuditEntry,
} from "./audit-log.js";
import { MINIMUM_AUDIT_RETENTION_DAYS } from "../utils/logger/retention.js";

// ── Test helpers ────────────────────────────────────────────────────────

function tempLogFile(): string {
  return path.join(
    os.tmpdir(),
    `assignee-audit-test-${randomBytes(6).toString("hex")}.log`,
  );
}

async function cleanupFile(p: string): Promise<void> {
  await fs.unlink(p).catch(() => {});
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("appendAuditRecord", () => {
  it("creates the log file on first write", async () => {
    const logFile = tempLogFile();
    await appendAuditRecord({ action: "plan" }, logFile);
    expect(auditLogExists(logFile)).toBe(true);
    await cleanupFile(logFile);
  });

  it("returns a valid AuditEntry with index 0 for the first record", async () => {
    const logFile = tempLogFile();
    const entry = await appendAuditRecord(
      { action: "plan", resource: "AWS::S3::Bucket" },
      logFile,
    );
    expect(entry.index).toBe(0);
    expect(entry.role).toBe("operator"); // W3-02: getCurrentRole() hardcoded
    expect(entry.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.prevHmac).toBe("GENESIS");
    expect(entry.record).toEqual({
      action: "plan",
      resource: "AWS::S3::Bucket",
    });
    await cleanupFile(logFile);
  });

  it("increments index for each subsequent record", async () => {
    const logFile = tempLogFile();
    const e0 = await appendAuditRecord({ action: "plan" }, logFile);
    const e1 = await appendAuditRecord({ action: "apply" }, logFile);
    const e2 = await appendAuditRecord({ action: "destroy" }, logFile);
    expect(e0.index).toBe(0);
    expect(e1.index).toBe(1);
    expect(e2.index).toBe(2);
    await cleanupFile(logFile);
  });

  it("chains prevHmac correctly across records", async () => {
    const logFile = tempLogFile();
    const e0 = await appendAuditRecord({ action: "plan" }, logFile);
    const e1 = await appendAuditRecord({ action: "apply" }, logFile);
    expect(e1.prevHmac).toBe(e0.hmac);
    await cleanupFile(logFile);
  });

  it("includes a role field in every entry (W3-02)", async () => {
    const logFile = tempLogFile();
    const entry = await appendAuditRecord({ action: "list" }, logFile);
    expect(typeof entry.role).toBe("string");
    expect(entry.role.length).toBeGreaterThan(0);
    await cleanupFile(logFile);
  });

  it("includes a timestamp in ISO 8601 format", async () => {
    const logFile = tempLogFile();
    const entry = await appendAuditRecord({ action: "status" }, logFile);
    expect(() => new Date(entry.timestamp)).not.toThrow();
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    await cleanupFile(logFile);
  });
});

// ── readAuditLog tests ──────────────────────────────────────────────────

describe("readAuditLog", () => {
  it("returns an empty array when the file does not exist", async () => {
    const logFile = tempLogFile();
    const lines = await readAuditLog(logFile);
    expect(lines).toEqual([]);
  });

  it("reads back the same entries that were written", async () => {
    const logFile = tempLogFile();
    await appendAuditRecord({ action: "plan" }, logFile);
    await appendAuditRecord({ action: "apply" }, logFile);
    const lines = await readAuditLog(logFile);
    expect(lines.length).toBe(2);
    const entries = lines as AuditEntry[];
    expect(entries[0]!.index).toBe(0);
    expect(entries[1]!.index).toBe(1);
    await cleanupFile(logFile);
  });

  it("parses legacy lines (no HMAC) as preLegacy entries", async () => {
    const logFile = tempLogFile();
    // Write a raw non-HMAC line.
    await fs.writeFile(
      logFile,
      JSON.stringify({ action: "old-audit-event", ts: "2025-01-01" }) + "\n",
      { mode: 0o600 },
    );
    const lines = await readAuditLog(logFile);
    expect(lines.length).toBe(1);
    expect("preLegacy" in lines[0]!).toBe(true);
    await cleanupFile(logFile);
  });

  it("handles mixed legacy + HMAC entries", async () => {
    const logFile = tempLogFile();
    // Write a legacy line first.
    await fs.writeFile(
      logFile,
      JSON.stringify({ action: "old-event" }) + "\n",
      { mode: 0o600 },
    );
    // Then append a real HMAC entry.
    await appendAuditRecord({ action: "plan" }, logFile);
    const lines = await readAuditLog(logFile);
    expect(lines.length).toBe(2);
    expect("preLegacy" in lines[0]!).toBe(true);
    expect("hmac" in lines[1]!).toBe(true);
    await cleanupFile(logFile);
  });
});

// ── P045: Audit log retention floor enforcement ─────────────────────────

describe("isAuditEntryWithinRetentionFloor (P045)", () => {
  let stderrSpy: MockInstance;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    delete process.env["ASSIGNEE_AUDIT_RETENTION_DAYS"];
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  function makeEntry(timestampIso: string): AuditEntry {
    return {
      index: 0,
      timestamp: timestampIso,
      role: "operator",
      record: { action: "plan" },
      prevHmac: "GENESIS",
      hmac: "a".repeat(64),
    };
  }

  it("returns true (retained) for an entry 1 day old (well within 90d floor)", () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    const entry = makeEntry("2026-04-25T12:00:00.000Z"); // 1d old
    expect(isAuditEntryWithinRetentionFloor(entry, now)).toBe(true);
  });

  it("returns true (retained) for an entry exactly 89 days old (within 90d floor)", () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    const entryTime = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000);
    const entry = makeEntry(entryTime.toISOString());
    expect(isAuditEntryWithinRetentionFloor(entry, now)).toBe(true);
  });

  it("returns false (deletable) for an entry 91 days old (outside 90d floor)", () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    const entryTime = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
    const entry = makeEntry(entryTime.toISOString());
    expect(isAuditEntryWithinRetentionFloor(entry, now)).toBe(false);
  });

  it("returns true (retained) for an unparseable timestamp (safe default)", () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    const entry = makeEntry("not-a-date");
    expect(isAuditEntryWithinRetentionFloor(entry, now)).toBe(true);
  });

  it("respects ASSIGNEE_AUDIT_RETENTION_DAYS=180 — 91d old entry is still retained", () => {
    process.env["ASSIGNEE_AUDIT_RETENTION_DAYS"] = "180";
    const now = new Date("2026-04-26T12:00:00.000Z");
    const entryTime = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
    const entry = makeEntry(entryTime.toISOString());
    // 91d < 180d → retained
    expect(isAuditEntryWithinRetentionFloor(entry, now)).toBe(true);
  });

  it("ASSIGNEE_AUDIT_RETENTION_DAYS < 90 is clamped to 90 (emits stderr error)", () => {
    process.env["ASSIGNEE_AUDIT_RETENTION_DAYS"] = "30";
    const now = new Date("2026-04-26T12:00:00.000Z");
    // 50d old entry — within 90d clamped floor, outside 30d requested floor
    const entryTime = new Date(now.getTime() - 50 * 24 * 60 * 60 * 1000);
    const entry = makeEntry(entryTime.toISOString());
    // resolveAuditRetentionDays() clamps 30→90, so 50d < 90d → retained
    expect(isAuditEntryWithinRetentionFloor(entry, now)).toBe(true);
    // stderr error must have fired from resolveAuditRetentionDays()
    expect(stderrSpy).toHaveBeenCalled();
    const stderrText = stderrSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .join("");
    expect(stderrText).toContain("90-day compliance floor");
  });

  it("MINIMUM_AUDIT_RETENTION_DAYS is 90", () => {
    expect(MINIMUM_AUDIT_RETENTION_DAYS).toBe(90);
  });
});

describe("guardAuditLogTruncation (P045)", () => {
  let stderrSpy: MockInstance;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    delete process.env["ASSIGNEE_AUDIT_RETENTION_DAYS"];
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it("allows truncation when the log file does not exist (no records)", async () => {
    const logFile = tempLogFile(); // does not exist yet
    const result = await guardAuditLogTruncation(logFile);
    expect(result.ok).toBe(true);
  });

  it("allows truncation when all records are older than the 90d floor (95d old)", async () => {
    const logFile = tempLogFile();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const oldTime = new Date(
      now.getTime() - 95 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Manually write a single HMAC entry with an old timestamp
    const entry: AuditEntry = {
      index: 0,
      timestamp: oldTime,
      role: "operator",
      record: { action: "plan" },
      prevHmac: "GENESIS",
      hmac: "a".repeat(64),
    };
    await fs.writeFile(logFile, JSON.stringify(entry) + "\n", { mode: 0o600 });

    const result = await guardAuditLogTruncation(logFile, now);
    expect(result.ok).toBe(true);
    await cleanupFile(logFile);
  });

  it("blocks truncation when a record is within the 90d floor (1d old)", async () => {
    const logFile = tempLogFile();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const recentTime = new Date(
      now.getTime() - 1 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const entry: AuditEntry = {
      index: 0,
      timestamp: recentTime,
      role: "operator",
      record: { action: "apply" },
      prevHmac: "GENESIS",
      hmac: "b".repeat(64),
    };
    await fs.writeFile(logFile, JSON.stringify(entry) + "\n", { mode: 0o600 });

    const result = await guardAuditLogTruncation(logFile, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("mandatory");
    expect(result.reason).toContain("90");
    await cleanupFile(logFile);
  });

  it("blocks truncation with mixed entries when any is within floor (reports count)", async () => {
    const logFile = tempLogFile();
    const now = new Date("2026-04-26T12:00:00.000Z");

    const oldTime = new Date(
      now.getTime() - 100 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recentTime = new Date(
      now.getTime() - 5 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const e0: AuditEntry = {
      index: 0,
      timestamp: oldTime,
      role: "operator",
      record: {},
      prevHmac: "GENESIS",
      hmac: "c".repeat(64),
    };
    const e1: AuditEntry = {
      index: 1,
      timestamp: recentTime,
      role: "operator",
      record: {},
      prevHmac: "c".repeat(64),
      hmac: "d".repeat(64),
    };
    await fs.writeFile(
      logFile,
      JSON.stringify(e0) + "\n" + JSON.stringify(e1) + "\n",
      { mode: 0o600 },
    );

    const result = await guardAuditLogTruncation(logFile, now);
    expect(result.ok).toBe(false);
    // Only e1 (5d old) is within the 90d floor
    expect(result.reason).toContain("1 record(s)");
    await cleanupFile(logFile);
  });

  it("allows truncation when all records are outside the floor (no retained)", async () => {
    const logFile = tempLogFile();
    const now = new Date("2026-04-26T12:00:00.000Z");

    // Both records older than 90d
    const old1 = new Date(
      now.getTime() - 100 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const old2 = new Date(
      now.getTime() - 200 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const e0: AuditEntry = {
      index: 0,
      timestamp: old2,
      role: "operator",
      record: {},
      prevHmac: "GENESIS",
      hmac: "e".repeat(64),
    };
    const e1: AuditEntry = {
      index: 1,
      timestamp: old1,
      role: "operator",
      record: {},
      prevHmac: "e".repeat(64),
      hmac: "f".repeat(64),
    };
    await fs.writeFile(
      logFile,
      JSON.stringify(e0) + "\n" + JSON.stringify(e1) + "\n",
      { mode: 0o600 },
    );

    const result = await guardAuditLogTruncation(logFile, now);
    expect(result.ok).toBe(true);
    await cleanupFile(logFile);
  });
});

// ── W8-S1: atomic append + fsync gate (M-α-19) ─────────────────────────

describe("appendAuditRecord — W8-S1 atomic write (no temp file, fsync gate)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("leaves no .tmp.* file in the log directory after a successful write", async () => {
    const logDir = path.join(
      os.tmpdir(),
      `assignee-audit-w8s1-${randomBytes(4).toString("hex")}`,
    );
    await fs.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, "audit.log");

    // Disable fsync for speed in this test
    process.env["ASSIGNEE_AUDIT_FSYNC"] = "0";

    await appendAuditRecord({ action: "plan" }, logFile);
    await appendAuditRecord({ action: "apply" }, logFile);

    const dirEntries = fsSync.readdirSync(logDir);
    const tmpFiles = dirEntries.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);

    // Cleanup
    await fs.rm(logDir, { recursive: true });
  });

  it("writes both records as separate NDJSON lines (two lock grants)", async () => {
    const logFile = tempLogFile();
    process.env["ASSIGNEE_AUDIT_FSYNC"] = "0";

    const e0 = await appendAuditRecord({ action: "plan", seq: 0 }, logFile);
    const e1 = await appendAuditRecord({ action: "apply", seq: 1 }, logFile);

    const lines = await readAuditLog(logFile);
    expect(lines).toHaveLength(2);

    const parsed = lines as AuditEntry[];
    expect(parsed[0]!.index).toBe(0);
    expect(parsed[1]!.index).toBe(1);
    // Chain integrity: e1.prevHmac must equal e0.hmac
    expect(parsed[1]!.prevHmac).toBe(e0.hmac);
    expect(parsed[1]!.hmac).toBe(e1.hmac);

    await cleanupFile(logFile);
  });

  it("calls fsync by default (ASSIGNEE_AUDIT_FSYNC unset) — record lands in file", async () => {
    delete process.env["ASSIGNEE_AUDIT_FSYNC"];
    const logFile = tempLogFile();

    const entry = await appendAuditRecord({ action: "fsync-test" }, logFile);

    // File must exist and be non-empty (fsync path completes without throwing).
    expect(fsSync.existsSync(logFile)).toBe(true);
    expect(fsSync.statSync(logFile).size).toBeGreaterThan(0);

    // Content must be valid NDJSON with the expected record.
    const lines = await readAuditLog(logFile);
    expect(lines).toHaveLength(1);
    const parsed = lines[0] as AuditEntry;
    expect(parsed.record).toEqual({ action: "fsync-test" });
    expect(parsed.hmac).toBe(entry.hmac);

    await cleanupFile(logFile);
  });

  it("skips fsync when ASSIGNEE_AUDIT_FSYNC=0 — record still lands in file", async () => {
    process.env["ASSIGNEE_AUDIT_FSYNC"] = "0";
    const logFile = tempLogFile();

    const entry = await appendAuditRecord({ action: "no-fsync-test" }, logFile);

    // Content must be identical to the fsync path — fsync is durability-only.
    expect(fsSync.existsSync(logFile)).toBe(true);
    expect(fsSync.statSync(logFile).size).toBeGreaterThan(0);

    const lines = await readAuditLog(logFile);
    expect(lines).toHaveLength(1);
    const parsed = lines[0] as AuditEntry;
    expect(parsed.record).toEqual({ action: "no-fsync-test" });
    expect(parsed.hmac).toBe(entry.hmac);

    await cleanupFile(logFile);
  });
});
