import { describe, it, expect } from "vitest";
import { internetGatewayPlugin } from "./ec2-internet-gateway.js";

describe("internetGatewayPlugin", () => {
  it("has the correct resourceType", () => {
    expect(internetGatewayPlugin.resourceType).toBe(
      "AWS::EC2::InternetGateway",
    );
  });

  it("commonFields contains only Tags", () => {
    expect(internetGatewayPlugin.commonFields.length).toBe(1);
    expect(internetGatewayPlugin.commonFields[0]!.name).toBe("Tags");
  });

  it("commonFields count is <=10", () => {
    expect(internetGatewayPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of internetGatewayPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("advancedFields is empty", () => {
    expect(internetGatewayPlugin.advancedFields).toEqual([]);
  });

  it("defaults is empty", () => {
    expect(internetGatewayPlugin.defaults).toEqual({});
  });

  it("has at least 2 configHints (Tier C: was toBeDefined+>0)", () => {
    // Tier C: strengthened — meaningful floor
    expect(internetGatewayPlugin.configHints).toBeInstanceOf(Array);
    expect(internetGatewayPlugin.configHints!.length).toBeGreaterThanOrEqual(2);
  });

  it("configHints mention VPCGatewayAttachment", () => {
    const hints = internetGatewayPlugin.configHints!.join(" ");
    expect(hints).toContain("VPCGatewayAttachment");
  });

  it("configHints mention route table for public subnets", () => {
    const hints = internetGatewayPlugin.configHints!.join(" ");
    expect(hints).toContain("0.0.0.0/0");
  });

  // ── Epic 92 e92.u.c.2 B-11 — inline prompt prefill guidance ──────────

  describe("Epic 92 B-11: VpcId missing plan-time UX", () => {
    it("configHints contain the --set VpcId= remediation for the BLOCK path", () => {
      // B-11: the old message "attach to a managed VPC" was vague.
      // Post-fix, the plan-generator must be directed to emit a
      // concrete remediation string that contains the actual flag
      // the user needs to run.
      const hints = internetGatewayPlugin.configHints!.join("\n");
      expect(hints).toContain("[BLOCK]");
      expect(hints).toContain("--set VpcId=<vpc-id>");
      expect(hints).toContain("VpcId missing");
    });

    it("configHints direct the LLM to emit a companion VPCGatewayAttachment", () => {
      // B-11: the IGW is inert without an attachment. The LLM must
      // emit BOTH resources together; naming the companion resource
      // explicitly by schema name + required property shape is the
      // only reliable way to get that behaviour deterministically.
      const hints = internetGatewayPlugin.configHints!.join("\n");
      expect(hints).toContain("AWS::EC2::VPCGatewayAttachment");
      expect(hints).toContain("InternetGatewayId");
    });

    it("configHints mention the candidates-list upgrade path for managed-resources cache", () => {
      // B-11 deferred follow-up F1: candidates-list injection.
      // The hint explicitly describes the shape the plan-generator
      // SHOULD emit when the managed-resources cache is wired in,
      // so the LLM's output format is stable across the wiring
      // commit.
      const hints = internetGatewayPlugin.configHints!.join("\n");
      expect(hints).toContain("candidates:");
      expect(hints).toContain("vpc-abc123");
    });

    it("configHints discourage fabricated vpc-00000000 placeholders", () => {
      // B-11 guard rail: same class of bug as NAT Gateway's
      // subnet-00000000 — stop the LLM from inventing fake IDs
      // that will fail at apply and waste a CCAPI round-trip.
      const hints = internetGatewayPlugin.configHints!.join("\n");
      expect(hints).toContain("vpc-00000000");
      expect(hints).toContain("NOT fabricate");
    });

    it("configHints document compound {Ref:<VpcLogicalId>} wiring", () => {
      // B-11 happy path: when the plan IS a compound that also
      // creates the VPC, the attachment must use { Ref: ... } — that
      // shape is load-bearing and must not regress.
      const hints = internetGatewayPlugin.configHints!.join("\n");
      expect(hints).toContain("Ref");
      expect(hints).toContain("VpcLogicalId");
    });

    it("has at least 5 configHints after B-11 additions (regression floor)", () => {
      // Pre-B-11 there were 3 hints. Post-B-11 there are 5. The
      // assertion is a conservative floor that allows future adds
      // without weakening.
      expect(internetGatewayPlugin.configHints!.length).toBeGreaterThanOrEqual(
        5,
      );
      // Exact count at this commit:
      expect(internetGatewayPlugin.configHints!.length).toBe(5);
    });
  });

  describe("Tags toCfn transform", () => {
    const field = internetGatewayPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;

    it("Tags field has callable toCfn transform", () => {
      // Tier C: strengthened — function-ness check
      expect(typeof field.toCfn).toBe("function");
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
});
