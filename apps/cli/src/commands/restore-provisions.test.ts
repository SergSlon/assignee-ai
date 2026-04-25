/**
 * W4-04 (Epic 100 Round 3) — restore-provisions command tests.
 *
 * Covers:
 *   - Restore from latest backup (--from omitted).
 *   - Restore from explicit --from date.
 *   - Invalid --from date format returns error message.
 *   - Non-existent backup returns error message.
 *   - Restored file has 0o600 mode.
 *   - Safety copy of current provisions.json is created before overwrite.
 *   - No-ops gracefully when backup directory is empty.
 *   - Idempotent: restoring the same backup twice yields identical content.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { restoreProvisions } from "./restore-provisions.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpRoot: string;
let memoryDir: string;
let backupDir: string;

const BACKUP_PREFIX = "provisions-";

function makeBackupName(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return `${BACKUP_PREFIX}${d.toISOString().slice(0, 10)}.json`;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "assignee-restore-test-"));
  memoryDir = path.join(tmpRoot, "memory");
  backupDir = path.join(tmpRoot, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("restoreProvisions", () => {
  it("restores from the latest backup when --from is omitted", async () => {
    const content = JSON.stringify([{ runId: "latest-run" }]);
    const olderName = makeBackupName(3);
    const newerName = makeBackupName(1);
    fs.writeFileSync(
      path.join(backupDir, olderName),
      JSON.stringify([{ runId: "older" }]),
      "utf-8",
    );
    fs.writeFileSync(path.join(backupDir, newerName), content, "utf-8");

    const result = await restoreProvisions({ memoryDir, backupDir });
    expect(result.restored).toBe(true);
    const restored = fs.readFileSync(
      path.join(memoryDir, "provisions.json"),
      "utf-8",
    );
    expect(JSON.parse(restored)[0].runId).toBe("latest-run");
  });

  it("restores from a specific --from date", async () => {
    const targetDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const backupContent = JSON.stringify([{ runId: "specific-date-run" }]);
    fs.writeFileSync(
      path.join(backupDir, `provisions-${targetDate}.json`),
      backupContent,
      "utf-8",
    );
    // Also plant a newer backup to ensure --from overrides latest
    fs.writeFileSync(
      path.join(backupDir, makeBackupName(0)),
      JSON.stringify([{ runId: "newer-run" }]),
      "utf-8",
    );

    const result = await restoreProvisions({
      from: targetDate,
      memoryDir,
      backupDir,
    });
    expect(result.restored).toBe(true);
    const restored = fs.readFileSync(
      path.join(memoryDir, "provisions.json"),
      "utf-8",
    );
    expect(JSON.parse(restored)[0].runId).toBe("specific-date-run");
  });

  it("returns error on invalid --from date format", async () => {
    const result = await restoreProvisions({
      from: "bad-date",
      memoryDir,
      backupDir,
    });
    expect(result.restored).toBe(false);
    expect(result.message).toContain("Invalid date format");
  });

  it("returns error when --from backup does not exist", async () => {
    const result = await restoreProvisions({
      from: "2025-01-01",
      memoryDir,
      backupDir,
    });
    expect(result.restored).toBe(false);
    expect(result.message).toContain("No backup found");
  });

  it("returns error when backup directory has no backups", async () => {
    const result = await restoreProvisions({ memoryDir, backupDir });
    expect(result.restored).toBe(false);
    expect(result.message).toContain("No backup files found");
  });

  it("restored file has 0o600 mode", async () => {
    fs.writeFileSync(path.join(backupDir, makeBackupName(1)), "[]", "utf-8");
    const result = await restoreProvisions({ memoryDir, backupDir });
    expect(result.restored).toBe(true);
    const stat = fs.statSync(path.join(memoryDir, "provisions.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates a safety copy of the current file before overwriting", async () => {
    // Create an existing provisions.json
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "provisions.json"),
      '["original"]',
      "utf-8",
    );

    fs.writeFileSync(
      path.join(backupDir, makeBackupName(1)),
      '["backup"]',
      "utf-8",
    );
    const result = await restoreProvisions({ memoryDir, backupDir });
    expect(result.restored).toBe(true);
    expect(result.safetyBackupPath).not.toBeNull();
    // Safety copy exists and has original content
    const safetyContent = fs.readFileSync(result.safetyBackupPath!, "utf-8");
    expect(safetyContent).toBe('["original"]');
  });

  it("is idempotent — restoring the same backup twice yields identical content", async () => {
    const content = JSON.stringify([{ runId: "idempotent-run" }]);
    fs.writeFileSync(path.join(backupDir, makeBackupName(1)), content, "utf-8");

    await restoreProvisions({ memoryDir, backupDir });
    await restoreProvisions({ memoryDir, backupDir });

    const restored = fs.readFileSync(
      path.join(memoryDir, "provisions.json"),
      "utf-8",
    );
    expect(restored).toBe(content);
  });

  it("result includes the date label in the success message", async () => {
    const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    fs.writeFileSync(
      path.join(backupDir, `provisions-${yesterday}.json`),
      "[]",
      "utf-8",
    );
    const result = await restoreProvisions({ memoryDir, backupDir });
    expect(result.message).toContain(yesterday);
  });
});
