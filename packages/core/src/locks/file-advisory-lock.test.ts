/**
 * W4-03 (Epic 100 Round 3) — FileAdvisoryLockAdapter module tests.
 *
 * Re-exports + verifies the module-level default instance and constants.
 * Port-contract tests live in advisory-lock-port.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  defaultFileAdvisoryLock,
  FILE_LOCK_STALE_TIMEOUT_MS,
  FILE_LOCK_MAX_RETRIES,
  FILE_LOCK_RETRY_DELAY_MS,
  FileAdvisoryLockAdapter,
} from "./file-advisory-lock.js";

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
});
