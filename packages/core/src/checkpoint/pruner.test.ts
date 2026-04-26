/**
 * Tests for `pruneExpiredCheckpoints` (pruner.ts).
 *
 * Recovery-path focus (P035 — 0 % coverage closure):
 *   - Empty directory → {pruned:0, kept:0}
 *   - Directory does not exist → {pruned:0, kept:0} (no throw)
 *   - All files fresh → all kept
 *   - All files expired (beyond KEEP_NEWEST_COUNT) → oldest pruned
 *   - KEEP_NEWEST_COUNT invariant: the 3 newest are ALWAYS kept
 *     regardless of TTL
 *   - skipRecentMinutes guard: recently-modified files are not pruned
 *     even if expired
 *   - Default skipRecentMinutes (10 min) is honoured
 *   - Custom skipRecentMinutes=0 disables the guard
 *   - Corrupt JSON files are skipped silently (no crash)
 *   - Non-checkpoint-*.json files in directory are ignored
 *   - Concurrent-write-safe: files modified within skipRecentMinutes
 *     are skipped even when expired
 *
 * Real fixtures used where fully-populated checkpoints are needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pruneExpiredCheckpoints } from "./pruner.js";
import { CHECKPOINT_VERSION } from "../schema/checkpoint.js";
import type { PlanCheckpoint } from "../schema/checkpoint.js";

// ── helpers ───────────────────────────────────────────────────────────

function makeCheckpoint(
  overrides: Partial<PlanCheckpoint> = {},
): PlanCheckpoint {
  return {
    checkpoint_version: CHECKPOINT_VERSION,
    created_at: new Date().toISOString(),
    ttl_hours: 72,
    runId: crypto.randomUUID(),
    userIntent: "Create an S3 bucket",
    resourceType: "AWS::S3::Bucket",
    desiredState: { BucketName: "my-bucket" },
    estimatedMonthlyCost: "$0.02",
    preflightPassed: true,
    currentResourceIndex: 0,
    completedResources: [],
    ...overrides,
  };
}

/** Write a checkpoint-*.json file into a directory. */
async function writeCheckpoint(
  dir: string,
  cp: PlanCheckpoint,
): Promise<string> {
  const filePath = path.join(dir, `checkpoint-${cp.runId}.json`);
  await fs.writeFile(filePath, JSON.stringify(cp, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return filePath;
}

/** Backdates the mtime of a file to simulate an "old" modification time. */
async function backdateMtime(filePath: string, ageMs: number): Promise<void> {
  const target = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, target, target);
}

// ── setup ─────────────────────────────────────────────────────────────

describe("pruneExpiredCheckpoints", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-pruner-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── directory-level edge cases ────────────────────────────────────────

  it("RECOVERY: returns {pruned:0, kept:0} when directory does not exist (no throw)", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    const result = await pruneExpiredCheckpoints(missing);
    expect(result).toEqual({ pruned: 0, kept: 0 });
  });

  it("returns {pruned:0, kept:0} for an empty directory", async () => {
    const result = await pruneExpiredCheckpoints(tmpDir);
    expect(result).toEqual({ pruned: 0, kept: 0 });
  });

  it("returns {pruned:0, kept:0} when directory has no checkpoint-*.json files", async () => {
    await fs.writeFile(path.join(tmpDir, "not-a-checkpoint.json"), '{"x":1}');
    await fs.writeFile(path.join(tmpDir, "README.md"), "readme");
    const result = await pruneExpiredCheckpoints(tmpDir);
    expect(result).toEqual({ pruned: 0, kept: 0 });
  });

  // ── basic prune semantics ─────────────────────────────────────────────

  it("keeps a single fresh checkpoint", async () => {
    const cp = makeCheckpoint();
    const filePath = await writeCheckpoint(tmpDir, cp);
    await backdateMtime(filePath, 20 * 60 * 1000); // mtime 20 min ago (outside guard)
    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    expect(result.kept).toBe(1);
    expect(result.pruned).toBe(0);
    // File still exists
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("prunes a single expired checkpoint when it is beyond KEEP_NEWEST_COUNT=3 threshold", async () => {
    // Create 4 checkpoints (KEEP_NEWEST=3), the oldest expired
    const fresh1 = makeCheckpoint({
      created_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    });
    const fresh2 = makeCheckpoint({
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const fresh3 = makeCheckpoint({
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    const expired = makeCheckpoint({
      created_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });

    const p1 = await writeCheckpoint(tmpDir, fresh1);
    const p2 = await writeCheckpoint(tmpDir, fresh2);
    const p3 = await writeCheckpoint(tmpDir, fresh3);
    const pe = await writeCheckpoint(tmpDir, expired);

    // Backdate all mtimes so the skipRecentMinutes guard does not protect them
    const oldMs = 20 * 60 * 1000; // 20 min ago
    await backdateMtime(p1, oldMs);
    await backdateMtime(p2, oldMs);
    await backdateMtime(p3, oldMs);
    await backdateMtime(pe, oldMs);

    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    expect(result.pruned).toBe(1);
    expect(result.kept).toBe(3);

    // The expired file should be gone
    await expect(fs.access(pe)).rejects.toThrow();
    // The fresh ones should still be there
    await expect(fs.access(p1)).resolves.toBeUndefined();
    await expect(fs.access(p2)).resolves.toBeUndefined();
    await expect(fs.access(p3)).resolves.toBeUndefined();
  });

  it("prunes multiple expired checkpoints beyond the top-3 window", async () => {
    // 3 fresh (top-3 kept) + 3 expired beyond it
    const now = Date.now();
    const cps = [
      makeCheckpoint({
        created_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      }),
      makeCheckpoint({
        created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      }),
      makeCheckpoint({
        created_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      }),
      makeCheckpoint({
        created_at: new Date(now - 100 * 60 * 60 * 1000).toISOString(),
        ttl_hours: 72,
      }),
      makeCheckpoint({
        created_at: new Date(now - 110 * 60 * 60 * 1000).toISOString(),
        ttl_hours: 72,
      }),
      makeCheckpoint({
        created_at: new Date(now - 120 * 60 * 60 * 1000).toISOString(),
        ttl_hours: 72,
      }),
    ];

    const paths = await Promise.all(
      cps.map((cp) => writeCheckpoint(tmpDir, cp)),
    );
    const oldMs = 20 * 60 * 1000;
    await Promise.all(paths.map((p) => backdateMtime(p, oldMs)));

    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    expect(result.pruned).toBe(3);
    expect(result.kept).toBe(3);
  });

  // ── KEEP_NEWEST_COUNT invariant ───────────────────────────────────────

  it("KEEP_NEWEST_COUNT=3 invariant: the 3 newest are always kept regardless of TTL", async () => {
    // All 3 checkpoints are expired, but there are exactly 3 — they must all be kept
    const expired1 = makeCheckpoint({
      created_at: new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });
    const expired2 = makeCheckpoint({
      created_at: new Date(Date.now() - 150 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });
    const expired3 = makeCheckpoint({
      created_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });

    const p1 = await writeCheckpoint(tmpDir, expired1);
    const p2 = await writeCheckpoint(tmpDir, expired2);
    const p3 = await writeCheckpoint(tmpDir, expired3);

    const oldMs = 20 * 60 * 1000;
    await backdateMtime(p1, oldMs);
    await backdateMtime(p2, oldMs);
    await backdateMtime(p3, oldMs);

    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    // 3 expired files, all in top-3 by newest → all kept
    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(3);
  });

  it("KEEP_NEWEST_COUNT=3: the 4th-oldest expired checkpoint IS pruned", async () => {
    const now = Date.now();
    // 3 "newest" (expired but newer), 1 more expired
    const cps = [
      makeCheckpoint({
        created_at: new Date(now - 80 * 60 * 60 * 1000).toISOString(),
        ttl_hours: 72,
      }),
      makeCheckpoint({
        created_at: new Date(now - 90 * 60 * 60 * 1000).toISOString(),
        ttl_hours: 72,
      }),
      makeCheckpoint({
        created_at: new Date(now - 100 * 60 * 60 * 1000).toISOString(),
        ttl_hours: 72,
      }),
      makeCheckpoint({
        created_at: new Date(now - 110 * 60 * 60 * 1000).toISOString(),
        ttl_hours: 72,
      }),
    ];

    const paths = await Promise.all(
      cps.map((cp) => writeCheckpoint(tmpDir, cp)),
    );
    const oldMs = 20 * 60 * 1000;
    await Promise.all(paths.map((p) => backdateMtime(p, oldMs)));

    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    expect(result.pruned).toBe(1);
    expect(result.kept).toBe(3);
  });

  // ── skipRecentMinutes concurrent-write guard ──────────────────────────

  it("RECOVERY/concurrent-write: recently-modified files are not pruned even when expired", async () => {
    // This simulates an in-flight writer that just updated the file
    // (its mtime is within the skipRecentMinutes window) — we must NOT
    // stomp it even if the checkpoint itself appears expired.
    const expired = makeCheckpoint({
      created_at: new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });
    const fresh1 = makeCheckpoint({
      created_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    });
    const fresh2 = makeCheckpoint({
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const fresh3 = makeCheckpoint({
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });

    await writeCheckpoint(tmpDir, fresh1);
    await writeCheckpoint(tmpDir, fresh2);
    await writeCheckpoint(tmpDir, fresh3);
    const expiredPath = await writeCheckpoint(tmpDir, expired);
    // Backdate the top-3 so they are beyond the skip window
    const oldMs = 20 * 60 * 1000;
    await backdateMtime(
      path.join(tmpDir, `checkpoint-${fresh1.runId}.json`),
      oldMs,
    );
    await backdateMtime(
      path.join(tmpDir, `checkpoint-${fresh2.runId}.json`),
      oldMs,
    );
    await backdateMtime(
      path.join(tmpDir, `checkpoint-${fresh3.runId}.json`),
      oldMs,
    );
    // Leave the expired file's mtime as "just now" (< skipRecentMinutes=5 guard)
    // → it should be KEPT even though it is past the top-3 AND expired

    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 5,
    });
    // expired file is rank-4 (oldest) but its mtime is within 5 min → kept
    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(4);
    await expect(fs.access(expiredPath)).resolves.toBeUndefined();
  });

  it("RECOVERY/concurrent-write: skipRecentMinutes=0 disables the mtime guard and prunes normally", async () => {
    const fresh1 = makeCheckpoint({
      created_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    });
    const fresh2 = makeCheckpoint({
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const fresh3 = makeCheckpoint({
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    const expired = makeCheckpoint({
      created_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });

    await writeCheckpoint(tmpDir, fresh1);
    await writeCheckpoint(tmpDir, fresh2);
    await writeCheckpoint(tmpDir, fresh3);
    const expiredPath = await writeCheckpoint(tmpDir, expired);
    // With skipRecentMinutes=0, the mtime guard's threshold is 0 ms.
    // Pin the expired file's mtime explicitly to a known past time so the
    // `now - mtime < 0` check is deterministic — under coverage
    // instrumentation, fs-mtime vs Date.now() can drift by a few ms,
    // making `now - mtime` momentarily negative on macOS and accidentally
    // triggering the skip guard. Setting mtime 1s into the past removes
    // the race window.
    const onePastSec = new Date(Date.now() - 1_000);
    await fs.utimes(expiredPath, onePastSec, onePastSec);
    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    expect(result.pruned).toBe(1);
    await expect(fs.access(expiredPath)).rejects.toThrow();
  });

  it("default skipRecentMinutes honours the 10-minute guard for very-recently-modified files", async () => {
    // Create 4 checkpoints so the expired one would otherwise be pruned.
    const now = Date.now();
    const fresh1 = makeCheckpoint({
      created_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
    });
    const fresh2 = makeCheckpoint({
      created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    });
    const fresh3 = makeCheckpoint({
      created_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    });
    const expired = makeCheckpoint({
      created_at: new Date(now - 200 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });

    const p1 = await writeCheckpoint(tmpDir, fresh1);
    const p2 = await writeCheckpoint(tmpDir, fresh2);
    const p3 = await writeCheckpoint(tmpDir, fresh3);
    const pe = await writeCheckpoint(tmpDir, expired);

    // Backdate top-3 to be beyond the 10-min window
    const oldMs = 15 * 60 * 1000; // 15 min ago
    await backdateMtime(p1, oldMs);
    await backdateMtime(p2, oldMs);
    await backdateMtime(p3, oldMs);
    // Leave expired file mtime as "just now" (< 10 min) — default guard should protect it
    // (no backdateMtime call on pe)

    // Use default skipRecentMinutes (10 min)
    const result = await pruneExpiredCheckpoints(tmpDir);
    // The expired file is within the 10-min mtime window → kept
    expect(result.kept).toBeGreaterThanOrEqual(4);
    expect(result.pruned).toBe(0);
    await expect(fs.access(pe)).resolves.toBeUndefined();
  });

  // ── corrupt-file tolerance ────────────────────────────────────────────

  it("RECOVERY: silently skips corrupt JSON files without throwing", async () => {
    const goodCp = makeCheckpoint({ created_at: new Date().toISOString() });
    const goodCp2 = makeCheckpoint({
      created_at: new Date(Date.now() - 1000).toISOString(),
    });
    const goodCp3 = makeCheckpoint({
      created_at: new Date(Date.now() - 2000).toISOString(),
    });

    await writeCheckpoint(tmpDir, goodCp);
    await writeCheckpoint(tmpDir, goodCp2);
    await writeCheckpoint(tmpDir, goodCp3);

    // Inject a corrupt file
    const corruptId = crypto.randomUUID();
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${corruptId}.json`),
      "not-valid-json{{{{",
    );

    // Should not throw — corrupt file is silently skipped
    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    // 3 valid files + 1 corrupt (stat readable but content corrupt →
    // pruner reads content so it skips corrupt in collectFileInfos)
    expect(result.pruned + result.kept).toBeGreaterThanOrEqual(3);
  });

  it("RECOVERY: handles a directory with ONLY corrupt files gracefully", async () => {
    await fs.writeFile(path.join(tmpDir, "checkpoint-bad1.json"), "broken{{");
    await fs.writeFile(path.join(tmpDir, "checkpoint-bad2.json"), "");
    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    expect(typeof result.pruned).toBe("number");
    expect(typeof result.kept).toBe("number");
  });

  // ── return-value semantics ────────────────────────────────────────────

  it("return value pruned + kept equals total processed files", async () => {
    const cps = Array.from({ length: 5 }, (_, i) =>
      makeCheckpoint({
        created_at: new Date(Date.now() - i * 60 * 60 * 1000).toISOString(),
        ttl_hours: i > 2 ? 1 : 72, // files at index 3, 4 will be expired (older than 1h)
      }),
    );

    const paths = await Promise.all(
      cps.map((cp) => writeCheckpoint(tmpDir, cp)),
    );
    const oldMs = 20 * 60 * 1000;
    await Promise.all(paths.map((p) => backdateMtime(p, oldMs)));

    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    expect(result.pruned + result.kept).toBe(5);
  });
});
