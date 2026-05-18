/**
 * Regression tests for DF-D5 fix — Lambda auto-role IAM preflight guard.
 *
 * Dogfood finding (2026-05-11): `assignee infra apply "Create a Lambda hello world"`
 * attempted to create an IAM execution role as part of the lambda-with-exec-role
 * compound pattern. The operator IAM user lacked `iam:CreateRole`. The preflight
 * guard did NOT detect the missing permission in advance — the user saw a
 * mid-apply CCAPI error with no actionable guidance.
 *
 * Fix: `lambdaIamAutoRoleGuard` checks `iam:CreateRole` + `iam:AttachRolePolicy`
 * when the resourceType is Lambda AND no explicit `Role` ARN is in desiredState.
 *
 * These tests FAIL against the pre-fix code (guard not registered, guard does
 * not exist) and PASS after the fix.
 *
 * Story 108-A-02 — Probe axes exercised:
 *   Axis A — Lambda, auto-role, operator lacks iam:CreateRole → preflight blocks
 *   Axis B — Lambda, explicit Role ARN provided → guard skips
 *   Axis C — Lambda, operator HAS iam:CreateRole → preflight passes
 *   Axis D — Non-Lambda resource type → guard skips
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { lambdaIamAutoRoleGuard } from "../guards/lambda-iam-autorole.js";
import type { GuardContext } from "../types.js";
import { RESOURCE_TYPES } from "../../../../config/resource-types.js";
import { ToolName } from "../../../../constants/tools.js";
import { enumerateTypes } from "../../../../__tests__/variant-matrix/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal GuardContext for Lambda tests.
 * resourceType defaults to AWS::Lambda::Function.
 */
function lambdaCtx(
  desiredState: Record<string, unknown>,
  opts: { resourceType?: string; tools?: StructuredTool[] } = {},
): GuardContext {
  return {
    state: {
      userIntent: "Create a Lambda hello world",
      runId: "run-test-lambda-iam",
      executionMode: "apply",
      resourceType: opts.resourceType ?? RESOURCE_TYPES.LAMBDA_FUNCTION,
      resourceSchema: undefined,
      desiredState,
      messages: [],
      preflightPassed: false,
      preflightErrors: [],
      preflightMode: "local",
    } as unknown as GuardContext["state"],
    desiredState,
    tools: opts.tools,
  };
}

/**
 * Build a mock IAM SimulatePrincipalPolicy tool that returns the given
 * evaluation decisions. `decision` is either "allowed" or "implicitDeny"
 * per the AWS SDK response shape.
 *
 * The real iam-mcp-server wraps the payload in a `{ result: { ... } }` envelope
 * and then in a `{ type: "text", text: <json> }` MCP content block.
 * `unwrapMcpText` in the guard extracts `.text` → `JSON.parse` unwraps `{ result }`.
 * This helper matches that wire shape so guards correctly process denials.
 */
function buildMockIamTool(
  decisions: Record<string, "allowed" | "implicitDeny">,
): StructuredTool {
  const payload = {
    result: {
      EvaluationResults: Object.entries(decisions).map(
        ([action, decision]) => ({
          EvalActionName: action,
          EvalDecision: decision,
        }),
      ),
      IsTruncated: false,
    },
  };
  return {
    name: ToolName.SIMULATE_PRINCIPAL_POLICY,
    invoke: vi
      .fn()
      .mockResolvedValue({ type: "text", text: JSON.stringify(payload) }),
  } as unknown as StructuredTool;
}

/**
 * Mock getOperatorCallerArn to return a stable test ARN.
 *
 * Uses vi.hoisted + closure pattern (same as preflight-guard.test.ts) to
 * survive vitest's `mockReset: true` config — which resets vi.fn()
 * implementations between tests. The closure keeps the stable function
 * reference while beforeEach restores the resolved value each test.
 */
const mockGetOperatorCallerArn = vi.hoisted(() =>
  vi.fn<() => Promise<string | undefined>>(),
);
vi.mock("@/utils/resolve-arn.js", () => ({
  getOperatorCallerArn: () => mockGetOperatorCallerArn(),
  resolveResourceArn: vi.fn(),
  getOperatorAccountId: vi.fn(),
  resetAccountIdCache: vi.fn(),
}));

beforeEach(() => {
  mockGetOperatorCallerArn.mockResolvedValue(
    "arn:aws:iam::112233445566:user/assignee-operator",
  );
});

// ---------------------------------------------------------------------------
// Axis A — Lambda, auto-role (no explicit Role), operator lacks iam:CreateRole
// ---------------------------------------------------------------------------

describe("Axis A — Lambda auto-role: operator lacks iam:CreateRole", () => {
  it("Axis A-1: guard fails when iam:CreateRole is denied", async () => {
    const mockTool = buildMockIamTool({
      "iam:CreateRole": "implicitDeny",
      "iam:AttachRolePolicy": "allowed",
    });

    const ctx = lambdaCtx(
      {
        FunctionName: "assignee-lambda-fn-abc123",
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Code: { ZipFile: "exports.handler = () => ({})" },
        // No Role field → auto-role will be created
      },
      { tools: [mockTool] },
    );

    const result = await lambdaIamAutoRoleGuard.run(ctx);

    expect(result.kind).toBe("fail");
    expect(
      (result as { kind: "fail"; errorMessage: string }).errorMessage,
    ).toContain("iam:CreateRole");
  });

  it("Axis A-2: actionable message names the escape hatch --set Role=arn:...", async () => {
    const mockTool = buildMockIamTool({
      "iam:CreateRole": "implicitDeny",
      "iam:AttachRolePolicy": "implicitDeny",
    });

    const ctx = lambdaCtx({ FunctionName: "test-fn" }, { tools: [mockTool] });

    const result = await lambdaIamAutoRoleGuard.run(ctx);

    expect(result.kind).toBe("fail");
    const { errorMessage } = result as { kind: "fail"; errorMessage: string };
    // Must include escape hatch for user to provide explicit role
    expect(errorMessage).toContain("--set Role=");
    expect(errorMessage).toContain("iam:CreateRole");
  });

  it("Axis A-3: message also references assignee admin audit-verify", async () => {
    const mockTool = buildMockIamTool({
      "iam:CreateRole": "implicitDeny",
      "iam:AttachRolePolicy": "allowed",
    });

    const ctx = lambdaCtx({ FunctionName: "test-fn" }, { tools: [mockTool] });

    const result = await lambdaIamAutoRoleGuard.run(ctx);

    const { errorMessage } = result as { kind: "fail"; errorMessage: string };
    expect(errorMessage).toContain("assignee admin audit-verify");
  });
});

// ---------------------------------------------------------------------------
// Axis B — Lambda with explicit Role ARN provided (guard must skip)
// ---------------------------------------------------------------------------

describe("Axis B — Lambda with explicit ExecutionRoleArn: guard skips", () => {
  it("Axis B-1: guard skips when Role ARN is explicitly provided", async () => {
    const mockTool = buildMockIamTool({
      "iam:CreateRole": "implicitDeny",
      "iam:AttachRolePolicy": "implicitDeny",
    });

    const ctx = lambdaCtx(
      {
        FunctionName: "test-fn",
        // Explicit Role ARN: user is supplying their own role
        Role: "arn:aws:iam::112233445566:role/my-existing-execution-role",
      },
      { tools: [mockTool] },
    );

    const result = await lambdaIamAutoRoleGuard.run(ctx);

    // Guard must skip — no auto-role check when explicit role is provided
    expect(result.kind).toBe("skip");
    // IAM simulation tool must NOT have been called
    expect(mockTool.invoke).not.toHaveBeenCalled();
  });

  it("Axis B-2: guard skips with full ARN role even if iam:CreateRole denied", async () => {
    const mockTool = buildMockIamTool({
      "iam:CreateRole": "implicitDeny",
    });

    const ctx = lambdaCtx(
      {
        Role: "arn:aws:iam::112233445566:role/existing-lambda-exec-role",
        Runtime: "python3.12",
      },
      { tools: [mockTool] },
    );

    const result = await lambdaIamAutoRoleGuard.run(ctx);
    expect(result.kind).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Axis C — Lambda intent, operator HAS iam:CreateRole → passes
// ---------------------------------------------------------------------------

describe("Axis C — Lambda auto-role: operator has iam:CreateRole", () => {
  it("Axis C-1: guard passes when both iam:CreateRole and iam:AttachRolePolicy are allowed", async () => {
    const mockTool = buildMockIamTool({
      "iam:CreateRole": "allowed",
      "iam:AttachRolePolicy": "allowed",
    });

    const ctx = lambdaCtx({ FunctionName: "test-fn" }, { tools: [mockTool] });

    const result = await lambdaIamAutoRoleGuard.run(ctx);
    expect(result.kind).toBe("pass");
  });

  it("Axis C-2: guard passes when IAM sim returns empty EvaluationResults (no denials)", async () => {
    const mockTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ EvaluationResults: [] })),
    } as unknown as StructuredTool;

    const ctx = lambdaCtx({ FunctionName: "test-fn" }, { tools: [mockTool] });

    const result = await lambdaIamAutoRoleGuard.run(ctx);
    expect(result.kind).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Axis D — Non-Lambda resource type → guard must skip
// ---------------------------------------------------------------------------

describe("Axis D — Non-Lambda resource type: guard skips", () => {
  it("Axis D-1: guard skips for AWS::S3::Bucket", async () => {
    const mockTool = buildMockIamTool({
      "iam:CreateRole": "implicitDeny",
    });

    const ctx = lambdaCtx(
      { BucketName: "my-bucket" },
      { resourceType: RESOURCE_TYPES.S3_BUCKET, tools: [mockTool] },
    );

    const result = await lambdaIamAutoRoleGuard.run(ctx);
    expect(result.kind).toBe("skip");
    expect(mockTool.invoke).not.toHaveBeenCalled();
  });

  it("Axis D-2: guard does NOT add iam:CreateRole check for all non-Lambda supported types", async () => {
    // Variant-matrix harness: enumerate all supported types and confirm
    // the guard skips for every non-Lambda type. This is the key regression
    // proof that the check is NOT applied globally.
    const allTypes = enumerateTypes();
    const nonLambdaTypes = allTypes.filter(
      (t) => t !== RESOURCE_TYPES.LAMBDA_FUNCTION,
    );

    for (const resourceType of nonLambdaTypes) {
      const mockTool = buildMockIamTool({
        "iam:CreateRole": "implicitDeny",
      });

      const ctx = lambdaCtx(
        { Name: "test-resource" },
        { resourceType, tools: [mockTool] },
      );

      const result = await lambdaIamAutoRoleGuard.run(ctx);
      expect(result.kind).toBe("skip");
      expect(mockTool.invoke).not.toHaveBeenCalled();
    }
  });

  it("Axis D-3: guard skips for AWS::IAM::Role itself (only Lambda triggers the check)", async () => {
    const mockTool = buildMockIamTool({
      "iam:CreateRole": "implicitDeny",
    });

    const ctx = lambdaCtx(
      { RoleName: "my-role" },
      { resourceType: RESOURCE_TYPES.IAM_ROLE, tools: [mockTool] },
    );

    const result = await lambdaIamAutoRoleGuard.run(ctx);
    expect(result.kind).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation — tool/ARN unavailable
// ---------------------------------------------------------------------------

describe("Graceful degradation — guard skips when IAM check is unavailable", () => {
  it("skips when no tools are provided", async () => {
    const ctx = lambdaCtx({ FunctionName: "test-fn" }, { tools: [] });
    const result = await lambdaIamAutoRoleGuard.run(ctx);
    expect(result.kind).toBe("skip");
  });

  it("skips when the IAM simulate tool is not in the tools list", async () => {
    const nonIamTool = {
      name: "some_other_tool",
      invoke: vi.fn(),
    } as unknown as StructuredTool;

    const ctx = lambdaCtx({ FunctionName: "test-fn" }, { tools: [nonIamTool] });

    const result = await lambdaIamAutoRoleGuard.run(ctx);
    expect(result.kind).toBe("skip");
  });
});
