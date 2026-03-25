/**
 * Resolve desired state for a resource by scanning checkpoint files.
 * Shared utility used by both drift and reconcile commands.
 *
 * @see Story 28.2, 28.4
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CHECKPOINT_DIR } from "../config/constants.js";

/**
 * Resolve desired state for a resource by scanning checkpoint files.
 * Returns the desiredState from the most recent checkpoint that matches the resource ARN.
 */
export async function resolveDesiredState(
  resourceArn: string,
): Promise<Record<string, unknown> | undefined> {
  const dir = path.resolve(process.cwd(), CHECKPOINT_DIR);
  try {
    const files = await fs.readdir(dir);
    const checkpoints = files
      .filter((f) => f.startsWith("checkpoint-") && f.endsWith(".json"))
      .sort()
      .reverse(); // newest first by filename

    for (const file of checkpoints) {
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        const cp = JSON.parse(raw);
        // Check single-resource checkpoint
        if (cp.desiredState && cp.resourceType) {
          const arn =
            cp.desiredState?.Arn ??
            cp.desiredState?.BucketName ??
            cp.desiredState?.FunctionName;
          if (arn === resourceArn || cp.runId === resourceArn) {
            return cp.desiredState;
          }
        }
        // Check compound checkpoint with resourceQueue
        if (cp.resourceQueue) {
          for (const r of cp.resourceQueue) {
            if (
              r.desiredState &&
              (r.resourceId === resourceArn || r.displayName === resourceArn)
            ) {
              return r.desiredState;
            }
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // No checkpoint dir
  }
  return undefined;
}
