/**
 * Shared command execution skeleton for plan and apply commands.
 * Handles MCP client lifecycle, graph creation, intro/outro, error logging.
 *
 * Credential resolution for CLI commands.
 *
 * Resolution order (highest to lowest priority):
 * 1. ASSIGNEE_OPERATOR_ACCESS_KEY_ID + ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY
 * 2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (auto-promoted to operator role at process start)
 * 3. None — fail with a clear ConfigurationError
 *
 * AWS_PROFILE alone is NOT supported because we need to mint long-lived
 * credentials for the operator role; profile-based STS sessions don't
 * provide that lifetime guarantee. Run `assignee setup` to create the
 * 3 IAM users with explicit access keys.
 *
 * The auto-promotion at sequence 2 is the intentional fallback for
 * developer-experience reasons. Production deployments should use
 * sequence 1 with separate operator/reader/auditor users created
 * by `assignee setup`.
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ConfigurationError, AssigneeError } from "@assignee/core";
import {
  createMcpClient,
  getMcpTools,
  closeMcpClient,
} from "../services/mcp-client.js";
import { getRequiredServers } from "../mcp/server-map.js";
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
import { log, LOG_ACTIONS, type LogAction } from "./logger.js";
import {
  isRecordingEnabled,
  RecordingInterceptor,
  wrapToolWithRecorder,
  RecordingLlmAdapter,
} from "./recorder.js";
import { runAutoCleanup } from "../services/cleanup.js";
import { defaultMemoryService } from "../services/memory.js";
import { EnvVar } from "../constants/env-vars.js";
import { CHECKPOINT_DIR, MAX_PROVISION_LOOPS } from "../config/constants.js";

export interface CommandContext {
  intent: string;
  runId: string;
  startTs: number;
  tools: StructuredTool[];
  graph: ReturnType<typeof createGraph>;
}

export interface RunCommandOptions {
  intent: string;
  /** CLI command name (e.g. "plan", "apply") — used to determine which MCP servers to start. @see Story 29.3 */
  commandName?: string;
  startAction: LogAction;
  endAction: LogAction;
  errorPrefix: string;
  errorHint: string;
  /** When true, suppress intro/outro banners and connection spinner (used for JSON output). */
  silent?: boolean;
  run: (ctx: CommandContext) => Promise<{ success: boolean }>;
}

/**
 * Bootstraps MCP + graph then delegates to `run`. Handles intro/outro/error boilerplate.
 * The `run` callback should handle command-specific spinners, mid-flow logging, and error rendering.
 */
export async function runCommand(opts: RunCommandOptions): Promise<void> {
  if (!opts.silent) renderIntro();

  // Early credential check — fail fast before the wizard, not after.
  // Accepts either:
  //   (a) Dedicated ASSIGNEE_OPERATOR_* env vars (preferred — least privilege)
  //   (b) Standard AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (promoted w/ warning)
  //   (c) AWS_PROFILE pointing to a shared credentials file (promoted w/ warning)
  const hasOperatorKey =
    process.env[EnvVar.OPERATOR_ACCESS_KEY] &&
    process.env[EnvVar.OPERATOR_SECRET_KEY];
  const hasStandardKey =
    process.env["AWS_ACCESS_KEY_ID"] && process.env["AWS_SECRET_ACCESS_KEY"];
  const hasProfile = process.env["AWS_PROFILE"];

  if (!hasOperatorKey && hasStandardKey) {
    // Auto-promote standard AWS vars to ASSIGNEE_OPERATOR_* so the rest of the
    // pipeline (which reads ASSIGNEE_OPERATOR_*) works seamlessly.
    process.env[EnvVar.OPERATOR_ACCESS_KEY] = process.env["AWS_ACCESS_KEY_ID"];
    process.env[EnvVar.OPERATOR_SECRET_KEY] =
      process.env["AWS_SECRET_ACCESS_KEY"];
    if (process.env["AWS_SESSION_TOKEN"]) {
      process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] =
        process.env["AWS_SESSION_TOKEN"];
    }
    if (!opts.silent) {
      process.stderr.write(
        "\u001B[33m⚠  Using AWS_ACCESS_KEY_ID — consider running `assignee setup` to create least-privilege IAM users.\u001B[0m\n",
      );
    }
  } else if (!hasOperatorKey && hasProfile) {
    // AWS_PROFILE alone is not supported — the SDK default provider chain
    // (which would read ~/.aws/credentials) is intentionally bypassed by the
    // aws-credentials.ts helper to enforce least-privilege ASSIGNEE_OPERATOR_*
    // credentials. Users with AWS_PROFILE must either export keys or run setup.
    if (!opts.silent) {
      process.stderr.write(
        "\u001B[33m⚠  AWS_PROFILE detected but ASSIGNEE_OPERATOR_* not set. Run `assignee setup` for least-privilege users, or export AWS_ACCESS_KEY_ID directly.\u001B[0m\n",
      );
    }
    throw new ConfigurationError(
      "AWS_PROFILE alone is not supported. Export AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY directly, or run `assignee setup` to create ASSIGNEE_OPERATOR_* credentials.",
    );
  } else if (!hasOperatorKey) {
    throw new ConfigurationError(
      "No AWS credentials detected.\n" +
        "Assignee.ai requires either:\n" +
        "  • ASSIGNEE_OPERATOR_ACCESS_KEY_ID + ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY (preferred — least privilege)\n" +
        "  • AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (will be auto-promoted to operator role)\n" +
        "Note: AWS_PROFILE alone is not currently supported. Run `assignee setup` to create least-privilege IAM users.",
    );
  }

  const runId = crypto.randomUUID();
  const startTs = Date.now();

  log({
    ts: new Date().toISOString(),
    runId,
    level: "info",
    action: opts.startAction,
    extras: { intent: opts.intent },
  });

  // Story 9.7: Initialize recording session when ASSIGNEE_RECORD=1
  const recorder = isRecordingEnabled()
    ? new RecordingInterceptor(runId, opts.intent)
    : null;

  try {
    try {
      // Story 29.3: Only start MCP servers required by this command
      const requiredServers = opts.commandName
        ? getRequiredServers(opts.commandName)
        : null;
      const serverCount = requiredServers?.length ?? 3;
      if (!opts.silent)
        startSpinner(
          `Connecting to AWS${serverCount > 1 ? ` (${serverCount} services)` : ""}...`,
        );
      const mcpClient = await createMcpClient(requiredServers);
      if (!opts.silent) updateSpinner("Loading tools...");
      let tools = await getMcpTools(mcpClient);
      if (!opts.silent) stopSpinner("Connected");

      // Story 9.7: Wrap MCP tools with recorder when recording enabled
      if (recorder) {
        tools = tools.map((t) => wrapToolWithRecorder(t, recorder));
      }

      // Story 9.7: Wrap LLM adapter with recorder when recording enabled
      const { LlmAdapter } = await import("../services/llm-adapter.js");
      const baseLlm = new LlmAdapter({
        modelString: process.env[EnvVar.ASSIGNEE_MODEL],
        guardrailId: process.env[EnvVar.BEDROCK_GUARDRAIL_ID],
        guardrailVersion: process.env[EnvVar.BEDROCK_GUARDRAIL_VERSION],
      });
      const llmClient = recorder
        ? new RecordingLlmAdapter(
            baseLlm,
            recorder,
            process.env[EnvVar.ASSIGNEE_MODEL] ??
              "bedrock/amazon.nova-lite-v1:0",
          )
        : undefined;

      const graph = createGraph(tools, {
        llmClient,
        recorder: recorder ?? undefined,
      });

      const result = await opts.run({
        intent: opts.intent,
        runId,
        startTs,
        tools,
        graph,
      });

      // Story 9.7: Finalize recording session
      if (recorder) {
        recorder.finalizeSession();
      }

      if (!opts.silent) renderOutro(result.success);
      await closeMcpClient().catch(() => {});
      if (!result.success) {
        // Error was already rendered by the graph run — don't throw (which would
        // double-render via the catch block). Just return so the process exits cleanly.
        return;
      }
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

      // Story 9.7: Finalize recording even on error
      if (recorder) {
        recorder.finalizeSession();
      }

      if (!opts.silent) {
        renderError(`${opts.errorPrefix}: ${errMsg}`, opts.errorHint);
        renderOutro(false);
      }
      await closeMcpClient().catch(() => {});
      if (err instanceof AssigneeError) throw err;
      throw new AssigneeError(
        `${opts.errorPrefix}: ${errMsg}`,
        "COMMAND_FAILED",
      );
    }
  } finally {
    // Story 33.4: Fire-and-forget auto-cleanup after every command run.
    // Uses void to explicitly discard the promise; .catch() swallows errors
    // so cleanup failures never affect the command exit code.
    void runAutoCleanup(CHECKPOINT_DIR, defaultMemoryService).catch(() => {});
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
