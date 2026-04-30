/**
 * W3-01 — Audit chain verifier tests.
 * W9-S2 — Auto-fallback to legacy HMAC + chainMode field.
 *
 * Tests cover:
 *   - Clean chain → ok: true, chainMode: "canonical"
 *   - Corrupted record payload → brokenAt N, reason: "hmac-mismatch"
 *   - Corrupted HMAC → brokenAt N, reason: "hmac-mismatch"
 *   - Missing-prev linkage → brokenAt N, reason: "missing-prev"
 *   - Legacy-only log → ok: true with legacyCount
 *   - Mixed legacy + HMAC → verifies HMAC portion only
 *   - 100-record fixture: exit 0 on clean, non-zero on broken
 *   - Pre-W7 (legacy-HMAC) chain → ok: true, chainMode: "legacy"
 *   - Mixed canonical + legacy-HMAC chain → ok: true, chainMode: "mixed"
 *   - Tampered legacy-format entry fails both checks → hmac-mismatch
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  computeChainLink,
  legacyComputeChainLink,
  GENESIS_HMAC,
} from "./hmac-chain.js";
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
 * Build an N-entry canonical audit log at `logFile` using `FIXED_KEY`.
 * Returns the list of written entries.
 */
async function buildChain(logFile: string, n: number): Promise<AuditEntry[]> {
  // We cannot pass the key to appendAuditRecord directly (it uses
  // getAuditKey()), so we build the entries manually by writing raw NDJSON.
  //
  // Record shape uses keys in REVERSE alphabetical order (zval before action)
  // so that JSON.stringify (insertion order) and canonicalJson (sorted order)
  // produce DIFFERENT bytes.  This ensures the canonical path is exercised —
  // if keys were already sorted, both paths would produce identical bytes and
  // the fallback branch would never be reached in legacy tests.
  const entries: AuditEntry[] = [];
  let prevHmac = GENESIS_HMAC;

  for (let i = 0; i < n; i++) {
    const record = { zval: "test-action", action: i };
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

/**
 * Build N canonical entries starting at `startIndex` with `startPrevHmac`,
 * appending to `logFile`. Used to construct mixed chains in tests.
 */
async function buildChain_fromOffset(
  logFile: string,
  startIndex: number,
  startPrevHmac: string,
): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  let prevHmac = startPrevHmac;
  const n = 3;

  for (let i = 0; i < n; i++) {
    const idx = startIndex + i;
    // Same reverse-alphabetical key order as buildChain to ensure canonical
    // and legacy serialisations diverge.
    const record = { zval: "test-action", action: idx };
    const hmac = computeChainLink(prevHmac, record, FIXED_KEY);
    const entry: AuditEntry = {
      index: idx,
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

/**
 * Build an N-entry legacy (pre-W7, plain JSON.stringify) audit log at
 * `logFile` using `FIXED_KEY`. Returns the written entries.
 */
async function buildLegacyChain(
  logFile: string,
  n: number,
  startIndex = 0,
  startPrevHmac = GENESIS_HMAC,
): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  let prevHmac = startPrevHmac;

  for (let i = 0; i < n; i++) {
    const idx = startIndex + i;
    // Keys in reverse alphabetical order so JSON.stringify (insertion order:
    // zval, action) differs from canonicalJson (sorted: action, zval).
    // This guarantees the canonical verification fails and the legacy fallback
    // branch fires when the verifier processes these entries.
    const record = { zval: "legacy-action", action: idx };
    const hmac = legacyComputeChainLink(prevHmac, record, FIXED_KEY);
    const entry: AuditEntry = {
      index: idx,
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
      expect(result.chainMode).toBe("canonical");
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
      expect(result.chainMode).toBe("canonical");
    }
    await cleanupFile(logFile);
  });

  it("returns ok:true for non-existent log (treated as empty)", async () => {
    const logFile = tempLogFile();
    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chainMode).toBe("canonical");
    }
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
      expect(result.chainMode).toBe("canonical");
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

describe("verifyAuditLog — index monotonicity", () => {
  it("detects duplicate/replay index (index lower than expected)", async () => {
    const logFile = tempLogFile();
    const entries = await buildChain(logFile, 5);

    // Read, set entry[3].index = 2 (duplicate / replay).
    const lines = await fs.readFile(logFile, "utf-8");
    const parsed = lines
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEntry);

    parsed[3]!.index = 2; // duplicate index

    await fs.writeFile(
      logFile,
      parsed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { mode: 0o600 },
    );

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("index-gap");
      expect(result.brokenAt).toBe(2); // reports entry.index of the bad entry
    }

    void entries;
    await cleanupFile(logFile);
  });

  it("detects skipped index (gap in sequence)", async () => {
    const logFile = tempLogFile();
    const entries = await buildChain(logFile, 5);

    // Read, set entry[2].index = 5 (jump ahead, creating a gap).
    const lines = await fs.readFile(logFile, "utf-8");
    const parsed = lines
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEntry);

    parsed[2]!.index = 5; // gap: skips 2, 3, 4

    await fs.writeFile(
      logFile,
      parsed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { mode: 0o600 },
    );

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("index-gap");
      expect(result.brokenAt).toBe(5); // reports entry.index of the bad entry
    }

    void entries;
    await cleanupFile(logFile);
  });

  it("detects a deleted entry (entries 0,2,3 — entry 1 removed)", async () => {
    const logFile = tempLogFile();
    const entries = await buildChain(logFile, 4);

    // Remove entry at position 1 entirely.
    const lines = await fs.readFile(logFile, "utf-8");
    const parsed = lines
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEntry);

    const withoutIndex1 = [parsed[0]!, parsed[2]!, parsed[3]!];

    await fs.writeFile(
      logFile,
      withoutIndex1.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { mode: 0o600 },
    );

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("index-gap");
      // entry[1] is now parsed[2]! which has index 2
      expect(result.brokenAt).toBe(2);
    }

    void entries;
    await cleanupFile(logFile);
  });

  it("index-gap reason is exported from the module", () => {
    // Compile-time check: VerifyReason must include "index-gap".
    // This test exercises the exported type at runtime via a type-narrowed value.
    const reason: import("./audit-verifier.js").VerifyReason = "index-gap";
    expect(reason).toBe("index-gap");
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
      expect(result.chainMode).toBe("canonical"); // 0 HMAC entries → canonical
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
      expect(result.chainMode).toBe("canonical");
    }
    await cleanupFile(logFile);
  });
});

// ── W9-S2: Auto-fallback to legacy HMAC + chainMode ─────────────────────

describe("verifyAuditLog — W9-S2 auto-fallback to legacy HMAC", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a per-entry stderr WARN for each legacy-HMAC entry", async () => {
    const logFile = tempLogFile();
    // 3-entry legacy chain: each entry will trigger the legacy fallback path
    // because the record keys (zval, action) are in reverse alphabetical order,
    // so canonicalJson produces different bytes than JSON.stringify, causing the
    // canonical check to fail and the legacy check to succeed.
    await buildLegacyChain(logFile, 3);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const result = await verifyAuditLog(logFile, FIXED_KEY);

    expect(result.ok).toBe(true);

    // One warning per legacy-HMAC entry (3 entries → 3 warnings).
    const legacyWarnings = stderrSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((msg) =>
        msg.includes(
          "used legacy HMAC; consider migrating with re-sign tooling",
        ),
      );
    expect(legacyWarnings).toHaveLength(3);

    // Each warning must cite the correct index.
    expect(legacyWarnings[0]).toContain("entry at index 0");
    expect(legacyWarnings[1]).toContain("entry at index 1");
    expect(legacyWarnings[2]).toContain("entry at index 2");

    await cleanupFile(logFile);
  });

  it("verifies a pre-W7 chain (all legacy-HMAC entries) → chainMode: legacy", async () => {
    const logFile = tempLogFile();
    await buildLegacyChain(logFile, 5);
    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.total).toBe(5);
      expect(result.legacyCount).toBe(0);
      expect(result.chainMode).toBe("legacy");
    }
    await cleanupFile(logFile);
  });

  it("verifies a mixed chain (legacy entries then canonical) → chainMode: mixed", async () => {
    const logFile = tempLogFile();
    // Build 3 legacy entries, then 3 canonical entries.
    const legacyEntries = await buildLegacyChain(logFile, 3);
    const lastLegacyHmac = legacyEntries[legacyEntries.length - 1]!.hmac;
    // Canonical chain starts at index 3, prevHmac = last legacy HMAC.
    await buildChain_fromOffset(logFile, 3, lastLegacyHmac);

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.total).toBe(6);
      expect(result.chainMode).toBe("mixed");
    }
    await cleanupFile(logFile);
  });

  it("does NOT fall back to legacy when the canonical entry is tampered → hmac-mismatch", async () => {
    const logFile = tempLogFile();
    await buildChain(logFile, 3);

    // Read and tamper with record at index 1.
    const lines = await fs.readFile(logFile, "utf-8");
    const parsed = lines
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEntry);

    // Inject a malicious payload — both canonical and legacy checks must fail.
    parsed[1]!.record = { action: "TAMPERED", index: 1 };

    await fs.writeFile(
      logFile,
      parsed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { mode: 0o600 },
    );

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toBe("hmac-mismatch");
      expect(result.chainMode).toBe("failed");
    }
    await cleanupFile(logFile);
  });

  it("does NOT fall back to legacy when a legacy entry is tampered → hmac-mismatch", async () => {
    const logFile = tempLogFile();
    await buildLegacyChain(logFile, 3);

    // Tamper with record at index 1 — should fail both canonical and legacy.
    const lines = await fs.readFile(logFile, "utf-8");
    const parsed = lines
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEntry);

    parsed[1]!.record = { action: "TAMPERED", index: 1 };

    await fs.writeFile(
      logFile,
      parsed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { mode: 0o600 },
    );

    const result = await verifyAuditLog(logFile, FIXED_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toBe("hmac-mismatch");
      expect(result.chainMode).toBe("failed");
    }
    await cleanupFile(logFile);
  });

  it("chainMode type is exported from the module", () => {
    const mode: import("./audit-verifier.js").ChainMode = "mixed";
    expect(mode).toBe("mixed");
  });
});
