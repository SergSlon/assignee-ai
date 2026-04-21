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

  describe("negativeKeywords disqualification", () => {
    const withNegatives: ArchitecturePattern = {
      ...mockPattern,
      patternId: "with-negatives",
      keywords: ["build a widget"],
      negativeKeywords: ["standalone", "only"],
    };

    it("skips a pattern when a negative keyword is present in the intent", () => {
      const registry = new PatternRegistry();
      registry.register(withNegatives);
      expect(
        registry.detect("build a widget standalone for me please"),
      ).toBeNull();
    });

    it("skips a pattern when ANY negative keyword matches (OR semantics)", () => {
      const registry = new PatternRegistry();
      registry.register(withNegatives);
      expect(registry.detect("build a widget only")).toBeNull();
    });

    it("negative keyword match is case-insensitive", () => {
      const registry = new PatternRegistry();
      registry.register(withNegatives);
      expect(registry.detect("Build a Widget STANDALONE")).toBeNull();
    });

    it("falls through to the next pattern when the first has a negative hit", () => {
      const fallback: ArchitecturePattern = {
        ...mockPattern,
        patternId: "fallback",
        keywords: ["build a widget"],
      };
      const registry = new PatternRegistry();
      registry.register(withNegatives);
      registry.register(fallback);
      // First pattern is disqualified → registry returns second.
      expect(registry.detect("build a widget standalone")).toBe(fallback);
    });

    it("still matches when no negative keyword appears", () => {
      const registry = new PatternRegistry();
      registry.register(withNegatives);
      expect(registry.detect("please build a widget for me")).toBe(
        withNegatives,
      );
    });

    it("patterns without negativeKeywords behave unchanged (backward compatible)", () => {
      const registry = new PatternRegistry();
      registry.register(mockPattern);
      expect(registry.detect("test keyword standalone")).toBe(mockPattern);
    });
  });
});
