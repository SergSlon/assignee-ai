/**
 * Batch drift check runner with live progress bar.
 *
 * Wave-6d F4: split from drift.ts (Story 28.6). Uses checkAll() when
 * available on the detector, otherwise falls back to a sequential loop.
 */
import { DriftStatus, type DriftResult, AssigneeError } from "@assignee/core";
import { ErrorCode } from "../../constants/errors.js";
import { resolveDesiredState } from "../../utils/resolve-desired-state.js";
import { renderProgressBar } from "../../views/drift-progress.js";
import type { DriftDetectorService } from "../../services/drift-detector/service.js";
import type { Provision } from "./single-resource.js";

export function parseConcurrency(raw: string | undefined): number {
  const concNum = parseInt(raw ?? "10", 10);
  if (isNaN(concNum) || concNum < 1) {
    throw new AssigneeError(
      "--concurrency must be a positive integer",
      ErrorCode.USAGE_ERROR,
    );
  }
  return Math.min(Math.max(concNum, 1), 50);
}

export interface BatchRunOptions {
  filtered: Provision[];
  detector: DriftDetectorService;
  concurrency: number;
  showProgress: boolean;
}

export async function runBatchDriftCheck(
  opts: BatchRunOptions,
): Promise<{ results: DriftResult[]; checkDurationMs: number }> {
  const { filtered, detector, concurrency, showProgress } = opts;
  const startTime = Date.now();
  const results: DriftResult[] = [];
  let driftedCount = 0;

  if (detector.checkAll) {
    // NOTE: checkAll path intentionally omits desiredState — detector's
    // internal actual-fetcher uses resolve-desired-state via the
    // resolveDesiredState fallback. Preserves pre-decomposition behavior.
    const batchResults = await detector.checkAll(
      filtered.map((p) => ({
        typeName: p.resourceType,
        identifier: p.resourceArn,
      })),
      {
        concurrency,
        onProgress: (completed, total, latest) => {
          if (latest.status === DriftStatus.DRIFTED) driftedCount++;
          if (showProgress) {
            renderProgressBar(completed, total, driftedCount);
          }
        },
      },
    );
    results.push(...batchResults);
  } else {
    // Fallback sequential path for detectors that do not expose checkAll.
    let completed = 0;
    for (const provision of filtered) {
      const batchDesiredState = await resolveDesiredState(
        provision.resourceArn,
      );
      const driftResult = await detector.checkResource(
        provision.resourceType,
        provision.resourceArn,
        batchDesiredState,
      );
      results.push(driftResult);
      completed++;
      if (driftResult.status === DriftStatus.DRIFTED) driftedCount++;
      if (showProgress) {
        renderProgressBar(completed, filtered.length, driftedCount);
      }
    }
  }

  return { results, checkDurationMs: Date.now() - startTime };
}
