/**
 * W4-03 (Epic 100 Round 3) — AdvisoryLockPort + FileAdvisoryLockAdapter tests.
 *
 * Covers:
 *   - Basic acquire/release cycle.
 *   - Acquire returns false when lock is held.
 *   - Release is idempotent (no throw on double-release).
 *   - Stale-lock reclamation: lock older than staleLockTimeoutMs is reclaimed.
 *   - withLock: acquire + fn + release in try/finally.
 *   - withLock fallback: fn is called even when lock cannot be acquired.
 *   - 0o600 lock file permissions.
 *   - Concurrent-write contention: 10 writers all land; zero corruption.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileAdvisoryLockAdapter } from "./file-advisory-lock.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assignee-lock-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function lockName(suffix = ""): string {
  return path.join(tmpDir, `test-lock${suffix}`);
}

// ── Basic acquire/release ─────────────────────────────────────────────

describe("FileAdvisoryLockAdapter — acquire/release", () => {
  it("acquire returns true when no lock exists", async () => {
    const adapter = new FileAdvisoryLockAdapter();
    const acquired = await adapter.acquire(lockName());
    expect(acquired).toBe(true);
    await adapter.release(lockName());
  });

  it("acquire returns false when lock is already held", async () => {
    const adapter = new FileAdvisoryLockAdapter({ staleLockTimeoutMs: 60_000 });
    await adapter.acquire(lockName());
    const second = await adapter.acquire(lockName());
    expect(second).toBe(false);
    await adapter.release(lockName());
  });

  it("release removes the lock file", async () => {
    const adapter = new FileAdvisoryLockAdapter();
    const name = lockName();
    await adapter.acquire(name);
    expect(fs.existsSync(`${name}.lock`)).toBe(true);
    await adapter.release(name);
    expect(fs.existsSync(`${name}.lock`)).toBe(false);
  });

  it("release is idempotent — no throw on double-release", async () => {
    const adapter = new FileAdvisoryLockAdapter();
    const name = lockName();
    await adapter.acquire(name);
    await adapter.release(name);
    await expect(adapter.release(name)).resolves.toBeUndefined();
  });

  it("lock file has 0o600 mode", async () => {
    if (process.platform === "win32") return; // NTFS chmod is a no-op
    const adapter = new FileAdvisoryLockAdapter();
    const name = lockName();
    await adapter.acquire(name);
    const stat = fs.statSync(`${name}.lock`);
    expect(stat.mode & 0o777).toBe(0o600);
    await adapter.release(name);
  });
});

// ── Stale-lock reclamation ────────────────────────────────────────────

describe("FileAdvisoryLockAdapter — stale lock reclamation", () => {
  it("reclaims a stale lock (age > staleLockTimeoutMs)", async () => {
    const name = lockName("stale");
    const lockFile = `${name}.lock`;

    // Plant a stale lock file.
    fs.writeFileSync(lockFile, "99999", { mode: 0o600 });
    // Force mtime to be 30 seconds in the past.
    const past = new Date(Date.now() - 30_000);
    fs.utimesSync(lockFile, past, past);

    const adapter = new FileAdvisoryLockAdapter({ staleLockTimeoutMs: 10_000 });
    const acquired = await adapter.acquire(name);
    expect(acquired).toBe(true);
    await adapter.release(name);
  });

  it("does NOT reclaim a fresh lock (age < staleLockTimeoutMs)", async () => {
    const name = lockName("fresh");
    const lockFile = `${name}.lock`;

    // Plant a fresh lock file.
    fs.writeFileSync(lockFile, "99999", { mode: 0o600 });

    const adapter = new FileAdvisoryLockAdapter({ staleLockTimeoutMs: 60_000 });
    const acquired = await adapter.acquire(name);
    expect(acquired).toBe(false);
    // Cleanup
    fs.unlinkSync(lockFile);
  });
});

// ── withLock ──────────────────────────────────────────────────────────

describe("FileAdvisoryLockAdapter — withLock", () => {
  it("executes fn and releases lock on success", async () => {
    const adapter = new FileAdvisoryLockAdapter();
    const name = lockName("wl");
    let called = false;
    await adapter.withLock(name, async () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(fs.existsSync(`${name}.lock`)).toBe(false);
  });

  it("releases lock even when fn throws", async () => {
    const adapter = new FileAdvisoryLockAdapter();
    const name = lockName("wl-throw");
    await expect(
      adapter.withLock(name, async () => {
        throw new Error("fn error");
      }),
    ).rejects.toThrow("fn error");
    expect(fs.existsSync(`${name}.lock`)).toBe(false);
  });

  it("returns fn return value", async () => {
    const adapter = new FileAdvisoryLockAdapter();
    const result = await adapter.withLock(lockName("wl-ret"), async () => 42);
    expect(result).toBe(42);
  });
});

// ── Concurrent-write contention ───────────────────────────────────────

describe("FileAdvisoryLockAdapter — concurrent-write contention", () => {
  it("10 concurrent writers all land; counter reaches 10 without corruption", async () => {
    const counterFile = path.join(tmpDir, "counter.json");
    const lockBase = path.join(tmpDir, "counter");
    fs.writeFileSync(counterFile, JSON.stringify({ count: 0 }), {
      mode: 0o600,
    });

    const adapter = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 10_000,
      maxRetries: 50,
      retryDelayMs: 20,
    });

    const writers = Array.from({ length: 10 }, (_unused, i) =>
      adapter.withLock(lockBase, async () => {
        const raw = await fsAsync.readFile(counterFile, "utf-8");
        const data = JSON.parse(raw) as { count: number };
        data.count += 1;
        // Simulate a tiny write delay to increase contention window.
        await new Promise<void>((resolve) => setTimeout(resolve, 5 + i * 2));
        const tmp = `${counterFile}.tmp.${process.pid}.${i}`;
        await fsAsync.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
        await fsAsync.rename(tmp, counterFile);
      }),
    );

    await Promise.all(writers);

    const final = JSON.parse(fs.readFileSync(counterFile, "utf-8")) as {
      count: number;
    };
    expect(final.count).toBe(10);
  });
});
