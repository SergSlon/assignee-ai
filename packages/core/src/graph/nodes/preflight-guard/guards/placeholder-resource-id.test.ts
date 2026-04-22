/**
 * Unit tests for `placeholder-resource-id.ts` preflight guard.
 *
 * Epic 92 Wave 1 findings B-06, B-08 (EC2-ID half), C-14:
 *   - Bare Subnet / RouteTable / Route / SubnetRouteTableAssociation
 *     plans inject hallucinated `vpc-0abc1234def567890`, `rtb-12345678`,
 *     `igw-0abc1234def567890`.
 *   - Load Balancer plan references `subnet-abc12345`, `subnet-def67890`,
 *     `sg-0123456789abcdef0`.
 *   - `sg-12345678` / `subnet-12345678` docs-placeholders pass preflight
 *     unchallenged.
 *
 * All of the above trip the placeholder-resource-id guard; real
 * customer IDs (hex-random suffixes) pass cleanly.
 */
import { describe, it, expect } from "vitest";
import {
  detectPlaceholderResourceId,
  isPlaceholderResourceId,
  PLACEHOLDER_RESOURCE_ID_PREFIXES,
  PLACEHOLDER_RESOURCE_ID_REGEX,
  placeholderResourceIdGuard,
} from "./placeholder-resource-id.js";
import type { GuardContext } from "../types.js";

function ctx(desiredState: Record<string, unknown>): GuardContext {
  return {
    state: {
      userIntent: "",
      runId: "test",
      executionMode: "plan",
      resourceType: "AWS::EC2::Subnet",
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

describe("PLACEHOLDER_RESOURCE_ID_PREFIXES", () => {
  it("covers the canonical EC2 resource-ID families", () => {
    for (const p of [
      "vpc",
      "subnet",
      "rtb",
      "igw",
      "sg",
      "nat",
      "eni",
      "eip",
      "i",
    ]) {
      expect(PLACEHOLDER_RESOURCE_ID_PREFIXES).toContain(p);
    }
  });
});

describe("isPlaceholderResourceId", () => {
  it("true for Epic 92 finding samples (B-06)", () => {
    // From epic-92-findings-b.md B-06
    expect(isPlaceholderResourceId("vpc-0abc1234def567890")).toBe(true);
    expect(isPlaceholderResourceId("vpc-12345678")).toBe(true);
    expect(isPlaceholderResourceId("rtb-0abc1234def567890")).toBe(true);
    expect(isPlaceholderResourceId("rtb-12345678")).toBe(true);
    expect(isPlaceholderResourceId("igw-0abc1234def567890")).toBe(true);
    expect(isPlaceholderResourceId("subnet-12345678")).toBe(true);
  });

  it("true for Epic 92 finding samples (B-08)", () => {
    expect(isPlaceholderResourceId("subnet-abc12345")).toBe(true);
    expect(isPlaceholderResourceId("subnet-def67890")).toBe(true);
    expect(isPlaceholderResourceId("sg-0123456789abcdef0")).toBe(true);
  });

  it("true for Epic 92 finding samples (C-14 / M1)", () => {
    expect(isPlaceholderResourceId("sg-12345678")).toBe(true);
    expect(isPlaceholderResourceId("subnet-12345678")).toBe(true);
    expect(isPlaceholderResourceId("subnet-87654321")).toBe(true);
    expect(isPlaceholderResourceId("vpc-12345678")).toBe(true);
    expect(isPlaceholderResourceId("i-12345678")).toBe(true);
  });

  it("true for all-zero / all-0a stub IDs (≥8 chars)", () => {
    expect(isPlaceholderResourceId("vpc-00000000")).toBe(true);
    expect(isPlaceholderResourceId("subnet-0a0a0a0a")).toBe(true);
    expect(isPlaceholderResourceId("sg-0000000000000000")).toBe(true);
  });

  it("true for Epic 94 finding B-04 angle-bracket template tokens", () => {
    // The original B-04 finding: `"Create a NAT gateway in subnet-<hex>"`.
    // Before N6 the angle-bracket suffix slipped past the placeholder
    // regex and CloudControl later rejected the plan as malformed.
    expect(isPlaceholderResourceId("subnet-<hex>")).toBe(true);
    expect(isPlaceholderResourceId("vpc-<id>")).toBe(true);
    expect(isPlaceholderResourceId("rtb-<rtb-id>")).toBe(true);
    expect(isPlaceholderResourceId("igw-<YOUR-ID>")).toBe(true);
    expect(isPlaceholderResourceId("sg-<replace-me>")).toBe(true);
    expect(isPlaceholderResourceId("i-<instance-id>")).toBe(true);
    // Empty brackets are still a placeholder — the LLM emitted a stub
    // with no content inside the angle wrapper.
    expect(isPlaceholderResourceId("subnet-<>")).toBe(true);
  });

  it("false for realistic customer resource IDs (hex-random suffix)", () => {
    // Real AWS IDs are drawn from full hex entropy — not the curated
    // placeholder suffix list, and they mix digits with letters
    // beyond [0a].
    expect(isPlaceholderResourceId("vpc-0a1b2c3d4e5f67890")).toBe(false);
    expect(isPlaceholderResourceId("subnet-0f2e8c9d1a3b4567")).toBe(false);
    expect(isPlaceholderResourceId("sg-0f9e8d7c6b5a4321")).toBe(false);
    expect(isPlaceholderResourceId("i-0abcd1234ef567891")).toBe(false);
  });

  it("false for non-ID strings, numbers, and null", () => {
    expect(isPlaceholderResourceId("my-vpc")).toBe(false);
    expect(
      isPlaceholderResourceId("arn:aws:ec2:us-east-1::vpc/vpc-12345678"),
    ).toBe(false); // ARN-shaped — placeholder-arn.ts territory
    expect(isPlaceholderResourceId("")).toBe(false);
    expect(isPlaceholderResourceId(42)).toBe(false);
    expect(isPlaceholderResourceId(undefined)).toBe(false);
    expect(isPlaceholderResourceId(null)).toBe(false);
  });

  it("regex is case-insensitive (tolerant of accidental uppercase)", () => {
    expect(PLACEHOLDER_RESOURCE_ID_REGEX.test("VPC-12345678")).toBe(true);
    expect(PLACEHOLDER_RESOURCE_ID_REGEX.test("SG-ABC12345")).toBe(true);
  });
});

describe("detectPlaceholderResourceId", () => {
  it("finds a scalar placeholder VpcId (B-06)", () => {
    const hit = detectPlaceholderResourceId({
      VpcId: "vpc-0abc1234def567890",
      CidrBlock: "10.0.0.0/24",
    });
    expect(hit).toEqual({
      field: "VpcId",
      value: "vpc-0abc1234def567890",
    });
  });

  it("finds a placeholder inside an array (B-08 Subnets list)", () => {
    const hit = detectPlaceholderResourceId({
      Subnets: ["subnet-0a1b2c3d4e5f67890", "subnet-abc12345"],
    });
    expect(hit).toBeDefined();
    expect(hit!.field).toBe("Subnets[1]");
    expect(hit!.value).toBe("subnet-abc12345");
  });

  it("finds a nested placeholder in SecurityGroupIds (LB scenario)", () => {
    const hit = detectPlaceholderResourceId({
      LoadBalancerName: "my-alb",
      SecurityGroups: ["sg-0123456789abcdef0"],
    });
    expect(hit).toBeDefined();
    expect(hit!.field).toBe("SecurityGroups[0]");
  });

  it("returns undefined when every ID is a real customer resource", () => {
    const state = {
      VpcId: "vpc-0a1b2c3d4e5f67890",
      SubnetIds: ["subnet-0f9e8d7c6b5a4321", "subnet-0a1b2c3d4e5f6789"],
      SecurityGroupIds: ["sg-0f9e8d7c6b5a4321"],
    };
    expect(detectPlaceholderResourceId(state)).toBeUndefined();
  });

  it("returns undefined when desiredState has no EC2 IDs at all", () => {
    expect(
      detectPlaceholderResourceId({ Name: "my-bucket", Count: 42 }),
    ).toBeUndefined();
  });

  it("is depth-capped (does not throw on deep nesting)", () => {
    const root: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < 40; i++) {
      const next: Record<string, unknown> = {};
      cursor["next"] = next;
      cursor = next;
    }
    cursor["VpcId"] = "vpc-12345678";
    expect(() => detectPlaceholderResourceId(root)).not.toThrow();
  });
});

describe("placeholderResourceIdGuard.run", () => {
  it("passes when desiredState has no placeholder IDs", async () => {
    const result = await placeholderResourceIdGuard.run(
      ctx({
        VpcId: "vpc-0a1b2c3d4e5f67890",
        CidrBlock: "10.0.0.0/24",
      }),
    );
    expect(result.kind).toBe("pass");
  });

  it("fails with actionable error on scalar placeholder VpcId (B-06 Subnet)", async () => {
    const result = await placeholderResourceIdGuard.run(
      ctx({
        VpcId: "vpc-0abc1234def567890",
        CidrBlock: "10.0.1.0/24",
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain('Field "VpcId"');
      expect(result.errorMessage).toContain("vpc-0abc1234def567890");
      expect(result.errorMessage).toContain("--set VpcId=<real-id>");
      expect(result.errorMessage).toContain("describe-vpcs");
    }
  });

  it("fails on array placeholder (B-08 LoadBalancer Subnets)", async () => {
    const result = await placeholderResourceIdGuard.run(
      ctx({
        Subnets: ["subnet-abc12345", "subnet-def67890"],
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain("Subnets[0]");
      expect(result.errorMessage).toContain("subnet-abc12345");
    }
  });

  it("fails on docs-placeholder sg-12345678 (C-14)", async () => {
    const result = await placeholderResourceIdGuard.run(
      ctx({
        SecurityGroupIds: ["sg-12345678", "sg-87654321"],
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain("sg-12345678");
    }
  });

  it("fails on angle-bracket template subnet id (Epic 94 B-04)", async () => {
    const result = await placeholderResourceIdGuard.run(
      ctx({
        // From the B-04 finding: `"Create a NAT gateway in subnet-<hex>"`.
        SubnetId: "subnet-<hex>",
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain("subnet-<hex>");
      expect(result.errorMessage).toContain("placeholder");
    }
  });

  it("short-circuits on the first hit in insertion order", async () => {
    const result = await placeholderResourceIdGuard.run(
      ctx({
        VpcId: "vpc-12345678",
        // If the walker somehow skipped the scalar and hit the array
        // first, this assertion would break.
        Subnets: ["subnet-12345678"],
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain("VpcId");
      expect(result.errorMessage).not.toContain("Subnets[0]");
    }
  });
});
