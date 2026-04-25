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
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  PlanCheckpointSchema,
  type PlanCheckpoint,
} from "../schema/checkpoint.js";
import { CheckpointError } from "../errors.js";
import { isCheckpointExpired } from "./ttl.js";
import { saveCheckpoint, loadCheckpoint } from "./store.js";
import type { CheckpointerPort } from "./port.js";
import { CHECKPOINT_FILE_PREFIX } from "./constants.js";

/** Default checkpoint directory — mirrors the path used by store.ts callers. */
const DEFAULT_CHECKPOINT_DIR = path.join(
  os.homedir(),
  ".assignee",
  "checkpoints",
);

export class FileDurableCheckpointerAdapter implements CheckpointerPort {
  constructor(private readonly dir: string = DEFAULT_CHECKPOINT_DIR) {}

  /**
   * Save a checkpoint using the atomic-write + 0o600 pattern from store.ts.
   * Returns the absolute file path.
   */
  async save(checkpoint: PlanCheckpoint): Promise<string> {
    return saveCheckpoint(checkpoint, this.dir);
  }

  /**
   * Load a checkpoint by runId. Returns undefined when the file does not
   * exist (missing-file CheckpointError is caught and converted).
   */
  async load(runId: string): Promise<PlanCheckpoint | undefined> {
    try {
      return await loadCheckpoint(runId, this.dir);
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
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }

    const checkpoints: PlanCheckpoint[] = [];
    for (const name of entries) {
      if (!name.startsWith(CHECKPOINT_FILE_PREFIX) || !name.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.dir, name);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
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
    const filePath = path.join(
      this.dir,
      `${CHECKPOINT_FILE_PREFIX}${runId}.json`,
    );
    try {
      await fs.unlink(filePath);
    } catch {
      // ENOENT — already gone.
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
