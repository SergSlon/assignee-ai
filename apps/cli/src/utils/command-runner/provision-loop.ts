/**
 * Phase 2 provisioning loop — shared by plan-to-apply and apply commands.
 *
 * Extracted from command-runner.ts (Wave 6d F5).
 */
import { ExecutionStatus } from "@assignee/core";
import type { createGraph } from "../../services/graph.js";
import type { AgentState } from "../../services/graph-state.js";
import {
  renderError,
  startSpinner,
  updateSpinner,
  stopSpinner,
} from "../display.js";
import { log, LOG_ACTIONS } from "../logger.js";
import { MAX_PROVISION_LOOPS } from "../../config/constants.js";

type Graph = ReturnType<typeof createGraph>;

/**
 * Resumes graph from interruptBefore checkpoint, handles single and compound resources.
 *
 * @returns Final graph state after provisioning completes
 */
export async function runProvisioningLoop(
  graph: Graph,
  config: { configurable: { thread_id: string } },
  phase1State: AgentState,
): Promise<{ finalState: AgentState; success: boolean }> {
  const isCompound = !!phase1State.resourcePattern;
  const totalResources = phase1State.resourceQueue?.length ?? 1;
  let resourcesProvisioned = 0;
  let loopCount = 0;

  while (true) {
    loopCount++;
    if (loopCount > MAX_PROVISION_LOOPS) {
      log({
        ts: new Date().toISOString(),
        runId: phase1State.runId,
        level: "error",
        action: LOG_ACTIONS.PROVISION_LOOP_EXCEEDED,
        extras: { maxLoops: MAX_PROVISION_LOOPS },
      });
      stopSpinner();
      break;
    }
    if (
      isCompound &&
      phase1State.resourceQueue &&
      resourcesProvisioned >= phase1State.resourceQueue.length
    ) {
      stopSpinner();
      renderError("Internal error: resource queue index out of bounds");
      break;
    }
    const resourceLabel = isCompound
      ? `Provisioning resource ${resourcesProvisioned + 1} of ${totalResources} (${phase1State.resourceQueue?.[resourcesProvisioned]?.displayName ?? "..."})...`
      : "Provisioning resource...";
    startSpinner(resourceLabel);
    updateSpinner("Waiting for AWS Cloud Control API...");

    await graph.invoke(null, config);
    stopSpinner();

    const graphState = await graph.getState(config);
    if (graphState.next.length === 0) break;
    resourcesProvisioned++;
  }

  const finalState = (await graph.getState(config)).values as AgentState;
  const success =
    finalState.executionStatus === ExecutionStatus.SUCCESS ||
    (isCompound &&
      (finalState.completedResources?.length ?? 0) === totalResources);

  // Surface error message when provisioning fails silently
  if (!success && finalState.errorMessage) {
    renderError(finalState.errorMessage);
  } else if (
    !success &&
    finalState.executionStatus !== ExecutionStatus.SUCCESS
  ) {
    renderError(
      `Provisioning ended with status: ${finalState.executionStatus}`,
    );
  }

  return { finalState, success };
}
