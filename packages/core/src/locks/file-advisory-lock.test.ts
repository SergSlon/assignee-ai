/**
 * W4-03 (Epic 100 Round 3) — FileAdvisoryLockAdapter module tests.
 *
 * Re-exports + verifies the module-level default instance and constants.
 * Port-contract tests live in advisory-lock-port.test.ts.
 *
 * W1-C1 additions:
 *   - withLock throws LockAcquisitionError (not silently runs fn unlocked)
 *     after exhausting all retry attempts.
 *   - 5 concurrent callers with maxRetries=0: exactly 1 succeeds and 4
 *     catch LockAcquisitionError.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultFileAdvisoryLock,
  FILE_LOCK_STALE_TIMEOUT_MS,
  FILE_LOCK_MAX_RETRIES,
  FILE_LOCK_RETRY_DELAY_MS,
  FileAdvisoryLockAdapter,
  LockAcquisitionError,
} from "./file-advisory-lock.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "assignee-advisory-lock-unit-"),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function lockName(suffix = ""): string {
  return path.join(tmpDir, `unit-lock${suffix}`);
}

// ── Module-level exports ──────────────────────────────────────────────

describe("file-advisory-lock module", () => {
  it("exports a default FileAdvisoryLockAdapter instance", () => {
    expect(defaultFileAdvisoryLock).toBeInstanceOf(FileAdvisoryLockAdapter);
  });

  it("exports expected constant values", () => {
    expect(FILE_LOCK_STALE_TIMEOUT_MS).toBe(10_000);
    expect(FILE_LOCK_MAX_RETRIES).toBe(20);
    expect(FILE_LOCK_RETRY_DELAY_MS).toBe(50);
  });

  it("FileAdvisoryLockAdapter is constructable with custom options", () => {
    const adapter = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 5_000,
      maxRetries: 5,
      retryDelayMs: 10,
    });
    expect(adapter).toBeInstanceOf(FileAdvisoryLockAdapter);
  });

  it("exports LockAcquisitionError class", () => {
    expect(LockAcquisitionError).toBeDefined();
    const err = new LockAcquisitionError("my-lock", 3);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LockAcquisitionError);
    expect(err.name).toBe("LockAcquisitionError");
    expect(err.message).toContain("my-lock");
    expect(err.message).toContain("3");
  });
});

// ── withLock: throw on exhaustion (W1-C1) ────────────────────────────

describe("FileAdvisoryLockAdapter — withLock throws on lock exhaustion", () => {
  it("throws LockAcquisitionError when maxRetries=0 and lock is already held", async () => {
    const adapter = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 60_000,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    const name = lockName("exhausted");

    // Pre-acquire the lock so subsequent attempts always fail.
    const held = await adapter.acquire(name);
    expect(held).toBe(true);

    try {
      await expect(
        adapter.withLock(name, () => Promise.resolve("should-not-run")),
      ).rejects.toThrow(LockAcquisitionError);
    } finally {
      await adapter.release(name);
    }
  });

  it("fn() is NEVER called when LockAcquisitionError is thrown", async () => {
    const adapter = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 60_000,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    const name = lockName("fn-not-called");

    // Hold the lock externally.
    await adapter.acquire(name);

    let fnCalled = false;
    try {
      await adapter.withLock(name, () => {
        fnCalled = true;
        return Promise.resolve();
      });
    } catch (err) {
      expect(err).toBeInstanceOf(LockAcquisitionError);
    } finally {
      await adapter.release(name);
    }

    expect(fnCalled).toBe(false);
  });

  it("5 concurrent callers with maxRetries=0: exactly 1 succeeds, 4 throw LockAcquisitionError", async () => {
    // Use a high stale timeout so the lock is never reclaimed during the test.
    const adapter = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 60_000,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    const name = lockName("concurrent-exhausted");

    const successes: number[] = [];
    const failures: unknown[] = [];

    // All 5 start simultaneously — only the first to acquire wins; the rest
    // see the lock held and immediately exhaust their zero retries.
    const calls = Array.from({ length: 5 }, (_unused, i) =>
      adapter
        .withLock(name, async () => {
          successes.push(i);
          // Hold just long enough that the others' single attempts all fail.
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        })
        .catch((err: unknown) => {
          failures.push(err);
        }),
    );

    await Promise.all(calls);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(4);
    for (const err of failures) {
      expect(err).toBeInstanceOf(LockAcquisitionError);
    }
  });

  it("withLock still succeeds when acquisition succeeds on first attempt", async () => {
    const adapter = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 60_000,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    const name = lockName("success-first");
    const result = await adapter.withLock(name, () => Promise.resolve(99));
    expect(result).toBe(99);
    // Lock file must be released.
    expect(fs.existsSync(`${name}.lock`)).toBe(false);
  });

  it("withLock still succeeds when acquisition succeeds on a retry attempt", async () => {
    const adapter = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 60_000,
      maxRetries: 5,
      retryDelayMs: 5,
    });
    const name = lockName("success-retry");

    // Acquire manually then release after a short delay to simulate contention.
    await adapter.acquire(name);
    setTimeout(() => void adapter.release(name), 15);

    const result = await adapter.withLock(name, () => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(fs.existsSync(`${name}.lock`)).toBe(false);
  });
});

// ── PR-018: lock_contention and lock_acquisition_failed stderr events ──

describe("FileAdvisoryLockAdapter — contention warn events (PR-018)", () => {
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
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  it("emits lock_contention to stderr when a retry is needed", async () => {
    const adapter = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 60_000,
      maxRetries: 20,
      retryDelayMs: 10,
    });
    const name = lockName("contention-event");

    // Hold the lock so the first attempt fails.
    await adapter.acquire(name);
    // Release after a short delay so a retry eventually succeeds.
    // 30ms gives 3 retries (3 × 10ms) before release, guaranteeing at least
    // one lock_contention event.
    setTimeout(() => void adapter.release(name), 30);

    await adapter.withLock(name, () => Promise.resolve());

    const contentionEvents = stderrChunks
      .map((c) => {
        try {
          return JSON.parse(c.trim()) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((o) => o !== null && o["event"] === "lock_contention");

    expect(contentionEvents.length).toBeGreaterThanOrEqual(1);
    const first = contentionEvents[0]!;
    expect(first["lockName"]).toBe(name);
    expect(typeof first["attempt"]).toBe("number");
    expect(first["pid"]).toBe(process.pid);
  });

  it("emits lock_acquisition_failed to stderr when all retries are exhausted", async () => {
    const adapter = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 60_000,
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const name = lockName("acquisition-failed-event");

    // Hold the lock so all attempts fail.
    await adapter.acquire(name);

    try {
      await adapter.withLock(name, () => Promise.resolve());
    } catch (err) {
      expect(err).toBeInstanceOf(LockAcquisitionError);
    } finally {
      await adapter.release(name);
    }

    const failEvents = stderrChunks
      .map((c) => {
        try {
          return JSON.parse(c.trim()) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((o) => o !== null && o["event"] === "lock_acquisition_failed");

    expect(failEvents).toHaveLength(1);
    const ev = failEvents[0]!;
    expect(ev["lockName"]).toBe(name);
    expect(ev["attempts"]).toBe(2); // maxRetries=1 → totalAttempts=2
    expect(ev["pid"]).toBe(process.pid);
    expect(typeof ev["holderStat"]).toBe("object");
  });
});
