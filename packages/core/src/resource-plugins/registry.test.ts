import { describe, it, expect } from "vitest";
import { PluginRegistry } from "./registry.js";
import type { ResourcePlugin } from "./types.js";

const mockPlugin: ResourcePlugin = {
  resourceType: "AWS::Test::Resource",
  commonFields: [],
  advancedFields: [],
  defaults: {},
};

describe("PluginRegistry", () => {
  it("returns undefined for unregistered resource type", () => {
    const registry = new PluginRegistry();
    expect(registry.get("AWS::Unknown::Type")).toBeUndefined();
  });

  it("returns registered plugin", () => {
    const registry = new PluginRegistry();
    registry.register(mockPlugin);
    expect(registry.get("AWS::Test::Resource")).toBe(mockPlugin);
  });

  it("overwrites plugin when re-registered", () => {
    const registry = new PluginRegistry();
    registry.register(mockPlugin);
    const updated = { ...mockPlugin, defaults: { foo: "bar" } };
    registry.register(updated);
    expect(registry.get("AWS::Test::Resource")?.defaults).toEqual({
      foo: "bar",
    });
  });

  it("has() returns true for registered type", () => {
    const registry = new PluginRegistry();
    registry.register(mockPlugin);
    expect(registry.has("AWS::Test::Resource")).toBe(true);
  });

  it("has() returns false for unregistered type", () => {
    const registry = new PluginRegistry();
    expect(registry.has("AWS::Missing::Resource")).toBe(false);
  });

  it("different registries are independent", () => {
    const r1 = new PluginRegistry();
    const r2 = new PluginRegistry();
    r1.register(mockPlugin);
    expect(r2.has("AWS::Test::Resource")).toBe(false);
  });
});
