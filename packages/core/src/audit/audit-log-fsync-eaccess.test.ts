/**
 * Re-throw branch verification for non-EPERM fsync errors.
 *
 * The EPERM downgrade in `audit-log.ts` is intentionally narrow — only
 * `code === "EPERM"` is suppressed. Any other error code (EACCES, ENOSPC,
 * EIO, …) must still propagate as a thrown rejection so operators see real
 * disk problems.
 *
 * This file mocks `FileHandle.sync()` to throw `EACCES` and asserts that
 * `appendAuditRecord` REJECTS rather than silently swallowing.
 *
 * Companion to `audit-log-fsync-eperm.test.ts` which covers the EPERM
 * downgrade path; kept in a separate file because `vi.mock` is hoisted and
 * cannot be reconfigured between tests in the same file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();

  // Fake FileHandle that throws EACCES on sync() — a NON-EPERM error code
  // that the production code must re-throw rather than suppress.
  class EaccesFileHandle {
    private realHandle: import("node:fs/promises").FileHandle | null = null;

    constructor(realHandle: import("node:fs/promises").FileHandle) {
      this.realHandle = realHandle;
    }

    async sync(): Promise<void> {
      const err = Object.assign(new Error("EACCES: permission denied, fsync"), {
        code: "EACCES",
        syscall: "fsync",
      });
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
      return new EaccesFileHandle(
        realHandle,
      ) as unknown as import("node:fs/promises").FileHandle;
    },
  };
});

// Import after the mock is hoisted.
import { appendAuditRecord } from "./audit-log.js";

function tempLogFile(): string {
  return path.join(
    os.tmpdir(),
    `assignee-audit-eaccess-test-${randomBytes(6).toString("hex")}.log`,
  );
}

describe("appendAuditRecord — non-EPERM fsync errors are re-thrown (EACCES regression guard)", () => {
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
      return true;
    }) as typeof process.stderr.write;

    // Ensure fsync is ENABLED so the EACCES path is exercised.
    delete process.env["ASSIGNEE_AUDIT_FSYNC"];
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    process.env = { ...originalEnv };
  });

  it("appendAuditRecord REJECTS when FileHandle.sync() raises EACCES (not silently swallowed)", async () => {
    const logFile = tempLogFile();
    await expect(
      appendAuditRecord({ action: "eaccess-test" }, logFile),
    ).rejects.toThrow(/EACCES/);
  });

  it("does NOT emit the EPERM downgrade warning for EACCES (narrow catch is preserved)", async () => {
    const logFile = tempLogFile();
    try {
      await appendAuditRecord({ action: "eaccess-no-warn" }, logFile);
    } catch {
      // expected — see above
    }
    const allStderr = stderrChunks.join("");
    // The EPERM-specific warning string must NOT appear; the error
    // propagates as a thrown rejection, not a silent downgrade.
    expect(allStderr).not.toContain("fsync on audit log file returned EPERM");
  });
});
