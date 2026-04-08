import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus, CostEstimateLabel } from "@assignee/core";
import { preflightGuardNode } from "./preflight-guard.js";
import { LambdaPricing, PricingUnit } from "../constants/pricing.js";
import { ToolName } from "../constants/tools.js";
import type { StructuredTool } from "@langchain/core/tools";
import {
  McpMocks,
  createIamMockTool,
  createMockTool,
} from "../test-fixtures/mcp-mock-responses.js";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an S3 bucket",
    runId: "run-test-456",
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "plan",
    resourceType: "AWS::S3::Bucket",
    resourceSchema: undefined,
    desiredState: undefined,
    estimatedMonthlyCost: undefined,
    requestToken: undefined,
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<typeof preflightGuardNode>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preflightGuardNode", () => {
  it("fails with actionable message when required schema fields are missing from desiredState", async () => {
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::Lambda::Function",
        resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
        desiredState: { FunctionName: "my-fn", Runtime: "nodejs22.x" }, // Role missing
      }),
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Role");
    expect(result.errorMessage).toContain("AWS::Lambda::Function");
    expect(result.preflightPassed).toBeUndefined();
  });

  it("passes preflight when all required schema fields are present", async () => {
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::Lambda::Function",
        resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
        desiredState: {
          FunctionName: "my-fn",
          Runtime: "nodejs22.x",
          // Real-shaped account ID — 112233445566 is the test user's account.
          // Must NOT use 123456789012 here: that's an AWS docs placeholder
          // account and the new detectPlaceholderArn guard will (correctly)
          // reject any desiredState containing it. See the placeholder ARN
          // rejection test further down.
          Role: "arn:aws:iam::112233445566:role/my-role",
        },
      }),
    );
    expect(result.executionStatus).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("sets preflightPassed: true", async () => {
    const result = await preflightGuardNode(makeState());
    expect(result.preflightPassed).toBe(true);
  });

  // ── Placeholder ARN rejection ─────────────────────────────────────────
  // Closes Phase 2 Lambda compound passrole bug. The LLM sometimes
  // hallucinates `arn:aws:iam::123456789012:role/...` from AWS docs
  // examples despite the schema-prompt warning. Previously this was
  // only caught by AWS itself with a confusing "Cross-account pass role
  // is not allowed" at provisioning time. Now preflight rejects it
  // with an actionable message BEFORE CloudControl sees the value.
  describe("placeholder ARN rejection", () => {
    it("rejects Lambda Role with the canonical 123456789012 placeholder account", async () => {
      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::Lambda::Function",
          resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
          desiredState: {
            FunctionName: "my-fn",
            Runtime: "nodejs22.x",
            Role: "arn:aws:iam::123456789012:role/my-role",
          },
        }),
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toContain("placeholder ARN");
      expect(result.errorMessage).toContain("123456789012");
      expect(result.errorMessage).toContain("Role");
      expect(result.errorMessage).toContain("AWS docs example");
    });

    it("rejects 111122223333 and 444455556666 (cross-account walkthrough placeholders)", async () => {
      for (const account of ["111122223333", "444455556666"]) {
        const result = await preflightGuardNode(
          makeState({
            resourceType: "AWS::Lambda::Function",
            resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
            desiredState: {
              FunctionName: "my-fn",
              Runtime: "nodejs22.x",
              Role: `arn:aws:iam::${account}:role/my-role`,
            },
          }),
        );
        expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
        expect(result.errorMessage).toContain(account);
      }
    });

    // Wave 11 P2-7: edge-finding #7 from the Wave 5-9 review noted that
    // the placeholder set omitted 222222222222, 333333333333, 555555555555,
    // and 999999999999 — all canonical AWS multi-account IAM walkthrough
    // examples that the LLM hallucinates. Pin every entry in the new
    // expanded set so removing one in a future refactor fails CI.
    it("rejects all canonical AWS docs placeholder account IDs", async () => {
      const placeholders = [
        "123456789012",
        "111122223333",
        "222222222222",
        "333333333333",
        "444455556666",
        "555555555555",
        "999999999999",
        "000000000000",
      ];
      for (const account of placeholders) {
        const result = await preflightGuardNode(
          makeState({
            resourceType: "AWS::Lambda::Function",
            resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
            desiredState: {
              FunctionName: "my-fn",
              Runtime: "nodejs22.x",
              Role: `arn:aws:iam::${account}:role/my-role`,
            },
          }),
        );
        expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
        expect(result.errorMessage).toContain(account);
      }
    });

    it("rejects 000000000000 (unit-test fixture placeholder)", async () => {
      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::Lambda::Function",
          resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
          desiredState: {
            FunctionName: "my-fn",
            Runtime: "nodejs22.x",
            Role: "arn:aws:iam::000000000000:role/my-role",
          },
        }),
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toContain("000000000000");
    });

    it("rejects placeholder ARNs buried deep in nested desiredState objects", async () => {
      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::Lambda::Function",
          resourceSchema: { required: ["FunctionName", "Runtime"] },
          desiredState: {
            FunctionName: "my-fn",
            Runtime: "nodejs22.x",
            Environment: {
              Variables: {
                FALLBACK_ROLE: "arn:aws:iam::123456789012:role/fallback",
              },
            },
          },
        }),
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toContain(
        "Environment.Variables.FALLBACK_ROLE",
      );
      expect(result.errorMessage).toContain("123456789012");
    });

    it("rejects placeholder ARNs inside an array field", async () => {
      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::Lambda::Function",
          resourceSchema: { required: ["FunctionName", "Runtime"] },
          desiredState: {
            FunctionName: "my-fn",
            Runtime: "nodejs22.x",
            Layers: [
              "arn:aws:lambda:us-east-1:112233445566:layer:ok:1",
              "arn:aws:lambda:us-east-1:123456789012:layer:bad:1",
            ],
          },
        }),
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toContain("Layers[1]");
    });

    it("does NOT reject real account IDs that happen to look similar", async () => {
      // 123456789013 is not in the placeholder set — only the canonical
      // 123456789012 is. This guards against overly-aggressive matching.
      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::Lambda::Function",
          resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
          desiredState: {
            FunctionName: "my-fn",
            Runtime: "nodejs22.x",
            Role: "arn:aws:iam::123456789013:role/my-role",
          },
        }),
      );
      expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
    });

    it("does NOT reject free-text fields that happen to contain 123456789012 substring", async () => {
      // Description field is not an ARN, so the regex anchored on ^arn:
      // must not match. Guards against false positives on user-supplied
      // descriptions that reference the docs example account.
      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::Lambda::Function",
          resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
          desiredState: {
            FunctionName: "my-fn",
            Runtime: "nodejs22.x",
            Role: "arn:aws:iam::112233445566:role/my-role",
            Description:
              "This function handles events from account 123456789012 (see docs).",
          },
        }),
      );
      expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
    });

    // Wave 11 P2-7: edge-finding #7 also called out "no cycle guard on
    // the recursive walker". CCAPI desired state shouldn't contain
    // cyclic structures, but a pathological / hostile input could blow
    // the stack. The walker now caps at 32 levels and returns undefined
    // (= no placeholder found, fall through to normal preflight) when
    // depth exceeds the cap. This test builds a 50-level nested
    // structure and verifies the walker doesn't throw.
    it("does NOT throw on pathologically deep desiredState (depth guard)", async () => {
      // Build a 50-level deep object: { a: { a: { a: ... { Role: "real-arn" } } } }
      let nested: Record<string, unknown> = {
        Role: "arn:aws:iam::112233445566:role/leaf",
      };
      for (let i = 0; i < 50; i++) {
        nested = { a: nested };
      }
      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::Lambda::Function",
          resourceSchema: { required: ["FunctionName", "Runtime"] },
          desiredState: {
            FunctionName: "my-fn",
            Runtime: "nodejs22.x",
            Deeply: nested,
          },
        }),
      );
      // Walker bails at depth 32 — leaf is unreachable but no exception.
      // Preflight may fail for OTHER reasons (no Role at top level), but
      // it must NOT throw. Wave 17: strengthened — assert the result
      // is a real partial-state object, not just any non-undefined
      // value. The previous `toBeDefined()` would have passed even
      // for a Promise that hadn't resolved.
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    });
  });

  // Wave 19 Bug #8: the LLM was observed inventing AWS managed policy ARNs
  // (e.g. AmazonEC2RoleforAWSServiceAccess, AmazonEC2RoleforAWSCodeDeployRole)
  // that don't exist. CCAPI 404s with a confusing
  // `Scope ARN: ... does not exist or is not attachable` error. The
  // preflight verifier added in Wave 19 calls iam:GetPolicy against each
  // ManagedPolicyArn before CCAPI sees it.
  describe("Wave 19 Bug #8: ManagedPolicyArns existence verification", () => {
    // Mock @aws-sdk/client-iam — preflight-guard.ts dynamic-imports the SDK
    // so the mock has to be hoisted alongside it. vi.hoisted lets the
    // factory closure see sendMock without tripping vitest's hoisting.
    const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
    vi.mock("@aws-sdk/client-iam", () => {
      class GetPolicyCommand {
        public input: { PolicyArn: string };
        constructor(input: { PolicyArn: string }) {
          this.input = input;
        }
      }
      class IAMClient {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send(cmd: any): Promise<unknown> {
          return sendMock(cmd);
        }
      }
      return { IAMClient, GetPolicyCommand };
    });

    beforeEach(() => {
      sendMock.mockReset();
    });

    it("rejects a hallucinated ARN with NoSuchEntityException (real reproducer)", async () => {
      // The actual ARN observed in the 2026-04-08 live smoke logs.
      const hallucinated =
        "arn:aws:iam::aws:policy/service-role/AmazonEC2RoleforAWSServiceAccess";
      sendMock.mockImplementation(() => {
        const err = new Error("Policy not found") as Error & { name: string };
        err.name = "NoSuchEntityException";
        return Promise.reject(err);
      });

      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          resourceSchema: {
            required: ["AssumeRolePolicyDocument"],
          },
          desiredState: {
            RoleName: "smoke-test-bug2",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
            ManagedPolicyArns: [hallucinated],
          },
        }),
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toContain("ManagedPolicyArns");
      expect(result.errorMessage).toContain(hallucinated);
      expect(result.errorMessage).toContain("does not exist in IAM");
      expect(result.errorMessage).toContain("hallucinated");
      // Must include actionable remediation (the verified ARN list pointer)
      expect(result.errorMessage).toContain("verified");
    });

    it("passes preflight when every ManagedPolicyArn exists in IAM", async () => {
      const realArns = [
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ];
      sendMock.mockResolvedValue({
        Policy: { Arn: "ok", PolicyName: "ok" },
      });

      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          resourceSchema: { required: ["AssumeRolePolicyDocument"] },
          desiredState: {
            RoleName: "smoke-test-real",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
            ManagedPolicyArns: realArns,
          },
        }),
      );

      // Verifier passed — preflight should not fail at THIS step. (The
      // overall preflight may still pass or block on BP findings, but the
      // failure mode we're guarding against is the verifier killing a
      // real ARN.)
      expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
      // sendMock called once per ARN
      expect(sendMock).toHaveBeenCalledTimes(2);
    });

    it("fails OPEN (no block) when iam:GetPolicy itself returns AccessDenied", async () => {
      // Operator role doesn't have iam:GetPolicy yet — per Wave 19 fix
      // path, the verifier should NOT block in this case (CCAPI will
      // still reject bad ARNs at provision time, just less actionably).
      // Blocking on a permission gap that's separate from the bug we're
      // trying to catch would break every existing user's IAM Role flow.
      sendMock.mockImplementation(() => {
        const err = new Error(
          "User: arn:aws:iam::112233445566:user/assignee-operator is not authorized to perform: iam:GetPolicy",
        ) as Error & { name: string };
        err.name = "AccessDenied";
        return Promise.reject(err);
      });

      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          resourceSchema: { required: ["AssumeRolePolicyDocument"] },
          desiredState: {
            RoleName: "fails-open",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
            ManagedPolicyArns: [
              "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
            ],
          },
        }),
      );

      // Must NOT fail because of the AccessDenied — fail-open contract
      expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
    });

    it("does not run verification at all when ManagedPolicyArns is absent", async () => {
      // Common case: user creates an IAM Role with no managed policies
      // attached (just a trust policy). No iam:GetPolicy calls should
      // fire because there's nothing to verify.
      sendMock.mockResolvedValue({});

      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          resourceSchema: { required: ["AssumeRolePolicyDocument"] },
          desiredState: {
            RoleName: "no-managed-policies",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
          },
        }),
      );

      expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("does not run verification for non-IAM-Role resource types", async () => {
      // Verifier is scoped to AWS::IAM::Role only — Lambda, EC2, etc.
      // may also have ManagedPolicyArns-shaped fields but those aren't
      // the bug we're catching.
      sendMock.mockResolvedValue({});

      const result = await preflightGuardNode(
        makeState({
          resourceType: "AWS::Lambda::Function",
          resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
          desiredState: {
            FunctionName: "my-fn",
            Runtime: "nodejs22.x",
            Role: "arn:aws:iam::112233445566:role/exec-role",
          },
        }),
      );

      expect(sendMock).not.toHaveBeenCalled();
      expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
    });
  });

  it("returns Free for IAM::Role without calling pricing tool", async () => {
    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn(),
    } as unknown as StructuredTool;
    const result = await preflightGuardNode(
      makeState({ resourceType: "AWS::IAM::Role" }),
      [pricingTool],
    );
    expect(result.estimatedMonthlyCost).toBe(CostEstimateLabel.FREE);
    expect(pricingTool.invoke).not.toHaveBeenCalled();
  });

  it("returns N/A when no pricing tool is available", async () => {
    const result = await preflightGuardNode(makeState(), []);
    expect(result.estimatedMonthlyCost).toBe(CostEstimateLabel.NA);
  });

  // ── P0-2: free-tier headline cost regression ──────────────────────────
  // SSM Standard-tier parameters are always free, but the headline used
  // to display "N/A" because:
  //   1. ssmPricingStrategy.estimateLocal() returned N/A unconditionally,
  //      and
  //   2. when the SSM decomposer returned an empty line-item list (its
  //      signal for "Standard tier has no billable components"),
  //      preflight-guard left the headline as N/A instead of "Free".
  // Fix #1 lives in packages/core/src/pricing/strategies/ssm.ts; fix #2
  // is the safety net below in preflight-guard.ts. This test asserts the
  // user-visible behaviour: SSM Standard parameters show "Free".
  it("returns FREE for SSM Standard-tier parameters (P0-2)", async () => {
    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn(),
    } as unknown as StructuredTool;
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::SSM::Parameter",
        desiredState: {
          Name: "/app/db/host",
          Type: "String",
          Value: "db.internal.example.com",
        },
      }),
      [pricingTool],
    );
    expect(result.estimatedMonthlyCost).toBe(CostEstimateLabel.FREE);
    // Standard tier must NOT call the pricing API.
    expect(pricingTool.invoke).not.toHaveBeenCalled();
  });

  it("returns FREE when SSM tier is omitted (defaults to Standard)", async () => {
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::SSM::Parameter",
        desiredState: {
          Name: "/app/feature-flag",
          Type: "String",
          Value: "on",
        },
      }),
      [],
    );
    expect(result.estimatedMonthlyCost).toBe(CostEstimateLabel.FREE);
  });

  it("skips when executionStatus is already FAILED", async () => {
    const result = await preflightGuardNode(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );
    expect(result).toEqual({});
  });

  it("returns a fallback estimate on pricing timeout (non-blocking)", async () => {
    // Use fake timers so the SUT's PRICING_TIMEOUT_MS race resolves
    // without waiting on real wall-clock.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      // Pin the pricing tool to NEVER resolve so the main pricing query
      // (and every decomposer line item that doesn't already hit a disk
      // cache) flows through the SUT's withTimeout path.
      // Plain function (not vi.fn) so vitest mockReset can't strip the body.
      const slowTool = {
        name: "get_pricing",
        invoke: () => new Promise<never>(() => {}),
      } as unknown as StructuredTool;

      const promise = preflightGuardNode(makeState(), [slowTool]);
      // Advance well past the SUT's 3s PRICING_TIMEOUT_MS so withTimeout fires.
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await promise;

      // Key invariant: pricing timeout MUST be non-blocking — preflight
      // still passes regardless of which fallback path the cost takes.
      expect(result.preflightPassed).toBe(true);
      // The cost MUST be a defined string — either CostEstimateLabel.NA when
      // every line item hangs, or a per-unit local estimate (e.g.
      // "$0.0230/GB-mo" for S3) drawn from the local estimator. We accept
      // both because the price-cache may legitimately serve a fresh entry
      // from a prior plan.
      expect(typeof result.estimatedMonthlyCost).toBe("string");
      expect(
        result.estimatedMonthlyCost === CostEstimateLabel.NA ||
          (result.estimatedMonthlyCost as string).length > 0,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("computes Lambda estimate from default memory without calling pricing API", async () => {
    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn(),
    } as unknown as StructuredTool;
    const result = await preflightGuardNode(
      makeState({ resourceType: "AWS::Lambda::Function" }),
      [pricingTool],
    );
    // Default 128MB: duration cost = 1M × 0.1s × (128/1024) × $0.0000166667 = $0.208333
    // Total = $0.20 (requests) + $0.208333 (duration) ≈ $0.41
    expect(result.estimatedMonthlyCost).toMatch(/^~\$0\.41\/million req/);
    expect(result.estimatedMonthlyCost).toContain(
      `${LambdaPricing.DEFAULT_MEMORY_MB}MB`,
    );
    expect(result.preflightPassed).toBe(true);
    expect(pricingTool.invoke).not.toHaveBeenCalled();
  });

  it("computes Lambda estimate using MemorySize from desiredState", async () => {
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::Lambda::Function",
        desiredState: { MemorySize: 512 },
      }),
    );
    // 512MB: duration cost = 1M × 0.1s × (512/1024) × $0.0000166667 = $0.833335
    // Total = $0.20 + $0.833335 ≈ $1.03
    expect(result.estimatedMonthlyCost).toMatch(/^~\$1\.03\/million req/);
    expect(result.estimatedMonthlyCost).toContain("512MB");
  });

  // ── Story 12.3: BP findings integration ─────────────────────────────────────

  it("sets preflightPassed = true when CRITICAL severity but blocking: false", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpFindings: [
          {
            practiceId: "BP-S3-002",
            title: "Enable S3 Default Encryption",
            severity: "CRITICAL",
            category: "security",
            message: "S3 bucket should have default encryption",
            blocking: false,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(true);
  });

  it("sets preflightPassed = false when blocking: true finding is present", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(false);
  });

  it("keeps preflightPassed = true when only MEDIUM non-blocking BP findings exist", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpFindings: [
          {
            practiceId: "BP-S3-005",
            title: "Enable S3 Bucket Versioning",
            severity: "MEDIUM",
            category: "reliability",
            message: "S3 bucket versioning should be enabled",
            blocking: false,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(true);
  });

  it("keeps preflightPassed = true when bpFindings is empty", async () => {
    const result = await preflightGuardNode(makeState({ bpFindings: [] }));
    expect(result.preflightPassed).toBe(true);
  });

  // ── Story 41.2: BP enforcement levels ────────────────────────────────────────

  it("enforcement=enforce + --yes + blocking → still blocked (preflightPassed=false)", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpEnforcementLevel: "enforce",
        autoApprove: true,
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(false);
  });

  it("enforcement=enforce + noWizard + blocking → still blocked (preflightPassed=false)", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpEnforcementLevel: "enforce",
        noWizard: true,
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(false);
  });

  it("enforcement=warn + blocking findings → preflightPassed=true (advisory only)", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpEnforcementLevel: "warn",
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(true);
  });

  it("enforcement=skip + blocking findings → preflightPassed=true (no evaluation)", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpEnforcementLevel: "skip",
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(true);
  });

  it("parses real get_pricing MCP response and returns first-tier price", async () => {
    // Real response shape returned by awslabs.aws-pricing-mcp-server get_pricing tool.
    // Captured from a live call: AmazonS3, region us-east-1, filtered to TimedStorage-ByteHrs.
    const realMcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "success",
        service_name: "AmazonS3",
        data: [
          {
            product: {
              productFamily: "Storage",
              attributes: {
                usagetype: "TimedStorage-ByteHrs",
                regionCode: "us-east-1",
              },
              sku: "4NA7Y494T4JAZ9A",
            },
            terms: {
              OnDemand: {
                "4NA7Y494T4JAZ9A.JRTCKXETXF": {
                  priceDimensions: {
                    "4NA7Y494T4JAZ9A.JRTCKXETXF.6YS6EN2CT7": {
                      beginRange: "0",
                      endRange: "51200",
                      pricePerUnit: { USD: "0.0230000000" },
                      description:
                        "$0.023 per GB - first 50 TB / month of storage used",
                      unit: "GB-Mo",
                    },
                    "4NA7Y494T4JAZ9A.JRTCKXETXF.SW9GXFZZ3P": {
                      beginRange: "51200",
                      endRange: "512000",
                      pricePerUnit: { USD: "0.0220000000" },
                      description:
                        "$0.022 per GB - next 450 TB / month of storage used",
                      unit: "GB-Mo",
                    },
                    "4NA7Y494T4JAZ9A.JRTCKXETXF.7YB3XKGZP3": {
                      beginRange: "512000",
                      endRange: "Inf",
                      pricePerUnit: { USD: "0.0210000000" },
                      description:
                        "$0.021 per GB - storage used / month over 500 TB",
                      unit: "GB-Mo",
                    },
                  },
                },
              },
            },
          },
        ],
      }),
    };

    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn().mockResolvedValue(realMcpResponse),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [pricingTool]);

    expect(result.estimatedMonthlyCost).toBe(`$0.0230${PricingUnit.GB_MONTH}`);
    expect(result.preflightPassed).toBe(true);
    expect(pricingTool.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ service_code: "AmazonS3" }),
    );
  });
});

// ── Story 19.1: IAM permission pre-check ──────────────────────────────────────
// Uses captured responses from iam-mcp-server via McpMocks.iam.*

describe("preflightGuardNode — IAM permission check (Story 19.1)", () => {
  it("passes when all actions are allowed — provisioning continues", async () => {
    const iamTool = createIamMockTool(McpMocks.iam.s3BucketAllowed.success);

    const result = await preflightGuardNode(makeState(), [iamTool]);

    expect(result.executionStatus).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("fails with specific missing actions — returns FAILED with descriptive message", async () => {
    const iamTool = createIamMockTool(
      McpMocks.iam.ec2InstancePartialDeny.success,
    );

    const result = await preflightGuardNode(makeState(), [iamTool]);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Insufficient IAM permissions");
    expect(result.errorMessage).toContain("ec2:RunInstances");
    expect(result.errorMessage).toContain("iam:PassRole");
    expect(result.errorMessage).toContain(
      "Ask your admin to grant these permissions or use a different profile",
    );
  });

  it("skips check when IAM tool is not found — provisioning continues", async () => {
    const otherTool = createMockTool("some_other_tool", null);

    const result = await preflightGuardNode(makeState(), [otherTool]);

    expect(result.executionStatus).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("skips check gracefully when IAM tool invocation throws — provisioning continues", async () => {
    const iamTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi.fn().mockRejectedValue(new Error("MCP server crashed")),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [iamTool]);

    expect(result.executionStatus).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("skips check gracefully when IAM tool invocation times out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const iamTool = {
        name: ToolName.SIMULATE_PRINCIPAL_POLICY,
        invoke: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
      } as unknown as StructuredTool;

      // withTimeout returns null on timeout, so IAM check is silently skipped
      const promise = preflightGuardNode(makeState(), [iamTool]);
      // Advance past the SUT's PRICING_TIMEOUT_MS (3s) used as the IAM timeout.
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result.executionStatus).toBeUndefined();
      expect(result.preflightPassed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips check when no tools are provided", async () => {
    const result = await preflightGuardNode(makeState());

    expect(result.executionStatus).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("skips check when resourceType is empty", async () => {
    const iamTool = createIamMockTool();

    const result = await preflightGuardNode(makeState({ resourceType: "" }), [
      iamTool,
    ]);

    expect(result.executionStatus).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
    // IAM tool should not have been called
    expect(iamTool.invoke).not.toHaveBeenCalled();
  });
});

// ── Story 9.10: Parallel pricing + IAM fan-out ──────────────────────────────

describe("preflightGuardNode — parallel pricing + IAM fan-out (Story 9.10)", () => {
  it("pricing and IAM run concurrently (overlapping execution)", async () => {
    const executionLog: Array<{
      task: string;
      event: "start" | "end";
      time: number;
    }> = [];

    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn(async () => {
        executionLog.push({
          task: "pricing",
          event: "start",
          time: Date.now(),
        });
        await new Promise((r) => setTimeout(r, 50));
        executionLog.push({ task: "pricing", event: "end", time: Date.now() });
        return {
          type: "text",
          text: JSON.stringify({
            status: "success",
            data: [
              {
                terms: {
                  OnDemand: {
                    "X.Y": {
                      priceDimensions: {
                        "X.Y.Z": {
                          beginRange: "0",
                          endRange: "Inf",
                          pricePerUnit: { USD: "0.0230000000" },
                          unit: "GB-Mo",
                        },
                      },
                    },
                  },
                },
              },
            ],
          }),
        };
      }),
    } as unknown as StructuredTool;

    const iamTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi.fn(async () => {
        executionLog.push({ task: "iam", event: "start", time: Date.now() });
        await new Promise((r) => setTimeout(r, 50));
        executionLog.push({ task: "iam", event: "end", time: Date.now() });
        return {
          type: "text",
          text: JSON.stringify({
            EvaluationResults: [
              { EvalActionName: "s3:CreateBucket", EvalDecision: "allowed" },
            ],
          }),
        };
      }),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [
      pricingTool,
      iamTool,
    ]);

    // Both should have been called
    expect(pricingTool.invoke).toHaveBeenCalled();
    expect(iamTool.invoke).toHaveBeenCalled();
    expect(result.preflightPassed).toBe(true);

    // Verify overlapping execution: IAM should start before pricing ends
    const pricingStart = executionLog.find(
      (e) => e.task === "pricing" && e.event === "start",
    );
    const iamStart = executionLog.find(
      (e) => e.task === "iam" && e.event === "start",
    );
    const pricingEnd = executionLog.find(
      (e) => e.task === "pricing" && e.event === "end",
    );
    // Wave 17: strengthened — assert each timing entry is a real
    // object with a numeric `time` field. The previous `toBeDefined()`
    // would have passed for any non-undefined `find()` result, but the
    // subsequent `iamStart!.time` chain requires the entries to be
    // shape-correct objects. Making the shape check explicit means a
    // regression that changes the executionLog event format fails
    // here instead of producing a confusing arithmetic error below.
    expect(typeof pricingStart?.time).toBe("number");
    expect(typeof iamStart?.time).toBe("number");
    expect(typeof pricingEnd?.time).toBe("number");
    // IAM should start before pricing ends (proving concurrency)
    expect(iamStart!.time).toBeLessThanOrEqual(pricingEnd!.time);
  });

  it("graceful degradation: pricing failure does not block IAM check", async () => {
    const pricingTool = {
      name: "get_pricing",
      invoke: vi
        .fn()
        .mockRejectedValue(new Error("MCP pricing server crashed")),
    } as unknown as StructuredTool;

    const iamTool = createIamMockTool(McpMocks.iam.s3BucketAllowed.success);

    const result = await preflightGuardNode(makeState(), [
      pricingTool,
      iamTool,
    ]);

    // IAM should still pass despite pricing failure
    expect(result.preflightPassed).toBe(true);
    expect(result.executionStatus).toBeUndefined();
    // Cost should fall back to local estimate
    // Wave 17: strengthened — graceful-degradation paths must still
    // produce a real cost STRING (typically the local-estimate fallback
    // or "N/A"), not just any defined value.
    expect(typeof result.estimatedMonthlyCost).toBe("string");
    expect(result.estimatedMonthlyCost!.length).toBeGreaterThan(0);
  });

  it("graceful degradation: IAM failure does not block pricing", async () => {
    const realMcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "success",
        data: [
          {
            terms: {
              OnDemand: {
                "X.Y": {
                  priceDimensions: {
                    "X.Y.Z": {
                      beginRange: "0",
                      endRange: "Inf",
                      pricePerUnit: { USD: "0.0230000000" },
                      unit: "GB-Mo",
                    },
                  },
                },
              },
            },
          },
        ],
      }),
    };

    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn().mockResolvedValue(realMcpResponse),
    } as unknown as StructuredTool;

    const iamTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi.fn().mockRejectedValue(new Error("IAM MCP crashed")),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [
      pricingTool,
      iamTool,
    ]);

    // Pricing should succeed, IAM should degrade gracefully
    // Wave 17: strengthened — graceful-degradation paths must still
    // produce a real cost STRING (typically the local-estimate fallback
    // or "N/A"), not just any defined value.
    expect(typeof result.estimatedMonthlyCost).toBe("string");
    expect(result.estimatedMonthlyCost!.length).toBeGreaterThan(0);
    expect(result.preflightPassed).toBe(true);
    expect(result.executionStatus).toBeUndefined();
  });

  it("both pricing and IAM fail: graceful degradation for both", async () => {
    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn().mockRejectedValue(new Error("pricing down")),
    } as unknown as StructuredTool;

    const iamTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi.fn().mockRejectedValue(new Error("iam down")),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [
      pricingTool,
      iamTool,
    ]);

    // Both degrade gracefully — preflight still passes
    expect(result.preflightPassed).toBe(true);
    // Wave 17: strengthened — graceful-degradation paths must still
    // produce a real cost STRING (typically the local-estimate fallback
    // or "N/A"), not just any defined value.
    expect(typeof result.estimatedMonthlyCost).toBe("string");
    expect(result.estimatedMonthlyCost!.length).toBeGreaterThan(0);
    expect(result.executionStatus).toBeUndefined();
  });

  // ── M-R3: bounds check must reject negative currentResourceIndex ──────────
  // Previously the guard was `currentResourceIndex !== undefined &&
  // currentResourceIndex < state.resourceQueue.length`, which permitted
  // negative indices to slip through. `state.resourceQueue[-1]!` returns
  // undefined → NPE on `currentResource.resourceId` aborting preflight for
  // the entire compound resource.
  it("does not NPE when currentResourceIndex is -1 (M-R3 bounds check)", async () => {
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::S3::Bucket",
        resourceSchema: { required: ["BucketName"] },
        desiredState: { BucketName: "my-bucket" },
        // Realistic compound-resource shape, but the index has somehow
        // become -1 (e.g. from a failed dispatcher transition).
        resourcePattern: {
          name: "static-website",
          description: "S3 + CloudFront",
        },
        resourceQueue: [
          {
            resourceId: "bucket-1",
            resourceType: "AWS::S3::Bucket",
            displayName: "Static site bucket",
          },
        ],
        currentResourceIndex: -1,
      }),
    );
    // Must not throw, must not record per-resource cost for invalid index.
    expect(result.executionStatus).toBeUndefined();
    expect(result.perResourceCosts).toBeUndefined();
  });
});
