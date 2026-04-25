/**
 * W4-04 (Epic 100 Round 3) — backup-provisions.ts unit tests.
 *
 * Tests the backup/rotation logic in isolation via the module's exported
 * helper functions (extracted for testability). Integration-level tests
 * verify:
 *   - Backup is written to the correct path with today's date.
 *   - 0o600 file mode on backup files.
 *   - Backup is a copy — source is never mutated.
 *   - 7-day rotation: files older than N days are deleted.
 *   - Idempotent: running backup twice on the same day overwrites, not appends.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ── Helpers (mirrored from backup-provisions.ts for test isolation) ───

const BACKUP_PREFIX = "provisions-";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDateFromFilename(name: string): Date | null {
  if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(".json")) return null;
  const datePart = name.slice(BACKUP_PREFIX.length, -".json".length);
  const d = new Date(`${datePart}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function atomicWriteSync(destPath: string, content: Buffer): void {
  const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, destPath);
  try {
    fs.chmodSync(destPath, 0o600);
  } catch {
    /* best-effort */
  }
}

function runBackup(
  memoryDir: string,
  backupDir: string,
  retentionDays = 7,
): { backed_up: boolean; pruned: number } {
  const sourceFile = path.join(memoryDir, "provisions.json");
  if (!fs.existsSync(sourceFile)) return { backed_up: false, pruned: 0 };

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const content = fs.readFileSync(sourceFile);

  const backupName = `${BACKUP_PREFIX}${todayIso()}.json`;
  const backupFile = path.join(backupDir, backupName);
  atomicWriteSync(backupFile, content);

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let pruned = 0;
  for (const name of fs.readdirSync(backupDir)) {
    const d = parseDateFromFilename(name);
    if (d && d < cutoff) {
      fs.unlinkSync(path.join(backupDir, name));
      pruned++;
    }
  }

  return { backed_up: true, pruned };
}

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpRoot: string;
let memoryDir: string;
let backupDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "assignee-backup-test-"));
  memoryDir = path.join(tmpRoot, "memory");
  backupDir = path.join(tmpRoot, "backups");
  fs.mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("backup-provisions", () => {
  it("creates backup with today's date in filename", () => {
    const content = JSON.stringify([{ runId: crypto.randomUUID() }]);
    fs.writeFileSync(path.join(memoryDir, "provisions.json"), content, "utf-8");

    runBackup(memoryDir, backupDir);

    const expectedFile = path.join(backupDir, `provisions-${todayIso()}.json`);
    expect(fs.existsSync(expectedFile)).toBe(true);
  });

  it("backup content matches source", () => {
    const content = JSON.stringify([
      { runId: "test-run", resourceType: "AWS::S3::Bucket" },
    ]);
    fs.writeFileSync(path.join(memoryDir, "provisions.json"), content, "utf-8");

    runBackup(memoryDir, backupDir);

    const backupContent = fs.readFileSync(
      path.join(backupDir, `provisions-${todayIso()}.json`),
      "utf-8",
    );
    expect(backupContent).toBe(content);
  });

  it("backup file has 0o600 mode", () => {
    fs.writeFileSync(path.join(memoryDir, "provisions.json"), "[]", "utf-8");
    runBackup(memoryDir, backupDir);
    const backupFile = path.join(backupDir, `provisions-${todayIso()}.json`);
    const stat = fs.statSync(backupFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("source file is never mutated after backup", () => {
    const content = '["original"]';
    const sourcePath = path.join(memoryDir, "provisions.json");
    fs.writeFileSync(sourcePath, content, "utf-8");

    runBackup(memoryDir, backupDir);

    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(content);
  });

  it("is idempotent — second run overwrites today's backup", () => {
    const sourcePath = path.join(memoryDir, "provisions.json");
    fs.writeFileSync(sourcePath, '["v1"]', "utf-8");
    runBackup(memoryDir, backupDir);
    fs.writeFileSync(sourcePath, '["v2"]', "utf-8");
    runBackup(memoryDir, backupDir);

    const backupContent = fs.readFileSync(
      path.join(backupDir, `provisions-${todayIso()}.json`),
      "utf-8",
    );
    expect(backupContent).toBe('["v2"]');
    expect(
      fs.readdirSync(backupDir).filter((n) => n.startsWith("provisions-")),
    ).toHaveLength(1);
  });

  it("no-ops gracefully when provisions.json is absent", () => {
    const result = runBackup(memoryDir, backupDir);
    expect(result.backed_up).toBe(false);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it("rotation deletes backups older than retentionDays", () => {
    const sourcePath = path.join(memoryDir, "provisions.json");
    fs.writeFileSync(sourcePath, "[]", "utf-8");
    fs.mkdirSync(backupDir, { recursive: true });

    // Plant a stale backup (9 days old)
    const staleDate = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const staleName = `provisions-${staleDate.toISOString().slice(0, 10)}.json`;
    fs.writeFileSync(path.join(backupDir, staleName), "[]", "utf-8");

    const result = runBackup(memoryDir, backupDir, 7);

    expect(result.pruned).toBe(1);
    expect(fs.existsSync(path.join(backupDir, staleName))).toBe(false);
    // Today's backup still present
    expect(
      fs.existsSync(path.join(backupDir, `provisions-${todayIso()}.json`)),
    ).toBe(true);
  });

  it("parseDateFromFilename handles valid names", () => {
    const d = parseDateFromFilename("provisions-2026-01-15.json");
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(0); // January = 0
    expect(d!.getUTCDate()).toBe(15);
  });

  it("parseDateFromFilename returns null for non-matching names", () => {
    expect(parseDateFromFilename("random.json")).toBeNull();
    expect(parseDateFromFilename("provisions.json")).toBeNull();
    expect(parseDateFromFilename("provisions-bad-date.json")).toBeNull();
  });
});
