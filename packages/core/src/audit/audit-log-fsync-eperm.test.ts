/**
 * Windows fsync EPERM regression guard.
 *
 * On Windows GitHub runners, the OS temp directory (often on a virtual NTFS
 * volume) rejects `fsync` with EPERM even when the file is writable.
 * Production code must catch EPERM and downgrade gracefully — the write
 * itself is already committed via `appendFile` (O_APPEND atomic write).
 *
 * This test file uses `vi.mock("node:fs/promises")` to inject an EPERM error
 * into the `FileHandle.sync()` call and verifies:
 *   1. `appendAuditRecord` does NOT throw.
 *   2. A one-time warning mentioning "EPERM" is written to stderr.
 *   3. The returned entry has valid fields (the write path completed before
 *      the fsync was attempted).
 *
 * Kept in a separate file from `audit-log.test.ts` because `vi.mock` is
 * hoisted to the top of the module and would corrupt the real-fs tests in
 * the parent file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

// ── Full mock of node:fs/promises ──────────────────────────────────────────
// We need fine-grained control: most operations must pass through to the
// real implementation (mkdir, appendFile, readFile, stat, chmod), but
// `open()` must return a fake FileHandle whose `sync()` throws EPERM.
//
// Strategy: `vi.mock` with an async factory. We import the real module,
// then override only `open`.

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();

  // Fake FileHandle that throws EPERM on sync() but delegates close() to
  // a real fd opened on the same path.
  class EpermFileHandle {
    private realHandle: import("node:fs/promises").FileHandle | null = null;

    constructor(realHandle: import("node:fs/promises").FileHandle) {
      this.realHandle = realHandle;
    }

    async sync(): Promise<void> {
      const err = Object.assign(
        new Error("EPERM: operation not permitted, fsync"),
        { code: "EPERM", syscall: "fsync" },
      );
      throw err;
    }

    async close(): Promise<void> {
      if (this.realHandle) {
        await this.realHandle.close();
        this.realHandle = null;
      }
    }
  }

  return {
    ...real,
    open: async (
      p: import("node:fs").PathLike,
      flags: string | number,
      mode?: import("node:fs").Mode,
    ) => {
      const realHandle = await real.open(p, flags as string, mode);
      return new EpermFileHandle(
        realHandle,
      ) as unknown as import("node:fs/promises").FileHandle;
    },
  };
});

// Import AFTER the mock is defined (vitest hoists vi.mock, so the mock is
// in place before the module under test is loaded).
import { appendAuditRecord, type AuditEntry } from "./audit-log.js";

function tempLogFile(): string {
  return path.join(
    os.tmpdir(),
    `assignee-audit-eperm-test-${randomBytes(6).toString("hex")}.log`,
  );
}

describe("appendAuditRecord — Windows fsync EPERM downgrade (POSIX regression guard)", () => {
  const originalEnv = { ...process.env };
  let stderrChunks: string[];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrChunks = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8"),
      );
      // Also forward to real stderr so test runner output is visible.
      return true;
    }) as typeof process.stderr.write;

    // Ensure fsync is ENABLED so the EPERM path is exercised (not the
    // ASSIGNEE_AUDIT_FSYNC=0 bypass).
    delete process.env["ASSIGNEE_AUDIT_FSYNC"];
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    process.env = { ...originalEnv };
  });

  it("appendAuditRecord does NOT throw when FileHandle.sync() raises EPERM", async () => {
    const logFile = tempLogFile();
    // Should resolve without throwing even though fsync → EPERM.
    await expect(
      appendAuditRecord({ action: "eperm-test" }, logFile),
    ).resolves.toBeDefined();
  });

  it("emits a one-time stderr warning mentioning EPERM when fsync is rejected", async () => {
    const logFile = tempLogFile();
    await appendAuditRecord({ action: "eperm-warn-test" }, logFile);

    const allStderr = stderrChunks.join("");
    expect(allStderr).toContain("EPERM");
    expect(allStderr).toContain("fsync");
  });

  it("returned entry has valid AuditEntry fields despite EPERM (write committed before fsync)", async () => {
    const logFile = tempLogFile();
    const entry = (await appendAuditRecord(
      { action: "eperm-entry-check" },
      logFile,
    )) as AuditEntry;

    expect(entry.index).toBe(0);
    expect(entry.role).toBe("operator");
    expect(entry.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.prevHmac).toBe("GENESIS");
    expect(entry.record).toEqual({ action: "eperm-entry-check" });
  });

  // Note: the non-EPERM re-throw branch (e.g. EACCES, ENOSPC, EIO) is
  // verified in the companion file `audit-log-fsync-eaccess.test.ts`,
  // which uses a separate `vi.mock` factory that throws EACCES instead.
  // `vi.mock` is hoisted to the top of each module and cannot be
  // reconfigured between tests in the same file, so the re-throw test
  // lives in its own file rather than as another it() here.
});
