import { describe, it, expect } from "vitest";
import { elbv2LoadBalancerPlugin } from "./elbv2-loadbalancer.js";

describe("elbv2LoadBalancerPlugin", () => {
  it("has the correct resourceType", () => {
    expect(elbv2LoadBalancerPlugin.resourceType).toBe(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
  });

  it("commonFields count is ≤10", () => {
    expect(elbv2LoadBalancerPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 5", () => {
    expect(elbv2LoadBalancerPlugin.commonFields.length).toBe(5);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of elbv2LoadBalancerPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  describe("Name validation", () => {
    const field = elbv2LoadBalancerPlugin.commonFields.find(
      (f) => f.name === "Name",
    )!;

    it("is required", () => {
      expect(field.required).toBe(true);
    });

    it("rejects empty value with 'required' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("")).toBe(
        "Load balancer name is required",
      );
    });

    it("accepts valid name", () => {
      expect(field.question.validate?.("my-alb")).toBeUndefined();
    });

    it("rejects names longer than 32 chars with length error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("a".repeat(33))).toBe(
        "Name must be 1-32 characters",
      );
    });

    it("accepts exactly 32 chars (boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("a".repeat(32))).toBeUndefined();
    });

    it("rejects names starting with hyphen with charset error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("-my-alb")).toBe(
        "Must contain only letters, numbers, hyphens, and cannot start/end with a hyphen",
      );
    });

    it("rejects names ending with hyphen with charset error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("my-alb-")).toBe(
        "Must contain only letters, numbers, hyphens, and cannot start/end with a hyphen",
      );
    });
  });

  it("Type is an enum with application and network", () => {
    const field = elbv2LoadBalancerPlugin.commonFields.find(
      (f) => f.name === "Type",
    );
    expect(field?.question.type).toBe("enum");
    expect(field?.question.initialValue).toBe("application");
    const values = field?.question.options?.map((o) => o.value);
    expect(values).toContain("application");
    expect(values).toContain("network");
  });

  it("Scheme is an enum with internet-facing and internal", () => {
    const field = elbv2LoadBalancerPlugin.commonFields.find(
      (f) => f.name === "Scheme",
    );
    expect(field?.question.type).toBe("enum");
    expect(field?.question.initialValue).toBe("internet-facing");
    const values = field?.question.options?.map((o) => o.value);
    expect(values).toContain("internet-facing");
    expect(values).toContain("internal");
  });

  it("Subnets is a required multi field with fetcher", () => {
    const field = elbv2LoadBalancerPlugin.commonFields.find(
      (f) => f.name === "Subnets",
    );
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("multi");
    expect(field?.question.fetcher).toBe("discover-subnets");
  });

  it("Tags field has callable toCfn transform", () => {
    // Tier C: strengthened — find!() + function-ness
    const field = elbv2LoadBalancerPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;
    expect(typeof field.toCfn).toBe("function");
  });

  describe("Tags toCfn transform", () => {
    const field = elbv2LoadBalancerPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;

    it("converts comma-separated Key:Value pairs", () => {
      expect(field.toCfn!("env:prod, team:backend")).toEqual([
        { Key: "env", Value: "prod" },
        { Key: "team", Value: "backend" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  it("advancedFields contains SecurityGroups, IpAddressType, and DeletionProtection", () => {
    const names = elbv2LoadBalancerPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("SecurityGroups");
    expect(names).toContain("IpAddressType");
    expect(names).toContain("DeletionProtection");
  });

  it("SecurityGroups has showIf condition on Type=application", () => {
    const field = elbv2LoadBalancerPlugin.advancedFields.find(
      (f) => f.name === "SecurityGroups",
    );
    expect(field?.question.showIf).toEqual({
      field: "Type",
      value: "application",
    });
    expect(field?.question.fetcher).toBe("discover-security-groups");
  });

  it("DeletionProtection defaults to true", () => {
    const field = elbv2LoadBalancerPlugin.advancedFields.find(
      (f) => f.name === "DeletionProtection",
    );
    expect(field?.question.type).toBe("boolean");
    expect(field?.question.initialValue).toBe(true);
  });

  describe("DeletionProtection toCfn transform", () => {
    const field = elbv2LoadBalancerPlugin.advancedFields.find(
      (f) => f.name === "DeletionProtection",
    )!;

    it("returns load balancer attribute with true", () => {
      expect(field.toCfn!(true)).toEqual([
        { Key: "deletion_protection.enabled", Value: "true" },
      ]);
    });

    it("returns load balancer attribute with false", () => {
      expect(field.toCfn!(false)).toEqual([
        { Key: "deletion_protection.enabled", Value: "false" },
      ]);
    });
  });

  it("defaults include Type, Scheme, and IpAddressType", () => {
    expect(elbv2LoadBalancerPlugin.defaults).toEqual({
      Type: "application",
      Scheme: "internet-facing",
      IpAddressType: "ipv4",
    });
  });
});
