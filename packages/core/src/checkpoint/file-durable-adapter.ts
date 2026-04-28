/**
 * W4-02 (Epic 100 Round 3) — FileDurableCheckpointerAdapter.
 *
 * File-backed implementation of CheckpointerPort. Delegates atomic write +
 * permission hardening (0o600 file mode, temp-rename) to the existing
 * `saveCheckpoint` / `loadCheckpoint` functions from `./store.ts`.
 *
 * Migration: reads pre-W4 checkpoint files (plain JSON under
 * `~/.assignee/checkpoints/`) via the existing `PlanCheckpointSchema.strict()`
 * Zod parser, then saves them back through this adapter's `save()` method
 * which writes the current canonical format. The content is unchanged;
 * any new `.default(...)` fields from subsequent schema revisions are
 * populated automatically on first round-trip.
 *
 * Cross-host (Postgres / DynamoDB) adapters are Epic 102.
 *
 * Invariants preserved (P098, L1-F43, L1-F44):
 *   - 0o600 file mode (via `saveCheckpoint` → writeFile mode + post-rename
 *     chmod).
 *   - Atomic write (temp-file + rename in `saveCheckpoint`).
 *   - HMAC signing is per-process MCP-server responsibility; this adapter
 *     does not add or verify HMAC — callers that need HMAC wrap saves with
 *     `apps/mcp-server/src/services/checkpoint-hmac.ts` as before.
 *
 * RW4d-migration-A (M-016): now constructs (or accepts) a `StoragePort`
 * and threads it through `saveCheckpoint`, `loadCheckpoint`, and the
 * `list` / `delete` calls so all I/O flows through the port. The
 * default constructor preserves the legacy `~/.assignee/checkpoints/`
 * filesystem layout via `LocalFsStorageAdapter`. Tests can pass an
 * in-memory port to exercise the behaviour without touching disk.
 */

import * as path from "node:path";
import * as os from "node:os";
import {
  PlanCheckpointSchema,
  type PlanCheckpoint,
} from "../schema/checkpoint.js";
import { CheckpointError } from "../errors.js";
import { isCheckpointExpired } from "./ttl.js";
import { saveCheckpoint, loadCheckpoint } from "./store.js";
import type { CheckpointerPort } from "../ports/checkpoint-port.js";
import { CHECKPOINT_FILE_PREFIX } from "./constants.js";
import { LocalFsStorageAdapter } from "../adapters/storage/local-fs-adapter.js";
import type { StoragePort } from "../ports/storage-port.js";

/** Default checkpoint directory — mirrors the path used by store.ts callers. */
const DEFAULT_CHECKPOINT_DIR = path.join(
  os.homedir(),
  ".assignee",
  "checkpoints",
);

/** Storage key for a runId — stable across local-fs and remote adapters. */
function checkpointKey(runId: string): string {
  return `${CHECKPOINT_FILE_PREFIX}${runId}.json`;
}

export class FileDurableCheckpointerAdapter implements CheckpointerPort {
  private readonly dir: string;
  private readonly storage: StoragePort;

  /**
   * @param dir Directory rooting the checkpoint files. Defaults to
   *   `~/.assignee/checkpoints/`.
   * @param storage TODO(SaaS): optional StoragePort. When supplied, all
   *   I/O flows through it (the `dir` is still kept around so
   *   `saveCheckpoint`'s legacy `dir`-based return value matches the
   *   port's rootDir). When omitted, the constructor builds a
   *   `LocalFsStorageAdapter` rooted at `dir`.
   */
  constructor(dir: string = DEFAULT_CHECKPOINT_DIR, storage?: StoragePort) {
    this.dir = dir;
    this.storage = storage ?? new LocalFsStorageAdapter({ rootDir: dir });
  }

  /**
   * Save a checkpoint using the atomic-write + 0o600 pattern from store.ts.
   * Returns the absolute file path.
   */
  async save(checkpoint: PlanCheckpoint): Promise<string> {
    return saveCheckpoint(checkpoint, this.dir, this.storage);
  }

  /**
   * Load a checkpoint by runId. Returns undefined when the file does not
   * exist (missing-file CheckpointError is caught and converted).
   */
  async load(runId: string): Promise<PlanCheckpoint | undefined> {
    try {
      return await loadCheckpoint(runId, this.dir, this.storage);
    } catch (err) {
      // Raw Node fs.readFile throws { code: "ENOENT" } when the file is absent;
      // store.loadCheckpoint does not wrap that. Treat missing-file as a clean
      // "no checkpoint" return. Corrupt/invalid content is also tolerated here
      // because the port contract treats load() as best-effort recovery.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        return undefined;
      }
      if (
        err instanceof CheckpointError &&
        (err.message.includes("not found") ||
          err.message.includes("Invalid checkpoint") ||
          err.message.includes("Corrupt checkpoint"))
      ) {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * List all stored checkpoints, newest-first by created_at.
   *
   * Reads every `checkpoint-*.json` file in the directory. Files that fail
   * schema parsing are skipped (best-effort tolerance for partial corruption).
   */
  async list(): Promise<PlanCheckpoint[]> {
    let entries: string[];
    try {
      entries = await this.storage.list();
    } catch {
      return [];
    }

    const checkpoints: PlanCheckpoint[] = [];
    for (const name of entries) {
      if (!name.startsWith(CHECKPOINT_FILE_PREFIX) || !name.endsWith(".json")) {
        continue;
      }
      try {
        const raw = await this.storage.readText(name);
        if (raw === undefined) continue;
        const parsed = PlanCheckpointSchema.strict().safeParse(JSON.parse(raw));
        if (parsed.success) {
          checkpoints.push(parsed.data);
        }
      } catch {
        // Skip corrupt or unreadable files.
      }
    }

    return checkpoints.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }

  /**
   * Delete the checkpoint file for runId. No-op when file does not exist.
   */
  async delete(runId: string): Promise<void> {
    try {
      await this.storage.delete(checkpointKey(runId));
    } catch {
      // Treat delete failures as no-op (matches legacy behaviour where
      // ENOENT was caught and unknown errors were swallowed).
    }
  }

  /**
   * Prune expired checkpoint files. Returns the number of files deleted.
   * Uses `isCheckpointExpired` from the existing TTL module.
   */
  async prune(): Promise<number> {
    const all = await this.list();
    let count = 0;
    for (const cp of all) {
      if (isCheckpointExpired(cp)) {
        await this.delete(cp.runId);
        count++;
      }
    }
    return count;
  }
}
