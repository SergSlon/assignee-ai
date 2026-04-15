/**
 * `assignee clean` orchestrator — routes to baselines / local-cleanup /
 * log-prune / resource-sweep based on flag combinations, preserving the
 * pre-decomposition outro behavior.
 *
 * Wave-6d F4: split from clean.ts.
 */
import * as clack from "@clack/prompts";
import { runLocalCleanup } from "./local-cleanup.js";
import { runLogPrune } from "./log-prune.js";
import { cleanBaselines } from "./baselines.js";
import { cleanResources } from "./resources-sweep.js";
import type { CleanOpts } from "./types.js";

export async function cleanAction(opts: CleanOpts): Promise<void> {
  const dryRun = !(opts.confirm || opts.yes);

  // --baselines: standalone scope (A3 follow-up).
  if (opts.baselines === true) {
    await cleanBaselines(dryRun);
    return;
  }

  const hasLocalFlags = opts.checkpoints || opts.cache || opts.memory;
  const hasResources = opts.resources === true;
  const hasLogs = opts.logs === true;
  const hasAnyScopedFlag = hasLocalFlags || hasResources || hasLogs;

  // Local (checkpoints/cache/memory) cleanup runs when explicit local
  // flags are set, OR when no scoped flag is set at all (default
  // "everything" behaviour). Log pruning runs on --logs OR default.
  const doLocalCleanup = hasLocalFlags || !hasAnyScopedFlag;
  const doLogPrune = hasLogs || !hasAnyScopedFlag;

  try {
    if (doLocalCleanup) {
      const { shouldReturn } = await runLocalCleanup({
        opts,
        dryRun,
        doLogPrune,
        hasResources,
      });
      if (shouldReturn) return;
    } else {
      // --resources / --logs only, no local cleanup.
      clack.intro("assignee clean");

      if (doLogPrune) {
        const pruneResult = runLogPrune(dryRun);
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ logs: pruneResult }, null, 2) + "\n",
          );
        } else {
          const verb = dryRun ? "Would delete" : "Deleted";
          clack.log.info(
            `Logs: ${verb} ${pruneResult.deleted} file(s) older than ${pruneResult.retentionDays} day(s); kept ${pruneResult.kept} (${pruneResult.dir})`,
          );
        }
      }
    }

    // AWS resource cleanup.
    if (hasResources) {
      await cleanResources({ ...opts, dryRun });
    }

    if (!opts.json) {
      if (dryRun) {
        clack.outro("Run with --confirm to execute.");
      } else {
        clack.outro("Done.");
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!opts.json) {
      clack.intro("assignee clean");
      clack.outro(`Cleanup failed: ${message}`);
    }
    process.exitCode = 1;
  }
}
