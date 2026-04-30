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

  it("throws when registering a duplicate resourceType", () => {
    const registry = new PluginRegistry();
    registry.register(mockPlugin);
    const duplicate = { ...mockPlugin, defaults: { Encryption: "AES256" } };
    expect(() => registry.register(duplicate)).toThrow(
      /duplicate registration for resourceType "AWS::Test::Resource"/,
    );
  });

  it("thrown error is an instance of Error", () => {
    const registry = new PluginRegistry();
    registry.register(mockPlugin);
    let caught: unknown;
    try {
      registry.register(mockPlugin);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it("thrown error message contains the duplicate resourceType string", () => {
    const registry = new PluginRegistry();
    registry.register(mockPlugin);
    expect(() => registry.register(mockPlugin)).toThrow("AWS::Test::Resource");
  });

  it("unregister() followed by register() does not throw", () => {
    const registry = new PluginRegistry();
    registry.register(mockPlugin);
    registry.unregister("AWS::Test::Resource");
    expect(() => registry.register(mockPlugin)).not.toThrow();
    expect(registry.get("AWS::Test::Resource")).toBe(mockPlugin);
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

  it("registering two different resourceTypes in the same registry succeeds", () => {
    const registry = new PluginRegistry();
    const anotherPlugin: ResourcePlugin = {
      resourceType: "AWS::Test::Other",
      commonFields: [],
      advancedFields: [],
      defaults: {},
    };
    registry.register(mockPlugin);
    expect(() => registry.register(anotherPlugin)).not.toThrow();
    expect(registry.get("AWS::Test::Resource")).toBe(mockPlugin);
    expect(registry.get("AWS::Test::Other")).toBe(anotherPlugin);
  });
});
