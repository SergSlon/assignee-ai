/**
 * result_formatter node — final rendering gate.
 * Handles all terminal outcomes: SUCCESS, FAILED, CANCELLED, and plan-mode preview.
 *
 * @see Story 2-4, Story 9-6, Story 18-3
 */

import crypto from "node:crypto";
import {
  ExecutionStatus,
  ExecutionMode,
  defaultErrorHintRegistry,
  AssigneeError,
  ProvisioningError,
  type ResourceResult,
} from "@assignee/core";
import { defaultMemoryService } from "../services/memory.js";
import type { StructuredTool } from "@langchain/core/tools";
import {
  renderApplySuccess,
  renderCompoundSuccess,
  renderError,
  renderPlanBox,
  renderSecurityWarnings,
} from "../utils/display.js";
import { defaultErrorMessageRegistry } from "../utils/error-messages.js";
import { ToolName } from "../constants/tools.js";
import { unwrapMcpText } from "../utils/mcp.js";
import { withTimeout } from "../utils/timeout.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

/** Security check timeout — longer than pricing (5s vs 3s) as security services aggregate from multiple sources. */
const SECURITY_CHECK_TIMEOUT_MS = 5000;

/**
 * Post-provision security posture check (Story 19.2).
 * Non-blocking: findings are informational warnings only.
 * Gracefully degrades if the MCP server is unavailable or times out.
 */
async function checkSecurityPosture(
  resourceArn: string,
  tools: StructuredTool[],
  runId: string,
): Promise<void> {
  const securityTool = tools.find(
    (t) => t.name === ToolName.ANALYZE_SECURITY_POSTURE,
  );
  if (!securityTool) return;

  try {
    const result = await withTimeout(
      securityTool.invoke({
        resource_arn: resourceArn,
      }),
      SECURITY_CHECK_TIMEOUT_MS,
    );
    if (result !== null) {
      const posture = JSON.parse(unwrapMcpText(result));
      const criticalHighFindings = (posture.findings ?? []).filter(
        (f: any) => f.severity === "CRITICAL" || f.severity === "HIGH",
      );
      if (criticalHighFindings.length > 0) {
        renderSecurityWarnings(resourceArn, criticalHighFindings);
      }
    }
  } catch {
    process.stderr.write(
      "Security posture check skipped (MCP server unavailable)\n",
    );
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.SECURITY_CHECK_SKIPPED,
      extras: { resourceArn },
    });
  }
}

/**
 * Writes a provision record to the memory log (Story 19.3).
 * Fire-and-forget: failures are logged but never block the apply result.
 */
async function writeProvisionRecord(
  runId: string,
  resourceType: string,
  resourceArn: string | undefined,
  desiredState: Record<string, unknown> | undefined,
  estimatedMonthlyCost: string | undefined,
): Promise<void> {
  try {
    await defaultMemoryService.appendProvision({
      runId,
      resourceType: resourceType || "unknown",
      resourceArn: resourceArn ?? "",
      region:
        process.env["AWS_REGION"] ??
        process.env["AWS_DEFAULT_REGION"] ??
        "unknown",
      desiredStateHash: crypto
        .createHash("sha256")
        .update(JSON.stringify(desiredState ?? {}))
        .digest("hex"),
      estimatedMonthlyCost: estimatedMonthlyCost ?? "N/A",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: "memory_write_failed",
      extras: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Writes a failure record to the memory log (Story 19.4).
 * Fire-and-forget: failures are logged but never block the error output.
 */
async function writeFailureRecord(
  runId: string,
  resourceType: string,
  error: AssigneeError | undefined,
  errorMessage: string | undefined,
): Promise<void> {
  const suggestedFix =
    defaultErrorHintRegistry.getHint(error) ??
    (error ? defaultErrorMessageRegistry.resolve(error).howToFix : "") ??
    "";

  const errorCode =
    error instanceof ProvisioningError
      ? error.provisioningCode
      : error instanceof AssigneeError
        ? error.code
        : "UNKNOWN";

  try {
    await defaultMemoryService.appendFailure({
      runId,
      resourceType: resourceType || "unknown",
      errorCode,
      errorMessage: errorMessage ?? "Unknown error",
      suggestedFix,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: "memory_write_failed" as any,
      extras: {
        memoryWriteError: "Failed to write failure record",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/**
 * Clears stale failure records for a resource type after a successful provision (Story 20.13).
 * Fire-and-forget: failures are logged but never block the apply result.
 */
async function clearFailureHistory(
  runId: string,
  resourceType: string,
): Promise<void> {
  try {
    await defaultMemoryService.clearFailuresForType(resourceType);
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: "memory_write_failed" as any,
      extras: {
        memoryWriteError: "Failed to clear failure history",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export async function resultFormatterNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESULT_FORMATTED,
    extras: { executionStatus: state.executionStatus },
  });

  switch (state.executionStatus) {
    case ExecutionStatus.SUCCESS: {
      // Compound mode: accumulate result and signal loop to continue
      if (
        state.resourcePattern &&
        state.resourceQueue &&
        state.currentResourceIndex !== undefined
      ) {
        const currentResource = state.resourceQueue[state.currentResourceIndex];
        if (!currentResource) return {};
        const completedEntry: ResourceResult = {
          resourceId: currentResource.resourceId,
          resourceType: currentResource.resourceType,
          resourceArn: state.resourceArn,
          executionStatus: ExecutionStatus.SUCCESS,
        };
        const updatedCompleted = [
          ...(state.completedResources ?? []),
          completedEntry,
        ];
        const nextIndex = state.currentResourceIndex + 1;

        if (nextIndex < state.resourceQueue.length) {
          // More resources to provision — update state for next iteration
          const nextResource = state.resourceQueue[nextIndex];
          if (!nextResource) break;
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "info",
            action: LOG_ACTIONS.APPLY_SUCCEEDED,
            extras: {
              resourceArn: state.resourceArn,
              resourceType: currentResource.resourceType,
              compound: true,
            },
          });
          return {
            completedResources: updatedCompleted,
            currentResourceIndex: nextIndex,
            resourceType: nextResource.resourceType,
            desiredState: undefined,
            requestToken: undefined,
            resourceArn: undefined,
            executionStatus: ExecutionStatus.PENDING, // Reset for next resource
          };
        }

        // All resources provisioned — render compound summary
        renderCompoundSuccess(updatedCompleted, state.resourcePattern);
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.APPLY_SUCCEEDED,
          extras: { compound: true, completedCount: updatedCompleted.length },
        });

        // Story 19.3: write provision record for each completed resource
        for (const completed of updatedCompleted) {
          await writeProvisionRecord(
            state.runId,
            completed.resourceType,
            completed.resourceArn,
            undefined,
            state.perResourceCosts?.[completed.resourceId ?? ""],
          );
        }

        // Story 20.13: clear stale failure history for all successfully provisioned resource types
        const succeededTypes = new Set(
          updatedCompleted
            .filter((r) => r.executionStatus === ExecutionStatus.SUCCESS)
            .map((r) => r.resourceType),
        );
        for (const resourceType of succeededTypes) {
          await clearFailureHistory(state.runId, resourceType);
        }

        // Story 19.5: Write pattern memory record for compound patterns
        if (state.resourcePattern) {
          try {
            await defaultMemoryService.upsertPattern({
              pattern: state.resourcePattern.patternId,
              optionsSelected: state.elicitedOptions ?? {},
              count: 1, // upsertPattern handles incrementing
              lastUsed: new Date().toISOString(),
            });
          } catch {
            log({
              ts: new Date().toISOString(),
              runId: state.runId,
              level: "warn",
              action: LOG_ACTIONS.RESULT_FORMATTED,
              extras: { memoryWriteError: "Failed to write pattern record" },
            });
          }
        }

        // Story 19.2: Post-provision security posture check for each compound resource (non-blocking)
        if (tools) {
          for (const resource of updatedCompleted) {
            if (resource.resourceArn) {
              await checkSecurityPosture(
                resource.resourceArn,
                tools,
                state.runId,
              );
            }
          }
        }

        return { completedResources: updatedCompleted };
      }

      // Single-resource path — unchanged
      renderApplySuccess(state);
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.APPLY_SUCCEEDED,
        extras: { resourceArn: state.resourceArn },
      });

      // Story 19.3: write provision record for single-resource success
      await writeProvisionRecord(
        state.runId,
        state.resourceType,
        state.resourceArn,
        state.desiredState,
        state.estimatedMonthlyCost,
      );

      // Story 20.13: clear stale failure history after successful provision
      await clearFailureHistory(state.runId, state.resourceType);

      // Story 19.2: Post-provision security posture check (non-blocking)
      if (state.resourceArn && tools) {
        await checkSecurityPosture(state.resourceArn, tools, state.runId);
      }

      break;
    }

    case ExecutionStatus.CANCELLED:
      // Silent exit — user intentionally declined
      break;

    case ExecutionStatus.FAILED:
    case ExecutionStatus.POLICY_BLOCKED:
    case ExecutionStatus.UNSUPPORTED_RESOURCE: {
      // Resolve structured error message via the error message registry (Story 18.3)
      const resolved = state.error
        ? defaultErrorMessageRegistry.resolve(state.error)
        : defaultErrorMessageRegistry.resolveMessage(
            state.errorMessage ?? "An unknown error occurred",
          );

      // Legacy hint from ErrorHintRegistry as fallback for howToFix
      const legacyHint = defaultErrorHintRegistry.getHint(state.error);

      // Compound mode: show partial results with cleanup guidance (EC-22)
      if (
        state.resourcePattern &&
        state.completedResources &&
        state.completedResources.length > 0
      ) {
        const successfulResources = state.completedResources.filter(
          (r) => r.executionStatus === ExecutionStatus.SUCCESS,
        );
        const provisioned = successfulResources
          .map((r) => r.resourceType)
          .join(", ");
        const haltedAt = state.resourceType ?? "unknown resource";

        // Build cleanup guidance with ARNs in reverse dependency order
        const resourcesWithArns = successfulResources.filter(
          (r) => r.resourceArn,
        );
        const reversedResources = [...resourcesWithArns].reverse();

        let cleanupGuidance = "";
        if (reversedResources.length > 0) {
          const arnList = reversedResources
            .map(
              (r) => `  - ${r.resourceType}: assignee destroy ${r.resourceArn}`,
            )
            .join("\n");
          cleanupGuidance =
            `\n\nSuccessfully created resources:\n${arnList}` +
            `\n\nTo clean up partially created resources, run the destroy commands above in the listed order (reverse dependency order).`;
        }

        renderError(
          `Provision halted at ${haltedAt}. Previously provisioned: ${provisioned}. Manual cleanup may be required.${cleanupGuidance}`,
          legacyHint ?? resolved.howToFix,
          { why: resolved.why },
        );
      } else {
        renderError(resolved.what, legacyHint ?? resolved.howToFix, {
          why: resolved.why,
        });
      }
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "error",
        action: LOG_ACTIONS.APPLY_FAILED,
        extras: { errorMessage: state.errorMessage },
      });

      // Story 19.4: Write failure record to memory log (fire-and-forget)
      await writeFailureRecord(
        state.runId,
        state.resourceType,
        state.error,
        state.errorMessage,
      );

      break;
    }

    default:
      // PENDING = plan mode — render plan preview box
      if (state.executionMode === ExecutionMode.PLAN) {
        if (state.outputFormat === "json") {
          const region =
            process.env["AWS_REGION"] ??
            process.env["AWS_DEFAULT_REGION"] ??
            "us-east-1";
          const jsonPayload = {
            resourceType: state.resourceType,
            region,
            desiredState: state.desiredState ?? null,
            estimatedMonthlyCost: state.estimatedMonthlyCost ?? null,
            pricingBreakdown: state.pricingBreakdown ?? null,
            bpFindings: state.bpFindings ?? [],
            appliedFixes: state.appliedFixes ?? [],
            freeTierNote: state.freeTierNote ?? null,
          };
          process.stdout.write(JSON.stringify(jsonPayload, null, 2) + "\n");
        } else {
          renderPlanBox(state);
        }
      }
      break;
  }

  return {};
}
