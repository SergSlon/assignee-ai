/**
 * apply_plan MCP tool — applies an approved infrastructure plan.
 * Loads a checkpoint from plan_resource, runs provisioning via the LangGraph graph.
 *
 * Safety mechanism: requires `confirmed: true` to proceed — prevents accidental provisioning
 * by AI agents. The agent must present the plan to the user and get explicit approval first.
 *
 * @see Epic 20, Story 20.3, ADR-008
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ExecutionMode,
  ExecutionStatus,
  CheckpointError,
} from "@assignee/core";
import type { GraphContext } from "../services/graph-init.js";
import { loadCheckpointFromPath } from "../services/checkpoint.js";

/** In-memory set of checkpoint paths currently being applied. Prevents duplicate provisioning. */
const activeApplies = new Set<string>();

/** Exported for testing — clears the active-apply lock set. */
export function _resetActiveApplies(): void {
  activeApplies.clear();
}

export const applyPlanParams = {
  checkpointPath: z
    .string()
    .describe("Path to the plan checkpoint file (returned by plan_resource)."),
  confirmed: z
    .boolean()
    .describe(
      "Safety gate — must be true to proceed with provisioning. Set to false for a dry-run check.",
    ),
};

export function registerApplyPlan(server: McpServer, ctx?: GraphContext): void {
  server.tool(
    "apply_plan",
    "Apply a previously generated infrastructure plan. REQUIRES confirmed: true as a safety mechanism — the AI agent must explicitly confirm before provisioning.",
    applyPlanParams,
    async ({ checkpointPath, confirmed }) => {
      // ── Safety gate: reject unconfirmed applies ────────────────────────
      if (!confirmed) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message:
                  "Apply requires explicit confirmation. Set confirmed: true to proceed with provisioning.",
                hint: "This safety mechanism prevents accidental resource creation. Review the plan from plan_resource before confirming.",
              }),
            },
          ],
          isError: true,
        };
      }

      // ── Validate graph context is available ────────────────────────────
      if (!ctx) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message:
                  "MCP server graph context not initialized. Server must be started with graph initialization.",
              }),
            },
          ],
          isError: true,
        };
      }

      // ── Path validation: reject path traversal attempts ───────────────
      if (
        checkpointPath.includes("..") ||
        (!checkpointPath.startsWith("/tmp/") &&
          !checkpointPath.startsWith("/var/") &&
          !checkpointPath.includes("assignee"))
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message:
                  "Invalid checkpoint path. Path must be within the assignee checkpoint directory.",
              }),
            },
          ],
          isError: true,
        };
      }

      // ── Load and validate checkpoint ───────────────────────────────────
      let checkpoint;
      try {
        checkpoint = await loadCheckpointFromPath(checkpointPath);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message:
                  err instanceof CheckpointError
                    ? err.message
                    : `Checkpoint file not found: ${checkpointPath}. Run plan_resource first.`,
              }),
            },
          ],
          isError: true,
        };
      }

      // ── Concurrency guard: prevent duplicate applies on the same checkpoint ──
      if (activeApplies.has(checkpointPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message:
                  "This plan is already being applied. Wait for the current operation to complete.",
              }),
            },
          ],
          isError: true,
        };
      }
      activeApplies.add(checkpointPath);

      // ── Invoke graph in APPLY mode from checkpoint ─────────────────────
      const runId = checkpoint.runId;
      const config = {
        configurable: { thread_id: `${runId}-mcp-apply` },
        recursionLimit: 50, // Story E2E.1: increased from default 25 for compound patterns
      };

      try {
        // Phase 1: inject checkpoint state, auto-approve (no HITL in MCP context)
        await ctx.graph.invoke(
          {
            checkpointResumed: true,
            userIntent: checkpoint.userIntent,
            runId,
            executionMode: ExecutionMode.APPLY,
            startedAt: Date.now(),
            resourceType: checkpoint.resourceType,
            desiredState: checkpoint.desiredState,
            estimatedMonthlyCost: checkpoint.estimatedMonthlyCost,
            preflightPassed: checkpoint.preflightPassed,
            elicitedOptions: checkpoint.elicitedOptions,
            resourceQueue: checkpoint.resourceQueue,
            autoApprove: true, // MCP server bypasses HITL (confirmed gate is the safety mechanism)
          },
          config,
        );

        // Phase 2: provisioning loop with 5-minute timeout (Story E2E.1 AC3)
        const APPLY_TIMEOUT_MS = 5 * 60 * 1000;
        const applyStarted = Date.now();

        while (true) {
          if (Date.now() - applyStarted > APPLY_TIMEOUT_MS) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: true,
                    message: `Provisioning timed out after ${APPLY_TIMEOUT_MS / 1000}s. Some resources may have been partially created. Use list_managed_resources to check.`,
                    status: "TIMEOUT",
                  }),
                },
              ],
              isError: true,
            };
          }
          await ctx.graph.invoke(null, config);
          const graphState = await ctx.graph.getState(config);
          if (graphState.next.length === 0) break;
        }

        const finalState = (await ctx.graph.getState(config)).values;

        // ── Return structured result ──────────────────────────────────────
        const success =
          finalState["executionStatus"] === ExecutionStatus.SUCCESS;

        if (!success) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message:
                    (finalState["errorMessage"] as string) ??
                    "Provisioning failed",
                  status: finalState["executionStatus"],
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "SUCCESS",
                resourceArn: finalState["resourceArn"],
                resourceType: finalState["resourceType"],
                estimatedMonthlyCost: finalState["estimatedMonthlyCost"],
                securityFindings:
                  (finalState["securityFindings"] as unknown[]) ?? [],
                completedResources:
                  (finalState["completedResources"] as unknown[]) ?? [],
                runId,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Provisioning error: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      } finally {
        activeApplies.delete(checkpointPath);
      }
    },
  );
}
