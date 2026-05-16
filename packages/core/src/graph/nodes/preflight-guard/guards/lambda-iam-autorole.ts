/**
 * Guard: detect missing `iam:CreateRole` + `iam:AttachRolePolicy` when
 * a Lambda intent will auto-create an execution role.
 *
 * Problem (DF-D5, dogfood 2026-05-11):
 *   The operator applies `assignee plan "Create a Lambda hello world"`.
 *   The intent-parser routes this through the `lambda-with-exec-role`
 *   compound pattern which creates TWO resources:
 *     1. AWS::IAM::Role  (auto-created execution role)
 *     2. AWS::Lambda::Function  (the function itself)
 *
 *   The existing `runIamPermissionsCheck` in preflight-guard.ts calls
 *   `getRequiredIamActions("AWS::Lambda::Function")` — which returns
 *   lambda:CreateFunction + iam:PassRole but NOT iam:CreateRole. The
 *   operator user may have been provisioned before the iam:CreateRole
 *   action was added to the operator policy, so the apply call hits
 *   CloudControl and fails mid-flight with an opaque "not authorized
 *   to perform: iam:CreateRole" error — with no pre-apply hint.
 *
 * Fix:
 *   When the resourceType is AWS::Lambda::Function AND the desiredState
 *   has NO explicit `Role` ARN (i.e. the apply will auto-create a role),
 *   add iam:CreateRole + iam:AttachRolePolicy to the IAM simulation check
 *   so the missing-permission is surfaced BEFORE apply.
 *
 * Behaviour:
 *   - The guard delegates to `runIamPermissionsCheck` (the standard
 *     iam-permissions helper) with the two extra actions injected.
 *   - If the operator HAS the permissions → PASS, no message.
 *   - If the guard cannot resolve the caller ARN or the IAM MCP tool
 *     is unavailable → SKIP (graceful degradation, matches the
 *     existing IAM check behaviour).
 *   - If the resourceType is NOT Lambda → SKIP (guard is λ-specific).
 *   - If an explicit `Role` ARN is already in desiredState → SKIP
 *     (user supplied their own role; no auto-creation will happen).
 *
 * The actionable error message names the missing permissions AND the
 * escape hatch `--set Role=arn:...` so the user always has a path forward.
 *
 * Story 108-A-02 — DF-D5
 */

import type { StructuredTool } from "@langchain/core/tools";
import { RESOURCE_TYPES } from "@/config/resource-types.js";
import { ToolName } from "@/constants/tools.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { withTimeout } from "@/utils/timeout.js";
import { PRICING_TIMEOUT_MS } from "@/config/constants/timeouts.js";
import { unwrapMcpText } from "@/utils/mcp.js";
import { getOperatorCallerArn } from "@/utils/resolve-arn.js";
import type { GuardContext, GuardResult, PreflightGuard } from "../types.js";
import { failResult, passResult, skipResult } from "../types.js";

/** Actions required specifically for Lambda auto-role creation. */
const LAMBDA_AUTO_ROLE_ACTIONS = [
  "iam:CreateRole",
  "iam:AttachRolePolicy",
] as const;

/**
 * Returns true when the desiredState has a non-empty `Role` field
 * (explicit execution role ARN provided by the user — no auto-creation needed).
 */
function hasExplicitRole(desiredState: Record<string, unknown>): boolean {
  const role = desiredState["Role"];
  return typeof role === "string" && role.trim().length > 0;
}

/**
 * Simulate `iam:CreateRole` + `iam:AttachRolePolicy` against the operator
 * principal using the IAM MCP tool. Returns PASS when either:
 *   - No IAM MCP tool is available (graceful degradation)
 *   - Caller ARN can't be resolved (degraded env)
 *   - Simulation times out
 * Returns FAIL with an actionable message when the simulation explicitly
 * denies either action.
 *
 * Pure async function — no side effects beyond the IAM API call.
 */
async function simulateLambdaAutoRolePermissions(
  tools: StructuredTool[],
  runId: string,
): Promise<GuardResult> {
  const iamTool = tools.find(
    (t) => t.name === ToolName.SIMULATE_PRINCIPAL_POLICY,
  );
  if (!iamTool) {
    return skipResult(
      "iam simulate tool unavailable; skipping auto-role check",
    );
  }

  let callerArn: string | null;
  try {
    callerArn = (await getOperatorCallerArn()) ?? null;
  } catch {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.IAM_CHECK_SKIPPED,
      extras: {
        guard: "lambda-iam-autorole",
        reason: "caller_arn_resolution_failed",
      },
    });
    return skipResult("caller ARN unavailable; skipping auto-role check");
  }

  if (!callerArn) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.IAM_CHECK_SKIPPED,
      extras: {
        guard: "lambda-iam-autorole",
        reason: "operator_arn_unavailable",
      },
    });
    return skipResult("operator ARN unavailable; skipping auto-role check");
  }

  let result: unknown;
  try {
    result = await withTimeout(
      iamTool.invoke({
        policy_source_arn: callerArn,
        action_names: [...LAMBDA_AUTO_ROLE_ACTIONS],
        resource_arns: ["*"],
      }),
      PRICING_TIMEOUT_MS,
    );
  } catch {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.IAM_CHECK_SKIPPED,
      extras: {
        guard: "lambda-iam-autorole",
        reason: "iam_simulate_timeout_or_error",
      },
    });
    return skipResult("IAM simulation timed out; skipping auto-role check");
  }

  if (result === null) {
    return skipResult("IAM simulation returned null; skipping auto-role check");
  }

  let parsed: {
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
  try {
    parsed = JSON.parse(unwrapMcpText(result)) as typeof parsed;
  } catch {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.IAM_CHECK_SKIPPED,
      extras: {
        guard: "lambda-iam-autorole",
        reason: "iam_simulate_parse_failed",
      },
    });
    return skipResult(
      "IAM simulation response unparseable; skipping auto-role check",
    );
  }

  const simResult = parsed.result ?? parsed;
  const missing = (simResult.EvaluationResults ?? [])
    .filter((r) => r.EvalDecision !== "allowed")
    .map((r) => r.EvalActionName as string)
    .filter((a) =>
      LAMBDA_AUTO_ROLE_ACTIONS.includes(
        a as (typeof LAMBDA_AUTO_ROLE_ACTIONS)[number],
      ),
    );

  if (missing.length === 0) return passResult;

  return failResult(buildMissingRolePermissionsMessage(missing));
}

function buildMissingRolePermissionsMessage(missing: string[]): string {
  return (
    `Your operator role lacks ${missing.join(", ")}. ` +
    `Lambda auto-role creation requires these permissions to create and configure ` +
    `the execution role (AWS::IAM::Role) before the Lambda function is provisioned. ` +
    `To fix:\n` +
    `  1. Run \`assignee setup\` to refresh the operator policy ` +
    `(adds missing actions via CreatePolicyVersion — no user recreation needed).\n` +
    `  2. Or supply an existing execution role ARN via ` +
    `\`--set Role=arn:aws:iam::<account>:role/<role-name>\` ` +
    `to skip auto-role creation entirely.\n` +
    `  3. Or run \`assignee audit-verify\` to see all required permissions ` +
    `for this resource type.`
  );
}

/**
 * The guard. Exported as the production singleton registered in registry.ts.
 * Also exported as a factory for tests (so they can inject mock tools without
 * relying on the guard's internal ToolName lookup).
 */
export const lambdaIamAutoRoleGuard: PreflightGuard = {
  id: "lambda-iam-autorole",
  async run(ctx: GuardContext): Promise<GuardResult> {
    // Only applies to Lambda function resources.
    if (ctx.state.resourceType !== RESOURCE_TYPES.LAMBDA_FUNCTION) {
      return skipResult("not a Lambda resource");
    }

    // If the user supplied an explicit Role ARN, auto-role creation is
    // bypassed — no need to check iam:CreateRole.
    if (hasExplicitRole(ctx.desiredState)) {
      return skipResult("explicit Role ARN provided; no auto-role creation");
    }

    if (!ctx.tools || ctx.tools.length === 0) {
      return skipResult(
        "no tools available; skipping Lambda IAM auto-role check",
      );
    }

    return simulateLambdaAutoRolePermissions(
      ctx.tools,
      ctx.state.runId ?? "system",
    );
  },
};
