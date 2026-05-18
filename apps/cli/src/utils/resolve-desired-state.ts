/**
 * Resolve desired state for a resource by scanning checkpoint files,
 * then falling back to the baseline store.
 *
 * Checkpoints are written by the plan-apply pipeline and represent
 * the authoritative "what the user asked for" intent. Baselines are
 * written by `assignee infra drift --baseline <arn>` and represent the
 * live CCAPI state of a resource the operator adopted AFTER it was
 * provisioned (typically outside assignee). Checkpoints win when
 * both exist — the baseline is a last-resort fallback for adoption.
 *
 * @see Story 28.2, 28.4 (checkpoint scan)
 * @see A3 follow-up 2026-04-08 (baseline fallback)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CHECKPOINT_DIR,
  CHECKPOINT_FILE_PREFIX,
  BASELINES_DIR,
} from "../config/constants.js";
import { RESOURCE_IDENTIFIER_KEYS, type ResourceType } from "@assignee/core";

/**
 * Slugify an ARN for use as a baseline filename. Colons and slashes
 * are replaced with `_` so the result is safe on every filesystem.
 * This MUST match the slugifier used by `writeBaseline()` in
 * `apps/cli/src/services/baseline.ts` so reads and writes line up.
 */
export function baselineFilename(resourceArn: string): string {
  return resourceArn.replace(/[:/]/g, "_") + ".json";
}

/**
 * Resolve desired state for a resource by scanning checkpoint files
 * first, then the baseline store.
 *
 * Returns the desiredState from the most recent checkpoint that matches
 * the resource ARN, or — when no checkpoint matches — from the baseline
 * file written by `assignee infra drift --baseline`.
 */
export async function resolveDesiredState(
  resourceArn: string,
): Promise<Record<string, unknown> | undefined> {
  // ── 1. Checkpoint scan (primary source) ─────────────────────────
  const dir = path.resolve(process.cwd(), CHECKPOINT_DIR);
  try {
    const files = await fs.readdir(dir);
    const checkpoints = files
      .filter(
        (f) => f.startsWith(CHECKPOINT_FILE_PREFIX) && f.endsWith(".json"),
      )
      .sort()
      .reverse(); // newest first by filename

    for (const file of checkpoints) {
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        const cp = JSON.parse(raw);
        // Check single-resource checkpoint
        if (cp.desiredState && cp.resourceType) {
          // Use RESOURCE_IDENTIFIER_KEYS to extract the primary identifier for ANY resource type
          const identifierKey =
            RESOURCE_IDENTIFIER_KEYS[cp.resourceType as ResourceType];
          const identifierValue = identifierKey
            ? cp.desiredState[identifierKey]
            : undefined;
          // Also check Arn as a universal fallback
          const arn = identifierValue ?? cp.desiredState?.Arn;
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
    // No checkpoint dir — fall through to baseline check.
  }

  // ── 2. Baseline fallback (A3 follow-up) ─────────────────────────
  // Baselines are keyed by ARN so the lookup is O(1) — a single
  // file read. A missing file is the overwhelmingly common case
  // (no baseline adopted), so the try/catch collapses ENOENT
  // silently and returns undefined.
  const baselineDir = path.resolve(process.cwd(), BASELINES_DIR);
  const baselinePath = path.join(baselineDir, baselineFilename(resourceArn));
  try {
    const raw = await fs.readFile(baselinePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      desiredState?: Record<string, unknown>;
    };
    if (parsed.desiredState) return parsed.desiredState;
  } catch {
    // No baseline — operator hasn't run `drift --baseline` for this ARN.
  }

  return undefined;
}
