/**
 * Unit tests for the AWS::EC2::EIP plugin (e98.W5.N5 / B-03).
 *
 * Locks:
 *   1. Plugin resourceType is RESOURCE_TYPES.EC2_EIP.
 *   2. Registered on the defaultPluginRegistry so
 *      `defaultPluginRegistry.get(RESOURCE_TYPES.EC2_EIP)` returns it.
 *   3. `Domain: "vpc"` is the plugin default — the only
 *      operationally-meaningful domain on modern accounts.
 *   4. Tags field + toCfn transform produces well-formed `[{Key,Value}]`
 *      tag arrays from the comma-delimited wizard input.
 *   5. Plugin is taggable (not in NO_TAG_TYPES).
 */

import { describe, it, expect } from "vitest";
import { ec2EipPlugin } from "./ec2-eip.js";
import { defaultPluginRegistry, RESOURCE_TYPES } from "@/index.js";
import { CfnKey } from "@/config/cfn-keys.js";

describe("ec2EipPlugin (e98.W5.N5 B-03)", () => {
  it("declares resourceType = AWS::EC2::EIP", () => {
    expect(ec2EipPlugin.resourceType).toBe(RESOURCE_TYPES.EC2_EIP);
    expect(ec2EipPlugin.resourceType).toBe("AWS::EC2::EIP");
  });

  it("is registered on the default plugin registry", () => {
    const fromRegistry = defaultPluginRegistry.get(RESOURCE_TYPES.EC2_EIP);
    expect(fromRegistry).toBe(ec2EipPlugin);
  });

  it("declares Domain default as 'vpc'", () => {
    expect(ec2EipPlugin.defaults[CfnKey.DOMAIN]).toBe("vpc");
  });

  it("exposes a Tags field on commonFields", () => {
    const tagField = ec2EipPlugin.commonFields.find(
      (f) => f.name === CfnKey.TAGS,
    );
    expect(tagField).toBeDefined();
    expect(tagField!.question.type).toBe("string");
  });

  it("Tags toCfn transforms `env:prod, team:platform` into CFN tag array", () => {
    const tagField = ec2EipPlugin.commonFields.find(
      (f) => f.name === CfnKey.TAGS,
    )!;
    const result = tagField.toCfn!("env:prod, team:platform");
    expect(result).toEqual([
      { Key: "env", Value: "prod" },
      { Key: "team", Value: "platform" },
    ]);
  });

  it("Tags toCfn returns undefined on empty / whitespace input", () => {
    const tagField = ec2EipPlugin.commonFields.find(
      (f) => f.name === CfnKey.TAGS,
    )!;
    expect(tagField.toCfn!("")).toBeUndefined();
    expect(tagField.toCfn!("   ")).toBeUndefined();
    expect(tagField.toCfn!(undefined)).toBeUndefined();
  });

  it("exposes configHints covering cost + attach behaviour", () => {
    expect(Array.isArray(ec2EipPlugin.configHints)).toBe(true);
    expect(ec2EipPlugin.configHints!.length).toBeGreaterThan(0);
    const joined = ec2EipPlugin.configHints!.join(" ");
    // Key hints: free when attached, Domain=vpc, regional, NAT Gateway guidance.
    expect(joined.toLowerCase()).toContain("free while attached");
    expect(joined.toLowerCase()).toContain("domain");
    expect(joined.toLowerCase()).toContain("regional");
  });
});
