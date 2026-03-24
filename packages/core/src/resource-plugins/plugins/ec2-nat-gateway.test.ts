import { describe, it, expect } from "vitest";
import { natGatewayPlugin } from "./ec2-nat-gateway.js";
import type { CfnOutput } from "../types.js";

describe("natGatewayPlugin", () => {
  it("has the correct resourceType", () => {
    expect(natGatewayPlugin.resourceType).toBe("AWS::EC2::NatGateway");
  });

  // ── commonFields ──────────────────────────────────────────────────────

  it("commonFields count is <=10", () => {
    expect(natGatewayPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields contains SubnetId, ConnectivityType, Tags", () => {
    const names = natGatewayPlugin.commonFields.map((f) => f.name);
    expect(names).toContain("SubnetId");
    expect(names).toContain("ConnectivityType");
    expect(names).toContain("Tags");
  });

  it("SubnetId is required and has discover-subnets fetcher", () => {
    const field = natGatewayPlugin.commonFields.find(
      (f) => f.name === "SubnetId",
    )!;
    expect(field.required).toBe(true);
    expect(field.question.fetcher).toBe("discover-subnets");
    expect(field.question.type).toBe("enum");
  });

  it("ConnectivityType defaults to 'public'", () => {
    const field = natGatewayPlugin.commonFields.find(
      (f) => f.name === "ConnectivityType",
    )!;
    expect(field.question.initialValue).toBe("public");
    expect(field.question.type).toBe("enum");
    expect(field.question.options).toBeDefined();
    expect(field.question.options!.length).toBe(2);
    const values = field.question.options!.map((o) => o.value);
    expect(values).toContain("public");
    expect(values).toContain("private");
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set([
      "boolean",
      "enum",
      "string",
      "multi",
      "categorySelect",
    ]);
    for (const field of natGatewayPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  // ── advancedFields ────────────────────────────────────────────────────

  it("advancedFields contains MaxDrainDurationSeconds", () => {
    const names = natGatewayPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("MaxDrainDurationSeconds");
  });

  it("MaxDrainDurationSeconds defaults to '350'", () => {
    const field = natGatewayPlugin.advancedFields.find(
      (f) => f.name === "MaxDrainDurationSeconds",
    )!;
    expect(field.question.initialValue).toBe("350");
  });

  it("MaxDrainDurationSeconds validates range", () => {
    const field = natGatewayPlugin.advancedFields.find(
      (f) => f.name === "MaxDrainDurationSeconds",
    )!;
    expect(field.question.validate!("100")).toBeUndefined();
    expect(field.question.validate!("0")).toBeDefined();
    expect(field.question.validate!("5000")).toBeDefined();
    expect(field.question.validate!("abc")).toBeDefined();
    expect(field.question.validate!("")).toBeUndefined();
  });

  // ── defaults ──────────────────────────────────────────────────────────

  it("defaults ConnectivityType to 'public'", () => {
    expect(natGatewayPlugin.defaults["ConnectivityType"]).toBe("public");
  });

  // ── configHints ───────────────────────────────────────────────────────

  it("has configHints", () => {
    expect(natGatewayPlugin.configHints).toBeDefined();
    expect(natGatewayPlugin.configHints!.length).toBeGreaterThan(0);
  });

  it("configHints mention public subnet requirement", () => {
    const hints = natGatewayPlugin.configHints!.join(" ");
    expect(hints).toContain("public subnet");
  });

  it("configHints mention EIP auto-provisioning", () => {
    const hints = natGatewayPlugin.configHints!.join(" ");
    expect(hints).toContain("Elastic IP");
  });

  it("configHints mention cost", () => {
    const hints = natGatewayPlugin.configHints!.join(" ");
    expect(hints).toContain("cost");
  });

  it("configHints mention HA across AZs", () => {
    const hints = natGatewayPlugin.configHints!.join(" ");
    expect(hints).toContain("per AZ");
  });

  // ── Tags toCfn transform ─────────────────────────────────────────────

  describe("Tags toCfn transform", () => {
    const field = natGatewayPlugin.commonFields.find((f) => f.name === "Tags")!;

    it("Tags field has toCfn transform", () => {
      expect(field.toCfn).toBeDefined();
    });

    it("transforms comma-separated pairs", () => {
      expect(field.toCfn!("env:production, team:platform")).toEqual([
        { Key: "env", Value: "production" },
        { Key: "team", Value: "platform" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });

    it("handles values containing colons", () => {
      expect(field.toCfn!("arn:aws:s3:::my-bucket")).toEqual([
        { Key: "arn", Value: "aws:s3:::my-bucket" },
      ]);
    });
  });

  // ── toCfn() — public connectivity ────────────────────────────────────

  describe("toCfn() with public ConnectivityType", () => {
    it("produces both NatGateway and EIP resources", () => {
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
        ConnectivityType: "public",
      }) as CfnOutput[];

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);

      const types = result.map((r) => r.type);
      expect(types).toContain("AWS::EC2::NatGateway");
      expect(types).toContain("AWS::EC2::EIP");
    });

    it("EIP resource has Domain: vpc", () => {
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
        ConnectivityType: "public",
      }) as CfnOutput[];

      const eip = result.find((r) => r.type === "AWS::EC2::EIP")!;
      expect(eip.properties["Domain"]).toBe("vpc");
    });

    it("NatGateway AllocationId references the EIP via Fn::GetAtt", () => {
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
        ConnectivityType: "public",
      }) as CfnOutput[];

      const natGw = result.find((r) => r.type === "AWS::EC2::NatGateway")!;
      expect(natGw.properties["AllocationId"]).toBeDefined();
      const allocationRef = natGw.properties["AllocationId"] as Record<
        string,
        unknown
      >;
      expect(allocationRef["Fn::GetAtt"]).toBeDefined();
    });

    it("NatGateway includes SubnetId and ConnectivityType", () => {
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
        ConnectivityType: "public",
      }) as CfnOutput[];

      const natGw = result.find((r) => r.type === "AWS::EC2::NatGateway")!;
      expect(natGw.properties["SubnetId"]).toBe("subnet-abc123");
      expect(natGw.properties["ConnectivityType"]).toBe("public");
    });

    it("uses default ConnectivityType 'public' when not specified", () => {
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
      }) as CfnOutput[];

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);

      const types = result.map((r) => r.type);
      expect(types).toContain("AWS::EC2::EIP");
    });
  });

  // ── toCfn() — private connectivity ───────────────────────────────────

  describe("toCfn() with private ConnectivityType", () => {
    it("produces only NatGateway resource (no EIP)", () => {
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
        ConnectivityType: "private",
      }) as CfnOutput[];

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);

      const natGw = result[0]!;
      expect(natGw.type).toBe("AWS::EC2::NatGateway");
      expect(natGw.properties["ConnectivityType"]).toBe("private");
    });

    it("does not include AllocationId for private connectivity", () => {
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
        ConnectivityType: "private",
      }) as CfnOutput[];

      const natGw = result[0]!;
      expect(natGw.properties["AllocationId"]).toBeUndefined();
    });
  });

  // ── toCfn() — optional fields ────────────────────────────────────────

  describe("toCfn() optional fields", () => {
    it("includes Tags on both NatGateway and EIP when provided", () => {
      const tags = [{ Key: "env", Value: "prod" }];
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
        ConnectivityType: "public",
        Tags: tags,
      }) as CfnOutput[];

      const eip = result.find((r) => r.type === "AWS::EC2::EIP")!;
      const natGw = result.find((r) => r.type === "AWS::EC2::NatGateway")!;

      expect(eip.properties["Tags"]).toEqual(tags);
      expect(natGw.properties["Tags"]).toEqual(tags);
    });

    it("includes MaxDrainDurationSeconds as integer when provided", () => {
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
        ConnectivityType: "public",
        MaxDrainDurationSeconds: "500",
      }) as CfnOutput[];

      const natGw = result.find((r) => r.type === "AWS::EC2::NatGateway")!;
      expect(natGw.properties["MaxDrainDurationSeconds"]).toBe(500);
    });

    it("uses custom _logicalId prefix for logical IDs", () => {
      const result = natGatewayPlugin.toCfn!({
        SubnetId: "subnet-abc123",
        ConnectivityType: "public",
        _logicalId: "MyNatGw",
      }) as CfnOutput[];

      const eip = result.find((r) => r.type === "AWS::EC2::EIP")!;
      const natGw = result.find((r) => r.type === "AWS::EC2::NatGateway")!;

      expect(eip.logicalId).toBe("MyNatGwEIP");
      expect(natGw.logicalId).toBe("MyNatGw");
    });
  });
});
