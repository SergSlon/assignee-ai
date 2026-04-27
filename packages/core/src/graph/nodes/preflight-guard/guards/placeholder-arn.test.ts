/**
 * Unit tests for `placeholder-arn.ts` preflight guard.
 *
 * The companion stripper in `plan-generator/placeholders.ts` silently
 * drops LLM-emitted placeholder ARNs first. This guard is the second
 * line of defence: it catches USER-supplied placeholder ARNs (e.g.
 * values passed via `--set PerformanceInsightsKMSKeyId=arn:aws:kms:...`
 * or values that slip past the stripper via unexpected shapes).
 *
 * Epic 92 Wave 1 regression: stripper was extended to walk scalar
 * fields recursively (C-01/C-02). These tests confirm the guard still
 * produces the exact actionable error message when invoked directly
 * on desiredState containing a scalar placeholder ARN — critical per
 * `feedback_placeholder_arn_preflight_guard`.
 */
import { describe, it, expect } from "vitest";
import {
  detectPlaceholderArn,
  placeholderArnGuard,
} from "./placeholder-arn.js";
import type { GuardContext } from "../types.js";

// Helper: build a minimally-typed GuardContext for the guard under test.
// The guard only reads `ctx.desiredState`, so we stub the rest with a
// plausible AgentState shape (matching makeState in preflight-guard.test.ts).
function ctx(desiredState: Record<string, unknown>): GuardContext {
  return {
    state: {
      userIntent: "",
      runId: "test",
      executionMode: "plan",
      resourceType: "AWS::IAM::Role",
      resourceSchema: undefined,
      desiredState,
      messages: [],
      preflightPassed: false,
      preflightErrors: [],
      preflightMode: "local",
    } as unknown as GuardContext["state"],
    desiredState,
  };
}

describe("detectPlaceholderArn (top-level arrays)", () => {
  it("flags IAM role placeholder in scalar field — the classic invariant", () => {
    const err = detectPlaceholderArn({
      Role: "arn:aws:iam::123456789012:role/my-role",
    });
    expect(err).toBeDefined();
    expect(err).toContain('Field "Role"');
    expect(err).toContain("123456789012");
    expect(err).toContain("--set Role=arn:aws:...");
  });

  it("returns undefined for real-account scalars", () => {
    expect(
      detectPlaceholderArn({
        Role: "arn:aws:iam::210987654321:role/assignee-operator",
      }),
    ).toBeUndefined();
  });

  it("flags placeholder inside an array", () => {
    const err = detectPlaceholderArn({
      AlarmActions: [
        "arn:aws:sns:us-east-1:210987654321:real",
        "arn:aws:sns:us-east-1:111122223333:fake",
      ],
    });
    expect(err).toBeDefined();
    expect(err).toContain("111122223333");
  });

  it("flags placeholder nested in an object (Epic 92 C-01 RDS scenario)", () => {
    const err = detectPlaceholderArn({
      DBInstanceIdentifier: "prod-postgres",
      PerformanceInsightsKMSKeyId:
        "arn:aws:kms:us-west-2:123456789012:key/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    });
    expect(err).toBeDefined();
    expect(err).toContain('Field "PerformanceInsightsKMSKeyId"');
    expect(err).toContain("123456789012");
  });

  it("flags placeholder across partitions (GovCloud, China)", () => {
    expect(
      detectPlaceholderArn({
        Key: "arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/x",
      }),
    ).toBeDefined();
    expect(
      detectPlaceholderArn({
        Key: "arn:aws-cn:kms:cn-north-1:000000000000:key/x",
      }),
    ).toBeDefined();
  });

  it("is depth-capped (does not throw on deeply nested structures)", () => {
    const root: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < 40; i++) {
      const next: Record<string, unknown> = {};
      cursor["next"] = next;
      cursor = next;
    }
    cursor["Arn"] = "arn:aws:kms:us-east-1:123456789012:key/too-deep";
    expect(() => detectPlaceholderArn(root)).not.toThrow();
  });
});

describe("placeholderArnGuard.run", () => {
  it("passes when desiredState has no ARNs at all", async () => {
    const result = await placeholderArnGuard.run(ctx({ Name: "my-bucket" }));
    expect(result.kind).toBe("pass");
  });

  it("passes when ARNs use real account IDs", async () => {
    const result = await placeholderArnGuard.run(
      ctx({
        Role: "arn:aws:iam::210987654321:role/assignee-operator",
      }),
    );
    expect(result.kind).toBe("pass");
  });

  it("fails with actionable error on scalar placeholder (C-01 invariant)", async () => {
    const result = await placeholderArnGuard.run(
      ctx({
        PerformanceInsightsKMSKeyId:
          "arn:aws:kms:us-west-2:123456789012:key/xxx",
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain("PerformanceInsightsKMSKeyId");
      expect(result.errorMessage).toContain("--set");
    }
  });

  it("short-circuits on first placeholder (deterministic error ordering)", async () => {
    const result = await placeholderArnGuard.run(
      ctx({
        AAA_First: "arn:aws:sns:us-east-1:123456789012:first",
        ZZZ_Second: "arn:aws:sns:us-east-1:111122223333:second",
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      // Object.entries order follows insertion; AAA_First was inserted
      // first so it is hit first.
      expect(result.errorMessage).toContain("AAA_First");
    }
  });
});
