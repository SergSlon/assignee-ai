import { describe, it, expect } from "vitest";
import { PricingStrategyRegistry } from "./registry.js";
import { defaultPricingRegistry } from "./index.js";
import type { PricingStrategy } from "./types.js";

describe("PricingStrategyRegistry", () => {
  it("returns defined cost label for registered S3::Bucket", () => {
    // Tier C: dropped redundant toBeDefined() — typeof string is stronger
    const result = defaultPricingRegistry.estimate(
      "AWS::S3::Bucket",
      undefined,
    );
    expect(typeof result.label).toBe("string");
    expect(result.label.length).toBeGreaterThan(0);
  });

  it("returns Free for IAM::Role (local estimate, no MCP needed)", () => {
    const result = defaultPricingRegistry.estimate("AWS::IAM::Role", undefined);
    expect(result.isFree).toBe(true);
    expect(result.label).toBe("Free");
  });

  it("computes Lambda estimate from default MemorySize", () => {
    const result = defaultPricingRegistry.estimate(
      "AWS::Lambda::Function",
      undefined,
    );
    expect(result.label).toMatch(/^~\$0\.41\/million req/);
    expect(result.label).toContain("128MB");
  });

  it("computes Lambda estimate from provided MemorySize=512", () => {
    const result = defaultPricingRegistry.estimate("AWS::Lambda::Function", {
      MemorySize: 512,
    });
    expect(result.label).toMatch(/^~\$1\.03\/million req/);
    expect(result.label).toContain("512MB");
  });

  it("returns local estimate for registered DynamoDB::Table", () => {
    const result = defaultPricingRegistry.estimate(
      "AWS::DynamoDB::Table",
      undefined,
    );
    // Tier C: dropped redundant toBeDefined() — typeof string is stronger
    expect(typeof result.label).toBe("string");
    expect(result.label).not.toBe("Pricing unavailable");
  });

  it("provides McpPricingConfig for S3::Bucket (requires MCP pricing call)", () => {
    const config = defaultPricingRegistry.getMcpConfig(
      "AWS::S3::Bucket",
      undefined,
    );
    expect(config).not.toBeNull();
    expect(config?.serviceCode).toBe("AmazonS3");
    expect(config?.unit).toBe("/GB-month");
    expect(Array.isArray(config?.filters)).toBe(true);
  });

  it("returns null McpConfig for IAM::Role (no MCP needed)", () => {
    const config = defaultPricingRegistry.getMcpConfig(
      "AWS::IAM::Role",
      undefined,
    );
    expect(config).toBeNull();
  });

  it("returns null McpConfig for Lambda (computed locally)", () => {
    const config = defaultPricingRegistry.getMcpConfig(
      "AWS::Lambda::Function",
      undefined,
    );
    expect(config).toBeNull();
  });

  it("adding a new resource type requires only registering one strategy", () => {
    const registry = new PricingStrategyRegistry();
    // Adding new resource: only this one file change needed
    const newStrategy: PricingStrategy = {
      estimateLocal: () => ({
        perMonth: 0.05,
        label: "$0.05/unit",
        isFree: false,
      }),
    };
    registry.register("AWS::Custom::Resource", newStrategy);
    const result = registry.estimate("AWS::Custom::Resource", undefined);
    expect(result.label).toBe("$0.05/unit");
    // Unregistered types still fall back gracefully
    const unknown = registry.estimate("AWS::Unknown::Resource", undefined);
    expect(unknown.label).toBe("Pricing unavailable");
  });
});
