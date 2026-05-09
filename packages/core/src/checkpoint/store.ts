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
 *
 * RW4d-migration-A (M-016): now accepts an optional `StoragePort` to
 * decouple from `node:fs`. When `storage` is omitted, the function
 * builds a `LocalFsStorageAdapter` rooted at `dir` for backwards
 * compatibility. The atomic temp-rename + 0o600 mode bolts live
 * inside `LocalFsStorageAdapter.writeBytes` so the port-backed path
 * preserves the same wire-level guarantees as the legacy direct-fs
 * code path. The legacy code path additionally performed a
 * defence-in-depth post-rename `chmod` — that bolt is preserved on
 * the fallback path only and is unreachable on the explicit-port
 * path (where the adapter is solely responsible for permissions).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  PlanCheckpointSchema,
  type PlanCheckpoint,
} from "../schema/checkpoint.js";
import { CheckpointError } from "../errors.js";
import { LocalFsStorageAdapter } from "../adapters/storage/local-fs-adapter.js";
import type { StoragePort } from "../ports/storage-port.js";
import { ensureAssigneeHomeDir } from "../audit/ensure-assignee-home-dir.js";

/** The on-disk key for a checkpoint runId — stable across adapters. */
function checkpointKey(runId: string): string {
  return `checkpoint-${runId}.json`;
}

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
 * RW4d-migration-A: when `storage` is provided, writes go through
 * the port; the return value is still the absolute filesystem path
 * for backward compatibility (callers in apps/mcp-server use the
 * return value as a stable identifier). The fallback path constructs
 * a `LocalFsStorageAdapter` rooted at `dir` and additionally performs
 * the legacy post-rename chmod.
 *
 * @returns The absolute file path written.
 */
export async function saveCheckpoint(
  checkpoint: PlanCheckpoint,
  dir: string,
  // TODO(SaaS): require StoragePort once all callers thread it through.
  storage?: StoragePort,
): Promise<string> {
  const filePath = path.join(dir, checkpointKey(checkpoint.runId));
  const key = checkpointKey(checkpoint.runId);

  if (storage) {
    // Port-backed path: adapter owns atomic temp-rename + permissions.
    await storage.writeJson(key, checkpoint, 2);
    return filePath;
  }

  // Legacy direct-fs path — preserves the original concurrent-saves
  // race regression test (per-call random temp suffix instead of pid)
  // and the defence-in-depth post-rename chmod.
  // Relock `~/.assignee` to 0o700 first; mkdirSync `mode` only applies
  // to leaves, so a pre-existing parent retains umask-derived perms.
  ensureAssigneeHomeDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
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
 *
 * RW4d-migration-A: when `storage` is provided, the read goes
 * through the port. The fallback path uses `node:fs` directly via
 * a transient `LocalFsStorageAdapter`.
 */
export async function loadCheckpoint(
  runId: string,
  dir: string,
  // TODO(SaaS): require StoragePort once all callers thread it through.
  storage?: StoragePort,
): Promise<PlanCheckpoint> {
  const filePath = path.join(dir, checkpointKey(runId));
  const port = storage ?? new LocalFsStorageAdapter({ rootDir: dir });
  const key = checkpointKey(runId);

  // Read raw text via the port. The port returns `undefined` for
  // missing keys; we re-throw an ENOENT-shaped error to preserve
  // the legacy contract (callers like FileDurableCheckpointerAdapter
  // pattern-match on `code === "ENOENT"`).
  const raw = await port.readText(key);
  if (raw === undefined) {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error(`ENOENT: checkpoint not found: ${filePath}`),
      { code: "ENOENT" as const, path: filePath },
    );
    throw err;
  }

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
