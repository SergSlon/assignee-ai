/**
 * Checkpoint on-disk store — atomic write + validated read.
 *
 * PRESERVES the `.assignee/checkpoints/checkpoint-<runId>.json` file
 * format and the 0o700 dir / 0o600 file permissions established by
 * Story 10.1 (backward-compat is required for in-flight plans). Story
 * 50-5 hardened the MCP copy with explicit perms + temp-rename; Story
 * 50-4 lifted those safety bolts into core so both apps share them.
 *
 * HMAC signing is NOT performed here — the integrity layer is
 * per-process and belongs to the long-running MCP server only (see
 * `apps/mcp-server/src/services/checkpoint-hmac.ts`). CLI callers use
 * `saveCheckpoint` directly; MCP callers wrap it with their own
 * save-site helper that registers the HMAC after the atomic rename.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  PlanCheckpointSchema,
  type PlanCheckpoint,
} from "../schema/checkpoint.js";
import { CheckpointError } from "../errors.js";

/**
 * Writes a checkpoint to disk as JSON, atomically via a temp file + rename.
 * Creates the directory if it doesn't exist.
 *
 * Security bolts preserved from Story 50-5 (B-1):
 *   - Directory created with mode 0o700 (owner rwx only).
 *   - File written with mode 0o600 (owner rw only).
 *   - TOCTOU-safe: temp file + rename so a concurrent reader never
 *     sees a partial file. Random suffix on the temp path prevents
 *     pid-recycle collisions.
 *   - Defence-in-depth post-rename chmod in case rename() inherited
 *     a looser mode from a pre-existing file.
 *
 * @returns The absolute file path written.
 */
export async function saveCheckpoint(
  checkpoint: PlanCheckpoint,
  dir: string,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `checkpoint-${checkpoint.runId}.json`);
  // Use a per-call random suffix instead of process.pid so two concurrent
  // saveCheckpoint() invocations from the same process (or two processes that
  // happened to share a recycled PID) cannot collide on the temp filename.
  const tmpPath = `${filePath}.tmp.${randomBytes(8).toString("hex")}`;
  // Write with 0o600 so the checkpoint is never world-readable. rename() on
  // POSIX inherits the source file's mode, so we also chmod the final path as
  // defence-in-depth against umask or pre-existing-file edge cases.
  await fs.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Best-effort on filesystems that don't support chmod (e.g. some Windows
    // configurations). The writeFile mode is authoritative on POSIX.
  }
  return filePath;
}

/**
 * Loads and validates a checkpoint by runId.
 * Throws CheckpointError on parse failure.
 */
export async function loadCheckpoint(
  runId: string,
  dir: string,
): Promise<PlanCheckpoint> {
  const filePath = path.join(dir, `checkpoint-${runId}.json`);
  const raw = await fs.readFile(filePath, "utf-8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CheckpointError(
      `Corrupt checkpoint file (invalid JSON): ${filePath}`,
    );
  }
  const parsed = PlanCheckpointSchema.strict().safeParse(json);
  if (!parsed.success) {
    throw new CheckpointError(
      `Invalid checkpoint file: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
