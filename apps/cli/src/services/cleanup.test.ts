/**
 * Tests for cleanup orchestrator (Story 33.2).
 * Mocks the three cleanup primitives (checkpoint, cache, memory) to test orchestration logic.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Mock the primitives before importing the module under test.
// NOTE: Default impls are re-applied in beforeEach because mockReset:true
// wipes vi.fn implementations between tests.
// Story 51-it1 Wave B2: checkpoint primitives live in @assignee/core — mock
// the package path so the orchestrator's import is intercepted.
vi.mock("@assignee/core/checkpoint", () => ({
  pruneExpiredCheckpoints: vi.fn(),
}));

vi.mock("./price-cache.js", () => ({
  sweepExpiredPrices: vi.fn(),
}));

import {
  runFullCleanup,
  runAutoCleanup,
  formatCleanupReport,
  type CleanupReport,
} from "./cleanup.js";
import { pruneExpiredCheckpoints } from "@assignee/core/checkpoint";
import { sweepExpiredPrices } from "./price-cache.js";

/** Minimal mock MemoryService that satisfies the orchestrator's needs. */
function createMockMemoryService() {
  return {
    rotateProvisions: vi.fn().mockResolvedValue(10),
    rotateFailures: vi.fn().mockResolvedValue(5),
    rotatePatterns: vi.fn().mockResolvedValue(2),
    readProvisions: vi.fn().mockResolvedValue([]),
    readFailures: vi.fn().mockResolvedValue([]),
    readPatterns: vi.fn().mockResolvedValue([]),
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-cleanup-test-"));
  vi.clearAllMocks();
  (pruneExpiredCheckpoints as Mock).mockResolvedValue({ pruned: 5, kept: 3 });
  (sweepExpiredPrices as Mock).mockReturnValue({ removed: 12, remaining: 8 });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── runFullCleanup ─────────────────────────────────────────────────

describe("runFullCleanup", () => {
  it("calls all three primitives when no categories filter is given", async () => {
    const mem = createMockMemoryService();

    const report = await runFullCleanup({
      checkpointDir: tmpDir,
      memoryService: mem as never,
      dryRun: false,
    });

    expect(pruneExpiredCheckpoints).toHaveBeenCalledWith(tmpDir);
    expect(sweepExpiredPrices).toHaveBeenCalled();
    expect(mem.rotateProvisions).toHaveBeenCalled();
    expect(mem.rotateFailures).toHaveBeenCalled();
    expect(mem.rotatePatterns).toHaveBeenCalled();

    expect(report.checkpoints).toEqual({ pruned: 5, kept: 3 });
    expect(report.cache).toEqual({ removed: 12, remaining: 8 });
    expect(report.memory).toEqual({ provisions: 10, failures: 5, patterns: 2 });
  });

  it("filters to checkpoints-only when categories=['checkpoints']", async () => {
    const mem = createMockMemoryService();

    const report = await runFullCleanup({
      checkpointDir: tmpDir,
      memoryService: mem as never,
      dryRun: false,
      categories: ["checkpoints"],
    });

    expect(pruneExpiredCheckpoints).toHaveBeenCalled();
    expect(sweepExpiredPrices).not.toHaveBeenCalled();
    expect(mem.rotateProvisions).not.toHaveBeenCalled();

    // Non-selected categories should be zeros
    expect(report.cache).toEqual({ removed: 0, remaining: 0 });
    expect(report.memory).toEqual({ provisions: 0, failures: 0, patterns: 0 });
  });

  it("filters to cache-only when categories=['cache']", async () => {
    const mem = createMockMemoryService();

    const report = await runFullCleanup({
      checkpointDir: tmpDir,
      memoryService: mem as never,
      dryRun: false,
      categories: ["cache"],
    });

    expect(pruneExpiredCheckpoints).not.toHaveBeenCalled();
    expect(sweepExpiredPrices).toHaveBeenCalled();
    expect(mem.rotateProvisions).not.toHaveBeenCalled();

    expect(report.checkpoints).toEqual({ pruned: 0, kept: 0 });
    expect(report.cache).toEqual({ removed: 12, remaining: 8 });
  });

  it("filters to memory-only when categories=['memory']", async () => {
    const mem = createMockMemoryService();

    const report = await runFullCleanup({
      checkpointDir: tmpDir,
      memoryService: mem as never,
      dryRun: false,
      categories: ["memory"],
    });

    expect(pruneExpiredCheckpoints).not.toHaveBeenCalled();
    expect(sweepExpiredPrices).not.toHaveBeenCalled();
    expect(mem.rotateProvisions).toHaveBeenCalled();
    expect(mem.rotateFailures).toHaveBeenCalled();
    expect(mem.rotatePatterns).toHaveBeenCalled();

    expect(report.memory).toEqual({ provisions: 10, failures: 5, patterns: 2 });
  });

  it("does not call mutation primitives in dryRun mode", async () => {
    const mem = createMockMemoryService();

    await runFullCleanup({
      checkpointDir: tmpDir,
      memoryService: mem as never,
      dryRun: true,
    });

    // In dry-run mode, the actual mutation functions should NOT be called
    expect(pruneExpiredCheckpoints).not.toHaveBeenCalled();
    expect(sweepExpiredPrices).not.toHaveBeenCalled();
    expect(mem.rotateProvisions).not.toHaveBeenCalled();
    expect(mem.rotateFailures).not.toHaveBeenCalled();
    expect(mem.rotatePatterns).not.toHaveBeenCalled();

    // Read-only functions are used for counting
    expect(mem.readProvisions).toHaveBeenCalled();
    expect(mem.readFailures).toHaveBeenCalled();
    expect(mem.readPatterns).toHaveBeenCalled();
  });

  it("returns zero-count report when checkpoint directory does not exist", async () => {
    const mem = createMockMemoryService();
    const nonExistent = path.join(tmpDir, "does-not-exist");

    // Make checkpoint mock return zeros for non-existent dir
    (pruneExpiredCheckpoints as Mock).mockResolvedValueOnce({
      pruned: 0,
      kept: 0,
    });

    const report = await runFullCleanup({
      checkpointDir: nonExistent,
      memoryService: mem as never,
      dryRun: false,
    });

    expect(report.checkpoints).toEqual({ pruned: 0, kept: 0 });
  });

  it("continues running other categories when one primitive throws", async () => {
    const mem = createMockMemoryService();
    (pruneExpiredCheckpoints as Mock).mockRejectedValueOnce(
      new Error("disk error"),
    );

    const report = await runFullCleanup({
      checkpointDir: tmpDir,
      memoryService: mem as never,
      dryRun: false,
    });

    // Checkpoint should stay zero due to error
    expect(report.checkpoints).toEqual({ pruned: 0, kept: 0 });
    // Other categories should still have run
    expect(report.cache).toEqual({ removed: 12, remaining: 8 });
    expect(report.memory).toEqual({ provisions: 10, failures: 5, patterns: 2 });
  });
});

// ─── runAutoCleanup ─────────────────────────────────────────────────

describe("runAutoCleanup", () => {
  const realCacheDir = path.join(os.homedir(), ".assignee", "cache");
  const realLastCleanup = path.join(realCacheDir, ".last-cleanup");

  // Every auto-cleanup test must save/restore the real .last-cleanup file
  // because runAutoCleanup reads/writes it at the real path.
  let savedContent: string | null;

  beforeEach(async () => {
    savedContent = null;
    try {
      savedContent = await fs.readFile(realLastCleanup, "utf-8");
    } catch {
      // File doesn't exist — that's fine
    }
    // Remove the file so each test starts with a clean slate
    try {
      await fs.unlink(realLastCleanup);
    } catch {
      // Ignore
    }
  });

  afterEach(async () => {
    // Restore original content
    if (savedContent !== null) {
      await fs.mkdir(realCacheDir, { recursive: true });
      await fs.writeFile(realLastCleanup, savedContent, "utf-8");
    } else {
      try {
        await fs.unlink(realLastCleanup);
      } catch {
        // Ignore
      }
    }
  });

  it("runs checkpoint pruning and cache sweep (not memory rotation)", async () => {
    const mem = createMockMemoryService();

    await runAutoCleanup(tmpDir, mem as never);

    expect(pruneExpiredCheckpoints).toHaveBeenCalledWith(tmpDir, {
      skipRecentMinutes: 10,
    });
    expect(sweepExpiredPrices).toHaveBeenCalled();
    expect(mem.rotateProvisions).not.toHaveBeenCalled();
    expect(mem.rotateFailures).not.toHaveBeenCalled();
    expect(mem.rotatePatterns).not.toHaveBeenCalled();
  });

  it("writes .last-cleanup timestamp after successful run", async () => {
    const mem = createMockMemoryService();

    await runAutoCleanup(tmpDir, mem as never);

    // Verify primitives were called (means throttle didn't block)
    expect(pruneExpiredCheckpoints).toHaveBeenCalled();

    // Verify the timestamp file was written
    const content = await fs.readFile(realLastCleanup, "utf-8");
    const written = new Date(content.trim());
    expect(written.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("skips cleanup when .last-cleanup is recent (throttled)", async () => {
    const mem = createMockMemoryService();

    await fs.mkdir(realCacheDir, { recursive: true });
    // Write a timestamp from just now
    await fs.writeFile(realLastCleanup, new Date().toISOString(), "utf-8");

    await runAutoCleanup(tmpDir, mem as never);

    // Should have been throttled — no primitives called
    expect(pruneExpiredCheckpoints).not.toHaveBeenCalled();
    expect(sweepExpiredPrices).not.toHaveBeenCalled();
  });

  it("runs cleanup when .last-cleanup is stale (older than interval)", async () => {
    const mem = createMockMemoryService();

    await fs.mkdir(realCacheDir, { recursive: true });
    // Write a timestamp from 2 hours ago
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(realLastCleanup, staleTime, "utf-8");

    await runAutoCleanup(tmpDir, mem as never);

    // Should NOT be throttled — primitives should be called
    expect(pruneExpiredCheckpoints).toHaveBeenCalled();
    expect(sweepExpiredPrices).toHaveBeenCalled();
  });

  it("swallows errors from primitives — never throws", async () => {
    const mem = createMockMemoryService();
    (pruneExpiredCheckpoints as Mock).mockRejectedValueOnce(new Error("boom"));

    // Must not throw
    await expect(runAutoCleanup(tmpDir, mem as never)).resolves.toBeUndefined();
  });

  it("swallows errors from cache sweep — never throws", async () => {
    const mem = createMockMemoryService();
    (sweepExpiredPrices as Mock).mockImplementationOnce(() => {
      throw new Error("cache kaboom");
    });

    await expect(runAutoCleanup(tmpDir, mem as never)).resolves.toBeUndefined();
  });
});

// ─── formatCleanupReport ────────────────────────────────────────────

describe("formatCleanupReport", () => {
  const sampleReport: CleanupReport = {
    checkpoints: { pruned: 5, kept: 3 },
    memory: { provisions: 100, failures: 0, patterns: 0 },
    cache: { removed: 12, remaining: 8 },
  };

  it("formats a human-readable table for normal cleanup", () => {
    const output = formatCleanupReport(sampleReport, false);

    expect(output).toContain("Cleanup complete:");
    expect(output).toContain("Checkpoints");
    expect(output).toContain("5");
    expect(output).toContain("3");
    expect(output).toContain("Price cache");
    expect(output).toContain("12");
    expect(output).toContain("8");
    expect(output).toContain("Provisions");
    expect(output).toContain("100");
    expect(output).toContain("Failures");
    expect(output).toContain("Patterns");
  });

  it("shows dry-run header when dryRun is true", () => {
    const output = formatCleanupReport(sampleReport, true);

    expect(output).toContain("Preview (dry-run)");
    expect(output).toContain("no changes made");
    expect(output).not.toContain("Cleanup complete:");
  });

  it("includes column headers", () => {
    const output = formatCleanupReport(sampleReport, false);

    expect(output).toContain("Category");
    expect(output).toContain("Cleaned");
    expect(output).toContain("Remaining");
  });

  it("formats zero-count report without errors", () => {
    const zeroReport: CleanupReport = {
      checkpoints: { pruned: 0, kept: 0 },
      memory: { provisions: 0, failures: 0, patterns: 0 },
      cache: { removed: 0, remaining: 0 },
    };

    const output = formatCleanupReport(zeroReport, false);

    expect(output).toContain("Cleanup complete:");
    expect(output).toContain("Checkpoints");
    expect(output).toContain("0");
  });
});
