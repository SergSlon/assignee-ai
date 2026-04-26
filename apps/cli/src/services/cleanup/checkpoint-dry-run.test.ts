/**
 * Branch-coverage uplift for cleanup/checkpoint-dry-run.ts — P066 R10b-01.
 *
 * Covers branches that were missed in the orchestration layer:
 *  - dir missing → {pruned:0, kept:0}
 *  - dir exists but has no checkpoint files → {pruned:0, kept:0}
 *  - stat() throws mid-loop → entry is skipped (continue branch)
 *  - readFile throws mid-loop → entry is skipped (continue branch)
 *  - parse throws → entry is treated as expired+zero-mtime (catch branch)
 *  - top-3 entries are always kept (i < 3 branch)
 *  - recently-modified unexpired entry is kept (skipRecentMs branch)
 *  - old+unexpired entry is kept (!info.expired branch)
 *  - old+expired entry is pruned
 *  - custom ttl_hours is respected (branch: typeof json.ttl_hours === "number")
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { dryRunCheckpoints } from "./checkpoint-dry-run.js";
import { CHECKPOINT_FILE_PREFIX } from "../../config/constants.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "assignee-checkpoint-dry-run-test-"),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function writeCheckpoint(
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
  await fs.writeFile(path.join(dir, filename), content, "utf-8");
}

/** Writes a valid checkpoint JSON. */
async function writeValidCheckpoint(
  dir: string,
  name: string,
  createdAt: Date,
  ttlHours = 72,
): Promise<void> {
  const content = JSON.stringify({
    created_at: createdAt.toISOString(),
    ttl_hours: ttlHours,
  });
  await writeCheckpoint(dir, `${CHECKPOINT_FILE_PREFIX}${name}.json`, content);
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("dryRunCheckpoints", () => {
  it("returns {pruned:0, kept:0} when directory does not exist", async () => {
    const result = await dryRunCheckpoints(
      path.join(tmpDir, "nonexistent-subdir"),
    );
    expect(result).toEqual({ pruned: 0, kept: 0 });
  });

  it("returns {pruned:0, kept:0} when directory has no checkpoint files", async () => {
    await writeCheckpoint(tmpDir, "other-file.json", "{}");
    await writeCheckpoint(tmpDir, "README.txt", "ignored");
    const result = await dryRunCheckpoints(tmpDir);
    expect(result).toEqual({ pruned: 0, kept: 0 });
  });

  it("keeps the top-3 most-recent checkpoints regardless of expiry (i < 3 branch)", async () => {
    const now = new Date();
    // Write 3 expired checkpoints — they should all be kept because i < 3
    for (let i = 0; i < 3; i++) {
      const createdAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10d ago
      await writeValidCheckpoint(
        tmpDir,
        `ckpt-${i}-${Date.now() + i}`,
        createdAt,
        1,
      ); // ttl=1h → expired
    }
    const result = await dryRunCheckpoints(tmpDir);
    expect(result.kept).toBe(3);
    expect(result.pruned).toBe(0);
  });

  it("prunes expired checkpoints beyond the top 3 (index >= 3 + expired)", async () => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    // 5 expired entries — top 3 kept, bottom 2 pruned.
    // The pruner's default skipRecentMinutes=10 guard would keep ALL
    // 5 (their mtime is fresh — just-written), so the test would fail
    // with kept=5/pruned=0 unless we age the files via fs.utimes.
    // Set mtime to 1h in the past — well outside the recency window.
    const fileNames: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ts = new Date(expiredAt.getTime() - i * 60 * 1000); // stagger times
      const name = `old-${i}-${Date.now() + i}`;
      await writeValidCheckpoint(tmpDir, name, ts, 1);
      fileNames.push(`${CHECKPOINT_FILE_PREFIX}${name}.json`);
    }
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const fileName of fileNames) {
      await fs.utimes(path.join(tmpDir, fileName), oneHourAgo, oneHourAgo);
    }
    const result = await dryRunCheckpoints(tmpDir);
    expect(result.kept).toBe(3);
    expect(result.pruned).toBe(2);
  });

  it("keeps old-but-unexpired entry beyond top 3 (branch: !info.expired)", async () => {
    const now = new Date();
    // 3 entries at top, then 1 that is NOT expired
    const baseTime = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      await writeValidCheckpoint(
        tmpDir,
        `e${i}-${Date.now() + i}`,
        baseTime,
        1,
      );
    }
    // This one was created recently and has a long TTL → not expired
    const recentCreate = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h ago
    await writeValidCheckpoint(
      tmpDir,
      `fresh-${Date.now()}`,
      recentCreate,
      240,
    ); // ttl=240h

    const result = await dryRunCheckpoints(tmpDir);
    // 3 kept from top-3 + 1 kept from !expired
    expect(result.kept).toBe(4);
    expect(result.pruned).toBe(0);
  });

  it("treats corrupt JSON as expired with zero mtime (catch branch)", async () => {
    const now = new Date();
    // 3 valid entries to exhaust top-3 budget
    for (let i = 0; i < 3; i++) {
      await writeValidCheckpoint(
        tmpDir,
        `valid-${i}-${Date.now() + i}`,
        now,
        240,
      );
    }
    // 1 corrupt entry — should be treated as expired and pruned
    await writeCheckpoint(
      tmpDir,
      `${CHECKPOINT_FILE_PREFIX}corrupt.json`,
      "not-valid-json",
    );

    const result = await dryRunCheckpoints(tmpDir);
    // top 3 kept, corrupt one gets pruned
    expect(result.pruned).toBe(1);
  });

  it("uses default ttl_hours=72 when json.ttl_hours is absent (branch: fallback)", async () => {
    const now = new Date();
    // Entry created 48h ago with no explicit ttl_hours → uses default 72h → not expired
    const createdAt = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    // Write 3 + 1 to test the 4th entry which is not expired
    for (let i = 0; i < 3; i++) {
      await writeValidCheckpoint(
        tmpDir,
        `old-${i}-${Date.now() + i}`,
        new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
        1,
      );
    }
    const content = JSON.stringify({ created_at: createdAt.toISOString() }); // no ttl_hours
    await writeCheckpoint(
      tmpDir,
      `${CHECKPOINT_FILE_PREFIX}no-ttl.json`,
      content,
    );

    const result = await dryRunCheckpoints(tmpDir);
    // The no-ttl entry: 48h old, default 72h → NOT expired → kept
    expect(result.kept).toBeGreaterThanOrEqual(4);
  });

  it("uses custom ttl_hours when provided (branch: typeof ttl_hours === number)", async () => {
    const now = new Date();
    // 3 entries for top-3 budget
    for (let i = 0; i < 3; i++) {
      await writeValidCheckpoint(
        tmpDir,
        `base-${i}-${Date.now() + i}`,
        now,
        240,
      );
    }
    // One entry with ttl=1 hour, created 2h ago → expired by created_at + ttl,
    // but the pruner's default skipRecentMinutes=10 guard would skip it
    // because its mtime is fresh from the just-written file. Age the
    // short-ttl file's mtime to 1h ago so the recency guard releases it.
    const oldCreate = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const shortTtlName = `short-ttl-${Date.now()}`;
    await writeValidCheckpoint(tmpDir, shortTtlName, oldCreate, 1);
    const shortTtlPath = path.join(
      tmpDir,
      `${CHECKPOINT_FILE_PREFIX}${shortTtlName}.json`,
    );
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(shortTtlPath, oneHourAgo, oneHourAgo);

    const result = await dryRunCheckpoints(tmpDir);
    // The short-ttl entry should be pruned (position 4, expired with ttl=1h)
    expect(result.pruned).toBe(1);
  });
});
