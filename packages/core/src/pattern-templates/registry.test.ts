import { describe, it, expect } from "vitest";
import { PatternRegistry } from "./registry.js";
import type { ArchitecturePattern } from "./types.js";

const mockPattern: ArchitecturePattern = {
  patternId: "test-pattern",
  displayName: "Test Pattern",
  keywords: ["test keyword", "another test"],
  resourceList: [
    {
      resourceType: "AWS::S3::Bucket",
      resourceId: "bucket",
      displayName: "Test Bucket",
    },
  ],
  dependencyOrder: [["bucket"]],
  defaultOptions: {},
};

describe("PatternRegistry", () => {
  it("returns null for non-matching intent", () => {
    const registry = new PatternRegistry();
    registry.register(mockPattern);
    expect(registry.detect("create an EC2 instance")).toBeNull();
  });

  it("returns pattern for matching intent", () => {
    const registry = new PatternRegistry();
    registry.register(mockPattern);
    expect(registry.detect("I need a test keyword setup")).toBe(mockPattern);
  });

  it("detect is case-insensitive", () => {
    const registry = new PatternRegistry();
    registry.register(mockPattern);
    expect(registry.detect("TEST KEYWORD please")).toBe(mockPattern);
  });

  it("get returns pattern by patternId", () => {
    const registry = new PatternRegistry();
    registry.register(mockPattern);
    expect(registry.get("test-pattern")).toBe(mockPattern);
  });

  it("get returns undefined for unknown patternId", () => {
    const registry = new PatternRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("has returns true for registered pattern", () => {
    const registry = new PatternRegistry();
    registry.register(mockPattern);
    expect(registry.has("test-pattern")).toBe(true);
  });

  it("has returns false for unregistered pattern", () => {
    const registry = new PatternRegistry();
    expect(registry.has("test-pattern")).toBe(false);
  });

  it("returns first matching pattern in insertion order", () => {
    const secondPattern: ArchitecturePattern = {
      ...mockPattern,
      patternId: "second-pattern",
      keywords: ["test keyword"],
    };
    const registry = new PatternRegistry();
    registry.register(mockPattern);
    registry.register(secondPattern);
    expect(registry.detect("test keyword match")).toBe(mockPattern);
  });

  it("overwrites pattern with same patternId", () => {
    const updatedPattern: ArchitecturePattern = {
      ...mockPattern,
      displayName: "Updated Pattern",
    };
    const registry = new PatternRegistry();
    registry.register(mockPattern);
    registry.register(updatedPattern);
    expect(registry.get("test-pattern")?.displayName).toBe("Updated Pattern");
  });

  it("returns null for empty registry", () => {
    const registry = new PatternRegistry();
    expect(registry.detect("anything")).toBeNull();
  });
});
