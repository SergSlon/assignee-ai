/**
 * W3-01 + W3-02 — Audit log write/read path tests.
 */

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  appendAuditRecord,
  readAuditLog,
  auditLogExists,
  type AuditEntry,
} from "./audit-log.js";

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
