/**
 * IAM pre-check: simulate the operator's principal policy against the
 * actions required to provision the target resource type. Returns a
 * (passed, missing[]) tuple — the orchestrator decides whether to fail.
 *
 * Graceful-degradation rules (preserved verbatim):
 * - Missing tool or no caller ARN → pass (no actions missing).
 * - Timeout from MCP → pass.
 * - Any thrown error → WARN + pass (preflight never blocks apply on its own
 *   observability failure).
 */
import type { StructuredTool } from "@langchain/core/tools";
import { getRequiredIamActions } from "@/config/iam-actions/index.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { PRICING_TIMEOUT_MS } from "@/config/constants/timeouts.js";
import { ToolName } from "@/constants/tools.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { unwrapMcpText } from "@/utils/mcp.js";
import { withTimeout } from "@/utils/timeout.js";
import { getOperatorCallerArn } from "@/utils/resolve-arn.js";

export interface IamCheckResult {
  passed: boolean;
  missing: string[];
}

export async function runIamPermissionsCheck(
  resourceType: string | undefined,
  tools: StructuredTool[] | undefined,
  runId: string,
): Promise<IamCheckResult> {
  if (!tools || !resourceType) return { passed: true, missing: [] };
  const iamTool = tools.find(
    (t) => t.name === ToolName.SIMULATE_PRINCIPAL_POLICY,
  );
  if (!iamTool) return { passed: true, missing: [] };
  void AWS_REGION; // currently unused here but kept in config for symmetry
  try {
    const callerArn = await getOperatorCallerArn();
    if (!callerArn) {
      log({
        ts: new Date().toISOString(),
        runId,
        level: "warn",
        action: LOG_ACTIONS.IAM_CHECK_SKIPPED,
        extras: {
          resourceType,
          reason: "operator_arn_unavailable",
        },
      });
      return { passed: true, missing: [] };
    }
    const requiredActions = getRequiredIamActions(resourceType);
    const result = await withTimeout(
      iamTool.invoke({
        policy_source_arn: callerArn,
        action_names: requiredActions,
        resource_arns: ["*"],
      }),
      PRICING_TIMEOUT_MS,
    );
    if (result === null) return { passed: true, missing: [] };
    const parsed = JSON.parse(unwrapMcpText(result)) as {
      result?: {
        EvaluationResults?: Array<{
          EvalDecision?: string;
          EvalActionName?: string;
        }>;
      };
      EvaluationResults?: Array<{
        EvalDecision?: string;
        EvalActionName?: string;
      }>;
    };
    const simResult = parsed.result ?? parsed;
    const missing = (simResult.EvaluationResults ?? [])
      .filter((r) => r.EvalDecision !== "allowed")
      .map((r) => r.EvalActionName as string);
    return { passed: missing.length === 0, missing };
  } catch {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.IAM_CHECK_SKIPPED,
      extras: { resourceType },
    });
    return { passed: true, missing: [] };
  }
}
