/**
 * Shared filesystem primitives for MemoryService — atomic writes,
 * advisory locks, corrupt-file backups, directory ensure.
 *
 * Extracted from memory.ts (Wave 6d F5). SRP: only I/O concerns here;
 * domain-specific JSON shapes (provisions/failures/patterns) live in
 * their own modules.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { MEMORY_DEDUP_THRESHOLD_MS } from "../../config/constants.js";

/** Base filesystem operations shared across all record types. */
export class FileStore {
  constructor(protected readonly dir: string) {}

  protected filePath(name: string): string {
    return path.join(this.dir, name);
  }

  protected async ensureDir(): Promise<void> {
    // 0o700 — provision/failure/pattern logs may include resource ARNs and
    // user intents that should not be world-readable on shared systems.
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  /**
   * Back up a corrupt file before returning empty data.
   * Prevents silent total data loss when JSON.parse fails on a non-empty file.
   * The corrupt file is copied to `{filename}.corrupt.{timestamp}` so the user
   * can attempt manual recovery.
   */
  protected async backupCorruptFile(fileName: string): Promise<void> {
    const filePath = this.filePath(fileName);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0) {
        const ts = Date.now();
        const backupPath = `${filePath}.corrupt.${ts}`;
        await fs.copyFile(filePath, backupPath);
        process.stderr.write(
          `WARNING: ${fileName} appears corrupt. Backup saved to ${fileName}.corrupt.${ts}. Previous data may be recoverable.\n`,
        );
      }
    } catch {
      // File doesn't exist or can't be stat'd — nothing to back up
    }
  }

  /** Internal accessors for helper modules (rotation.ts). */
  /** @internal */
  public async _ensureDirInternal(): Promise<void> {
    await this.ensureDir();
  }
  /** @internal */
  public async _acquireLockInternal(filePath: string): Promise<boolean> {
    return this.acquireLock(filePath);
  }
  /** @internal */
  public async _releaseLockInternal(filePath: string): Promise<void> {
    await this.releaseLock(filePath);
  }
  /** @internal */
  public async _atomicWriteInternal(
    filePath: string,
    data: string,
  ): Promise<void> {
    await this.atomicWrite(filePath, data);
  }

  /**
   * Atomically write a file: write to a temp file first, then rename.
   * Prevents corruption from partial writes / crashes.
   */
  protected async atomicWrite(filePath: string, data: string): Promise<void> {
    // Random suffix avoids PID collisions when two concurrent writers
    // (or two processes with recycled PIDs) target the same file.
    const tmpPath = filePath + ".tmp." + randomBytes(8).toString("hex");
    // 0o600 — these JSON files (provisions / failures / patterns) may
    // contain user intents and resource ARNs and should not be readable
    // by other local users. chmod the final path as defence-in-depth in
    // case rename() inherits a wider mode from a pre-existing file.
    await fs.writeFile(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Best-effort on filesystems that don't support chmod (Windows etc.)
    }
  }

  /**
   * Acquire a simple advisory lock file. Returns true if acquired.
   * Uses O_CREAT|O_EXCL for atomic creation to prevent TOCTOU race conditions.
   * Skips if a lock exists and is less than 10 seconds old.
   */
  protected async acquireLock(filePath: string): Promise<boolean> {
    const lockPath = filePath + ".lock";
    try {
      // Check for stale locks first
      const stat = await fs.stat(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < MEMORY_DEDUP_THRESHOLD_MS) {
        // Lock is fresh — another writer is active
        return false;
      }
      // Stale lock — remove it
      await fs.unlink(lockPath).catch(() => {});
    } catch {
      // No lock file — proceed to create
    }
    // Use O_CREAT|O_EXCL|O_WRONLY for atomic lock creation.
    try {
      const { constants } = await import("node:fs");
      const fh = await fs.open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      );
      await fh.write(String(process.pid));
      await fh.close();
      return true;
    } catch {
      // EEXIST or other error — another process won the race
      return false;
    }
  }

  /** Release an advisory lock file. */
  protected async releaseLock(filePath: string): Promise<void> {
    const lockPath = filePath + ".lock";
    await fs.unlink(lockPath).catch(() => {});
  }
}
