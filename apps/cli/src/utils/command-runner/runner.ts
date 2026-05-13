/**
 * Command bootstrap: credentials → MCP connect → graph create → delegate to `run`.
 *
 * Extracted from command-runner.ts (Wave 6d F5). Error/spinner/intro/outro
 * boilerplate stays here; credential detection is in ./credentials.ts and
 * llm client construction is in ./llm-factory.ts.
 */
import type { StructuredTool } from "@langchain/core/tools";
import { AssigneeError } from "@assignee/core";
import {
  createMcpClient,
  getMcpTools,
  closeMcpClient,
} from "../../services/mcp-client.js";
import { getRequiredServers } from "../../mcp/server-map.js";
import { createGraph } from "../../services/graph.js";
import {
  renderIntro,
  renderError,
  renderOutro,
  startSpinner,
  updateSpinner,
  stopSpinner,
} from "../display.js";
import { log, type LogAction } from "../logger.js";
import {
  isRecordingEnabled,
  RecordingInterceptor,
  wrapToolWithRecorder,
} from "../recorder.js";
import { runAutoCleanup } from "../../services/cleanup.js";
import { defaultMemoryService } from "../../services/memory.js";
import { loadUserConfig } from "../../config/user-config-loader.js";
import { CHECKPOINT_DIR } from "../../config/constants.js";
import {
  startTimer,
  endTimer,
  persistTimings,
  resetTimings,
  setCommandResult,
} from "../../telemetry/timing.js";
import { resolveCredentials } from "./credentials.js";
import { buildLlmClient } from "./llm-factory.js";
import { fetchManagedResources } from "../../services/list-resources.js";

export interface CommandContext {
  intent: string;
  runId: string;
  startTs: number;
  tools: StructuredTool[];
  graph: ReturnType<typeof createGraph>;
}

export interface RunCommandOptions {
  intent: string;
  /** CLI command name — used to determine which MCP servers to start. */
  commandName?: string;
  startAction: LogAction;
  endAction: LogAction;
  errorPrefix: string;
  errorHint: string;
  /** When true, suppress intro/outro banners and connection spinner. */
  silent?: boolean;
  run: (ctx: CommandContext) => Promise<{ success: boolean }>;
}

/**
 * Bootstraps MCP + graph then delegates to `run`. Handles intro/outro/error boilerplate.
 */
export async function runCommand(opts: RunCommandOptions): Promise<void> {
  // Story 29.5 / NFR-05: measure cold-start phases against the budgets in
  // `constants/time-budget.ts`.
  resetTimings();
  startTimer("total");

  const runId = crypto.randomUUID();

  try {
    if (!opts.silent) renderIntro();

    startTimer("credential-check");
    try {
      resolveCredentials(opts.silent ?? false);
    } finally {
      endTimer("credential-check");
    }

    const startTs = Date.now();

    log({
      ts: new Date().toISOString(),
      runId,
      level: "info",
      action: opts.startAction,
      extras: { intent: opts.intent },
    });

    const recorder = isRecordingEnabled()
      ? new RecordingInterceptor(runId, opts.intent)
      : null;

    try {
      try {
        const requiredServers = opts.commandName
          ? getRequiredServers(opts.commandName)
          : null;
        const serverCount = requiredServers?.length ?? 3;
        if (!opts.silent)
          startSpinner(
            `Connecting to AWS${serverCount > 1 ? ` (${serverCount} services)` : ""}...`,
          );
        startTimer("mcp-startup");
        const mcpClient = await createMcpClient(requiredServers);
        if (!opts.silent) updateSpinner("Loading tools...");
        let tools = await getMcpTools(mcpClient);
        endTimer("mcp-startup");
        if (!opts.silent) stopSpinner("Connected");

        if (recorder) {
          tools = tools.map((t) => wrapToolWithRecorder(t, recorder));
        }

        await loadUserConfig();

        const llmClient = await buildLlmClient({ recorder });

        const graph = createGraph(tools, {
          llmClient,
          recorder: recorder ?? undefined,
          // Story feature-query-intent-classifier: inject the RGTA-backed
          // managed-resource fetcher so kind=query intents resolve live AWS
          // resources in the query_handler node. `fetchManagedResources` uses
          // `tools` for optional billing enrichment.
          resourceFetcher: (resourceTypeFilter) =>
            fetchManagedResources(undefined, resourceTypeFilter, tools),
        });

        const result = await opts.run({
          intent: opts.intent,
          runId,
          startTs,
          tools,
          graph,
        });

        if (recorder) {
          recorder.finalizeSession();
        }

        if (!opts.silent) renderOutro(result.success);
        await closeMcpClient().catch(() => {});
        // DF-PLAN-BUDGET-WARNING-AFTER-SUCCESS: thread the result into
        // the timing layer so `checkTimingsAgainstBudgets` (called from
        // `persistTimings` in the outer finally) suppresses the noisy
        // BUDGET EXCEEDED line on the `total` timer when the user
        // already saw a successful outcome above. Failed runs still
        // get the warning so silent-hang regressions are still caught.
        setCommandResult(result.success);
        if (!result.success) return;
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

        if (recorder) {
          recorder.finalizeSession();
        }

        if (!opts.silent) {
          renderError(`${opts.errorPrefix}: ${errMsg}`, opts.errorHint);
          renderOutro(false);
        }
        await closeMcpClient().catch(() => {});
        setCommandResult(false);
        if (err instanceof AssigneeError) throw err;
        throw new AssigneeError(
          `${opts.errorPrefix}: ${errMsg}`,
          "COMMAND_FAILED",
        );
      }
    } finally {
      // Story 33.4: Fire-and-forget auto-cleanup after every command run.
      void runAutoCleanup(CHECKPOINT_DIR, defaultMemoryService).catch(() => {});
    }
  } finally {
    // Story 29.5 / NFR-05: stop the total-cold-start timer and persist
    // per-phase durations.
    try {
      endTimer("total");
    } catch {
      // total timer was never started — defensive against unusual exit paths.
    }
    try {
      persistTimings(runId);
    } catch {
      // Persistence is best-effort; never crash the CLI for telemetry.
    }
  }
}
