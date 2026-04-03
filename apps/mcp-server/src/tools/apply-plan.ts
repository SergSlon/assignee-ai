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
  BPEnforcementLevel,
  StateField,
} from "@assignee/core";
import {
  loadBestPractices,
  evaluateTriggers,
  type BestPractice,
  type BPFinding,
  type EvalContext,
} from "@assignee/best-practices";
import type { GraphContext } from "../services/graph-init.js";
import { loadCheckpointFromPath } from "../services/checkpoint.js";

/** Module-level BP cache for MCP server (Story 41.4). */
let cachedPractices: BestPractice[] | undefined;

function loadCachedPractices(): BestPractice[] {
  if (cachedPractices === undefined) {
    cachedPractices = loadBestPractices();
  }
  return cachedPractices;
}

/** Exported for testing — resets the BP cache. */
export function _resetBPCache(): void {
  cachedPractices = undefined;
}

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

      // ── Story 41.4: BP re-evaluation before provisioning ──────────────
      // Re-evaluate BP rules against the checkpoint's desiredState to catch
      // rules added/modified after the original plan was generated.
      // MCP always enforces BPs — block on any blocking finding.
      let bpFindings: BPFinding[] | undefined;
      let preflightPassed = checkpoint.preflightPassed;

      try {
        const practices = loadCachedPractices();
        const context: EvalContext = {
          resourceType: checkpoint.resourceType,
          desiredState: checkpoint.desiredState,
          userIntent: checkpoint.userIntent,
          patternId: checkpoint.resourcePatternId ?? undefined,
        };
        const findings = evaluateTriggers(context, practices);
        const blockingFindings = findings.filter((f) => f.blocking);

        if (blockingFindings.length > 0) {
          preflightPassed = false;
          activeApplies.delete(checkpointPath);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message: `BP re-evaluation blocked apply: ${blockingFindings.length} blocking finding(s) detected since the plan was generated.`,
                  blockingFindings: blockingFindings.map((f) => ({
                    practiceId: f.practiceId,
                    title: f.title,
                    severity: f.severity,
                    message: f.message,
                    remediation: f.remediation,
                    consequence: f.consequence,
                  })),
                  hint: "Run plan_resource again to generate a new plan that satisfies current best practices.",
                }),
              },
            ],
            isError: true,
          };
        }
        if (findings.length > 0) {
          bpFindings = findings;
        }
      } catch (bpError: unknown) {
        // BP evaluation failure must be fail-closed in enforce mode —
        // block provisioning rather than silently skipping all rules.
        preflightPassed = false;
        activeApplies.delete(checkpointPath);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `BP evaluation failed — cannot verify security compliance. ${bpError instanceof Error ? bpError.message : String(bpError)}`,
                hint: "Check that best-practice rules are accessible. Run plan_resource to generate a fresh plan.",
              }),
            },
          ],
          isError: true,
        };
      }

      // ── Invoke graph in APPLY mode from checkpoint ─────────────────────
      const runId = checkpoint.runId;
      const config = {
        configurable: { thread_id: `${runId}-mcp-apply` },
        recursionLimit: 500, // RDS provisioning: ~8min at 2s poll = 240 cycles + compound multi-resource headroom
      };

      try {
        // Phase 1: inject checkpoint state, auto-approve (no HITL in MCP context)
        await ctx.graph.invoke(
          {
            checkpointResumed: true,
            userIntent: checkpoint.userIntent,
            runId,
            executionMode: ExecutionMode.APPLY,
            bpEnforcementLevel: BPEnforcementLevel.ENFORCE,
            startedAt: Date.now(),
            resourceType: checkpoint.resourceType,
            desiredState: checkpoint.desiredState,
            estimatedMonthlyCost: checkpoint.estimatedMonthlyCost,
            preflightPassed,
            elicitedOptions: checkpoint.elicitedOptions,
            resourceQueue: checkpoint.resourceQueue,
            autoApprove: true, // MCP server bypasses HITL (confirmed gate is the safety mechanism)
            ...(bpFindings ? { bpFindings } : {}),
          },
          config,
        );

        // Phase 2: provisioning loop with 10-minute timeout.
        // RDS/ELBv2 can take 5-10 min with many polling cycles; compound patterns multiply this.
        const APPLY_TIMEOUT_MS = 10 * 60 * 1000;
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
          finalState[StateField.EXECUTION_STATUS] === ExecutionStatus.SUCCESS;

        if (!success) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message:
                    (finalState[StateField.ERROR_MESSAGE] as string) ??
                    "Provisioning failed",
                  status: finalState[StateField.EXECUTION_STATUS],
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
                resourceArn: finalState[StateField.RESOURCE_ARN],
                resourceType: finalState[StateField.RESOURCE_TYPE],
                estimatedMonthlyCost:
                  finalState[StateField.ESTIMATED_MONTHLY_COST],
                securityFindings:
                  (finalState[StateField.SECURITY_FINDINGS] as unknown[]) ?? [],
                completedResources:
                  (finalState[StateField.COMPLETED_RESOURCES] as unknown[]) ??
                  [],
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
