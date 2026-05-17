/**
 * Reconcile orchestrator — loads provisions, runs drift, prompts per
 * drifted resource, executes action, prints summary.
 *
 * Wave-6d F4: split out of reconcile.ts.
 */
import chalk from "chalk";
import {
  DriftStatus,
  UserCancelledError,
  type DriftResult,
} from "@assignee/core";
import { MemoryService } from "../../services/memory.js";
import { createDriftDetectorFromEnv } from "../../services/drift-detector-factory.js";
import { resolveDesiredState } from "../../utils/resolve-desired-state.js";
import {
  getReconcilePromptFn,
  getReconcileConfirmFn,
} from "../reconcile-factory.js";
import { ReconcileAction } from "../../constants/reconcile-actions.js";
import { reconcileResource } from "./apply-step.js";
import type { ReconcileOpts, ReconcileSummary } from "./types.js";

export async function runReconcile(opts: ReconcileOpts): Promise<void> {
  // --yes is the canonical CI flag; promote it to autoReconcile so all
  // downstream checks only need to look at one boolean.
  if (opts.yes) opts.autoReconcile = true;

  const memory = new MemoryService();
  const provisions = await memory.readProvisions();

  if (provisions.length === 0) {
    process.stdout.write(
      "No managed resources found. Run `assignee infra plan` and `assignee infra apply` to provision resources.\n",
    );
    return;
  }

  let filtered = provisions;
  if (opts.resource) {
    filtered = filtered.filter((p) => p.resourceType === opts.resource);
  }

  const detectorResult = createDriftDetectorFromEnv();
  if (!detectorResult) {
    process.stdout.write(
      "Reconcile requires AWS credentials. Configure credentials and try again.\n",
    );
    return;
  }

  const { detector, port } = detectorResult;

  // Run drift detection with resolved desiredState (same as drift.ts)
  const results: DriftResult[] = [];
  const total = filtered.length;
  let lastProgressMs = Date.now();
  const PROGRESS_INTERVAL_MS = 5_000;
  const progressStep = Math.max(1, Math.ceil(total / 10));

  for (let i = 0; i < filtered.length; i++) {
    const provision = filtered[i]!;
    const desiredState = await resolveDesiredState(provision.resourceArn);
    const driftResult = await detector.checkResource(
      provision.resourceType,
      provision.resourceArn,
      desiredState,
    );
    results.push(driftResult);

    const done = i + 1;
    const nowMs = Date.now();
    if (
      done % progressStep === 0 ||
      nowMs - lastProgressMs >= PROGRESS_INTERVAL_MS
    ) {
      const eta =
        done > 0
          ? Math.round(
              (((nowMs - lastProgressMs) / done) * (total - done)) / 1000,
            )
          : "?";
      process.stderr.write(
        `[INFO] Scanning ${total} resources (${done} done, ETA ${eta}s)\n`,
      );
      lastProgressMs = Date.now();
    }
  }

  const drifted = results.filter((r) => r.status === DriftStatus.DRIFTED);

  if (drifted.length === 0) {
    process.stdout.write("All resources are in sync. Nothing to reconcile.\n");
    return;
  }

  // Auto-reconcile warning (bulk mutation confirmation gate).
  if (opts.autoReconcile && !opts.dryRun) {
    process.stdout.write(
      chalk.yellow(
        `\nWARNING: Auto-reconcile will modify ${drifted.length} resources without confirmation.\nPress Enter to continue or Ctrl+C to abort.\n`,
      ),
    );
    if (process.stdin.isTTY) {
      await new Promise<void>((resolve) => {
        process.stdin.once("data", () => resolve());
      });
    }
  }

  const summary: ReconcileSummary = {
    reconciled: 0,
    accepted: 0,
    skipped: 0,
    errors: 0,
  };

  // Resolve prompt/confirm via factory module (tests vi.mock the factory)
  const promptFn = getReconcilePromptFn();
  const confirmFn = getReconcileConfirmFn();

  for (const result of drifted) {
    try {
      const action = await reconcileResource(result, port, memory, {
        dryRun: opts.dryRun ?? false,
        autoReconcile: opts.autoReconcile ?? false,
        promptFn,
        confirmFn,
      });

      switch (action) {
        case ReconcileAction.RECONCILE:
          summary.reconciled++;
          break;
        case ReconcileAction.ACCEPT:
          summary.accepted++;
          break;
        case ReconcileAction.SKIP:
          summary.skipped++;
          break;
      }
    } catch (err) {
      // User cancellation aborts the loop cleanly instead of being silently
      // counted as an error and continuing. @see SECURITY-AUDIT.md — M-S9
      if (err instanceof UserCancelledError) {
        process.stdout.write(
          chalk.yellow(
            `\nReconcile cancelled by user — aborting remaining resources.\n`,
          ),
        );
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        chalk.red(`  Error reconciling ${result.resourceId}: ${message}\n`),
      );
      summary.errors++;
    }
  }

  process.stdout.write(
    `\nReconciled: ${summary.reconciled}, Accepted: ${summary.accepted}, Skipped: ${summary.skipped}, Errors: ${summary.errors}\n`,
  );
}
