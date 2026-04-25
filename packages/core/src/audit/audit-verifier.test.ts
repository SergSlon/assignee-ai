/**
 * W3-01 — Audit chain verifier tests.
 *
 * Tests cover:
 *   - Clean chain → ok: true
 *   - Corrupted record payload → brokenAt N, reason: "hmac-mismatch"
 *   - Corrupted HMAC → brokenAt N, reason: "hmac-mismatch"
 *   - Missing-prev linkage → brokenAt N, reason: "missing-prev"
 *   - Legacy-only log → ok: true with legacyCount
 *   - Mixed legacy + HMAC → verifies HMAC portion only
 *   - 100-record fixture: exit 0 on clean, non-zero on broken
 */

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { computeChainLink, GENESIS_HMAC } from "./hmac-chain.js";
import type { AuditEntry } from "./audit-log.js";
import { verifyAuditLog } from "./audit-verifier.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function tempLogFile(): string {
  return path.join(
    os.tmpdir(),
    `assignee-verifier-test-${randomBytes(6).toString("hex")}.log`,
  );
}

async function cleanupFile(p: string): Promise<void> {
  await fs.unlink(p).catch(() => {});
}

const FIXED_KEY = "verifier-test-fixed-key-32-chars-!!";

/**
 * Build an N-entry audit log at `logFile` using `FIXED_KEY`.
 * Returns the list of written entries.
 */
async function buildChain(logFile: string, n: number): Promise<AuditEntry[]> {
  // We cannot pass the key to appendAuditRecord directly (it uses
  // getAuditKey()), so we build the entries manually by writing raw NDJSON.
  const entries: AuditEntry[] = [];
  let prevHmac = GENESIS_HMAC;

  for (let i = 0; i < n; i++) {
    const record = { action: "test-action", index: i };
    const hmac = computeChainLink(prevHmac, record, FIXED_KEY);
    const entry: AuditEntry = {
      index: i,
      timestamp: new Date().toISOString(),
      role: "operator",
      record,
      prevHmac,
      hmac,
    };
    entries.push(entry);
    await fs.appendFile(logFile, JSON.stringify(entry) + "\n");
    prevHmac = hmac;
  }
  return entries;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("verifyAuditLog — clean chain", () => {
  it("returns ok:true for a 5-record clean chain", async () => {
    const logFile = tempLogFile();
    await buildChain(logFile, 5);
    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.total).toBe(5);
      expect(result.legacyCount).toBe(0);
    }
    await cleanupFile(logFile);
  });

  it("returns ok:true for an empty log", async () => {
    const logFile = tempLogFile();
    await fs.writeFile(logFile, "", { mode: 0o600 });
    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.total).toBe(0);
    }
    await cleanupFile(logFile);
  });

  it("returns ok:true for non-existent log (treated as empty)", async () => {
    const logFile = tempLogFile();
    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(true);
  });
});

describe("verifyAuditLog — 100-record fixture (acceptance criterion)", () => {
  it("verifies a 100-record clean chain successfully", async () => {
    const logFile = tempLogFile();
    await buildChain(logFile, 100);
    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.total).toBe(100);
    }
    await cleanupFile(logFile);
  });

  it("reports broken chain when record 50 payload is corrupted", async () => {
    const logFile = tempLogFile();
    const entries = await buildChain(logFile, 100);

    // Read, corrupt entry at index 50, rewrite.
    const lines = await fs.readFile(logFile, "utf-8");
    const parsed = lines
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEntry);

    // Mutate the record payload at index 50.
    parsed[50]!.record = { action: "INJECTED-MALICIOUS", index: 50 };

    await fs.writeFile(
      logFile,
      parsed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { mode: 0o600 },
    );

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(50);
      expect(result.reason).toBe("hmac-mismatch");
    }

    // Suppress unused warning.
    void entries;
    await cleanupFile(logFile);
  });
});

describe("verifyAuditLog — corrupted records", () => {
  it("detects corrupted HMAC at record N (hmac-mismatch)", async () => {
    const logFile = tempLogFile();
    await buildChain(logFile, 5);

    const lines = await fs.readFile(logFile, "utf-8");
    const parsed = lines
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEntry);

    // Corrupt the HMAC at index 2.
    const corrupted = parsed[2]!.hmac;
    parsed[2]!.hmac =
      corrupted.slice(0, -1) + (corrupted.endsWith("a") ? "b" : "a");

    await fs.writeFile(
      logFile,
      parsed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { mode: 0o600 },
    );

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Index 2 hmac mismatch detected, or next link breaks at 3.
      expect(result.brokenAt).toBeGreaterThanOrEqual(2);
    }
    await cleanupFile(logFile);
  });

  it("detects missing prevHmac linkage (missing-prev)", async () => {
    const logFile = tempLogFile();
    await buildChain(logFile, 3);

    const lines = await fs.readFile(logFile, "utf-8");
    const parsed = lines
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEntry);

    // Inject a wrong prevHmac at index 1 (it should match entry[0].hmac).
    parsed[1]!.prevHmac = "wrong-prev-hmac-value";

    await fs.writeFile(
      logFile,
      parsed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { mode: 0o600 },
    );

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toBe("missing-prev");
    }
    await cleanupFile(logFile);
  });
});

describe("verifyAuditLog — legacy backward compatibility", () => {
  it("skips legacy lines and reports legacyCount", async () => {
    const logFile = tempLogFile();
    // Write 3 legacy (no-HMAC) lines.
    await fs.writeFile(
      logFile,
      [
        JSON.stringify({ action: "old-event-1" }),
        JSON.stringify({ ts: "2024-01-01", msg: "pre-w3 record" }),
        JSON.stringify({ legacy: true }),
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.legacyCount).toBe(3);
      expect(result.total).toBe(0);
    }
    await cleanupFile(logFile);
  });

  it("verifies HMAC records after a legacy pre-HMAC region", async () => {
    const logFile = tempLogFile();
    // Write a legacy line then a real chain of 3.
    await fs.writeFile(logFile, JSON.stringify({ old: "record" }) + "\n", {
      mode: 0o600,
    });
    await buildChain(logFile, 3);

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.legacyCount).toBe(1);
      expect(result.total).toBe(3);
    }
    await cleanupFile(logFile);
  });
});
