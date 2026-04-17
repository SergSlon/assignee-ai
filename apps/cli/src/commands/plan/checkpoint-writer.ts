/**
 * Persist successful plan state as a checkpoint on disk.
 * Wave-6d F4: split out of plan.ts.
 */
import * as path from "node:path";
import { safeTry } from "@assignee/core";
import type { AgentState } from "../../services/graph-state.js";
import { serializeCheckpoint, saveCheckpoint } from "@assignee/core/checkpoint";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { CHECKPOINT_DIR } from "../../config/constants.js";

export async function writePlanCheckpoint(
  finalState: AgentState,
  ctx: { runId: string },
  outputFormat: string,
): Promise<void> {
  const checkpoint = serializeCheckpoint(finalState);
  const checkpointDir = path.resolve(process.cwd(), CHECKPOINT_DIR);
  const [saveErr, filePath] = await safeTry(
    saveCheckpoint(checkpoint, checkpointDir),
  );
  if (saveErr) {
    log({
      ts: new Date().toISOString(),
      runId: ctx.runId,
      level: "warn",
      action: LOG_ACTIONS.CHECKPOINT_SAVED,
      result: "failed",
      extras: { error: saveErr.message },
    });
    return;
  }
  log({
    ts: new Date().toISOString(),
    runId: ctx.runId,
    level: "info",
    action: LOG_ACTIONS.CHECKPOINT_SAVED,
    extras: { path: filePath },
  });
  if (process.stdout.isTTY && outputFormat !== "json") {
    process.stdout.write(
      `\nPlan saved to ${CHECKPOINT_DIR}/checkpoint-${ctx.runId}.json (valid for ${checkpoint.ttl_hours}h)\n`,
    );
  }
}
