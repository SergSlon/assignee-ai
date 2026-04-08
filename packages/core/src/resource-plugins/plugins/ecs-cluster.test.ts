import { describe, it, expect } from "vitest";
import { ecsClusterPlugin } from "./ecs-cluster.js";

describe("ecsClusterPlugin", () => {
  it("has the correct resourceType", () => {
    expect(ecsClusterPlugin.resourceType).toBe("AWS::ECS::Cluster");
  });

  it("commonFields count is ≤10", () => {
    expect(ecsClusterPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 3", () => {
    expect(ecsClusterPlugin.commonFields.length).toBe(3);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of ecsClusterPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  describe("ClusterName validation", () => {
    const field = ecsClusterPlugin.commonFields.find(
      (f) => f.name === "ClusterName",
    )!;

    it("accepts empty value (auto-generated)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid cluster name", () => {
      expect(field.question.validate?.("my-cluster-123")).toBeUndefined();
    });

    it("rejects names longer than 255 chars with length error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("a".repeat(256))).toBe(
        "Cluster name must be 1-255 characters",
      );
    });

    it("accepts exactly 255 chars (boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("a".repeat(255))).toBeUndefined();
    });

    it("rejects names with special characters with charset error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("my cluster!")).toBe(
        "Cluster name can only contain letters, numbers, hyphens, and underscores",
      );
    });
  });

  it("ContainerInsights defaults to true", () => {
    const field = ecsClusterPlugin.commonFields.find(
      (f) => f.name === "ContainerInsights",
    );
    expect(field?.question.type).toBe("boolean");
    expect(field?.question.initialValue).toBe(true);
  });

  describe("ContainerInsights toCfn transform", () => {
    const field = ecsClusterPlugin.commonFields.find(
      (f) => f.name === "ContainerInsights",
    )!;

    it("returns enabled setting when true", () => {
      expect(field.toCfn!(true)).toEqual([
        { Name: "containerInsights", Value: "enabled" },
      ]);
    });

    it("returns disabled setting when false", () => {
      expect(field.toCfn!(false)).toEqual([
        { Name: "containerInsights", Value: "disabled" },
      ]);
    });
  });

  it("Tags field has callable toCfn transform", () => {
    // Tier C: strengthened — find!() + function-ness
    const field = ecsClusterPlugin.commonFields.find((f) => f.name === "Tags")!;
    expect(typeof field.toCfn).toBe("function");
  });

  describe("Tags toCfn transform", () => {
    const field = ecsClusterPlugin.commonFields.find((f) => f.name === "Tags")!;

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

  it("advancedFields contains CapacityProviders and DefaultCapacityProviderStrategy", () => {
    const names = ecsClusterPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("CapacityProviders");
    expect(names).toContain("DefaultCapacityProviderStrategy");
  });

  describe("CapacityProviders is a multi field", () => {
    const field = ecsClusterPlugin.advancedFields.find(
      (f) => f.name === "CapacityProviders",
    )!;

    it("has type multi", () => {
      expect(field.question.type).toBe("multi");
    });

    it("has FARGATE and FARGATE_SPOT options", () => {
      const values = field.question.options?.map((o) => o.value);
      expect(values).toContain("FARGATE");
      expect(values).toContain("FARGATE_SPOT");
    });
  });

  describe("DefaultCapacityProviderStrategy toCfn transform", () => {
    const field = ecsClusterPlugin.advancedFields.find(
      (f) => f.name === "DefaultCapacityProviderStrategy",
    )!;

    it("returns Fargate-only strategy by default", () => {
      const result = field.toCfn!("fargate-only") as Array<
        Record<string, unknown>
      >;
      expect(result).toHaveLength(1);
      expect(result[0]?.["CapacityProvider"]).toBe("FARGATE");
    });

    it("returns spot-primary strategy with Fargate fallback", () => {
      const result = field.toCfn!("spot-primary") as Array<
        Record<string, unknown>
      >;
      expect(result).toHaveLength(2);
      expect(result[0]?.["CapacityProvider"]).toBe("FARGATE_SPOT");
      expect(result[1]?.["CapacityProvider"]).toBe("FARGATE");
    });
  });
});
