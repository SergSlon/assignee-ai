/**
 * Shared command execution skeleton for plan and apply commands.
 * Handles MCP client lifecycle, graph creation, intro/outro, error logging.
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ProcessExitCode } from "../constants/errors.js";
import {
  createMcpClient,
  getMcpTools,
  closeMcpClient,
} from "../services/mcp-client.js";
import { createGraph } from "../services/graph.js";
import { ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";
import {
  renderIntro,
  renderError,
  renderOutro,
  startSpinner,
  updateSpinner,
  stopSpinner,
} from "./display.js";
import { log, type LogAction } from "./logger.js";

export interface CommandContext {
  intent: string;
  runId: string;
  startTs: number;
  tools: StructuredTool[];
  graph: ReturnType<typeof createGraph>;
}

export interface RunCommandOptions {
  intent: string;
  startAction: LogAction;
  endAction: LogAction;
  errorPrefix: string;
  errorHint: string;
  run: (ctx: CommandContext) => Promise<{ success: boolean }>;
}

/**
 * Bootstraps MCP + graph then delegates to `run`. Handles intro/outro/error boilerplate.
 * The `run` callback should handle command-specific spinners, mid-flow logging, and error rendering.
 */
export async function runCommand(opts: RunCommandOptions): Promise<never> {
  renderIntro();

  const runId = crypto.randomUUID();
  const startTs = Date.now();

  log({
    ts: new Date().toISOString(),
    runId,
    level: "info",
    action: opts.startAction,
    extras: { intent: opts.intent },
  });

  try {
    const mcpClient = await createMcpClient();
    const tools = await getMcpTools(mcpClient);
    const graph = createGraph(tools);

    const result = await opts.run({
      intent: opts.intent,
      runId,
      startTs,
      tools,
      graph,
    });

    renderOutro(result.success);
    await closeMcpClient().catch(() => {});
    process.exit(
      result.success ? ProcessExitCode.SUCCESS : ProcessExitCode.GENERIC_ERROR,
    );
  } catch (err: unknown) {
    stopSpinner();
    const errMsg = err instanceof Error ? err.message : String(err);
    log({
      ts: new Date().toISOString(),
      runId,
      level: "error",
      action: opts.endAction,
      durationMs: Date.now() - startTs,
      result: "error",
    });
    renderError(`${opts.errorPrefix}: ${errMsg}`, opts.errorHint);
    renderOutro(false);
    await closeMcpClient().catch(() => {});
    process.exit(ProcessExitCode.GENERIC_ERROR);
  }
}

/**
 * Phase 2 provisioning loop — shared by plan-to-apply and apply commands.
 * Resumes graph from interruptBefore checkpoint, handles single and compound resources.
 *
 * @returns Final graph state after provisioning completes
 */
export async function runProvisioningLoop(
  graph: CommandContext["graph"],
  config: { configurable: { thread_id: string } },
  phase1State: AgentState,
): Promise<{ finalState: AgentState; success: boolean }> {
  const isCompound = !!phase1State.resourcePattern;
  const totalResources = phase1State.resourceQueue?.length ?? 1;
  let resourcesProvisioned = 0;

  while (true) {
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

  return { finalState, success };
}
