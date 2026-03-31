/**
 * Tests for FixCommandResolver — Story 35.2
 */

import { describe, it, expect } from "vitest";
import type { BPFinding } from "@assignee/best-practices";
import {
  resolveAction,
  countFixable,
  countAutoFixable,
} from "./fix-command-resolver.js";

function makeFinding(overrides: Partial<BPFinding>): BPFinding {
  return {
    practiceId: "BP-TEST-001",
    title: "Test Finding",
    severity: "HIGH",
    category: "security",
    message: "Test message",
    blocking: false,
    ...overrides,
  };
}

describe("resolveAction", () => {
  it("returns auto-fixable for findings with autoFixable + desiredStatePatch", () => {
    const finding = makeFinding({
      autoFixable: true,
      desiredStatePatch: { VersioningConfiguration: { Status: "Enabled" } },
      propertyPath: "VersioningConfiguration.Status",
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("auto-fixable");
    expect(action.fixable).toBe(true);
    expect(action.command).toContain("--set VersioningConfiguration=");
    expect(action.patch).toEqual({
      VersioningConfiguration: { Status: "Enabled" },
    });
  });

  it("auto-fixable hint matches the correct sub-property, not just the first wizard field", () => {
    // BP-S3-002: BlockPublicPolicy — should NOT show BlockPublicAcls
    const finding = makeFinding({
      autoFixable: true,
      desiredStatePatch: { PublicAccessBlockConfiguration: { BlockPublicPolicy: true } },
      propertyPath: "PublicAccessBlockConfiguration.BlockPublicPolicy",
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("auto-fixable");
    expect(action.command).toContain("--set BlockPublicPolicy=");
    expect(action.command).not.toContain("BlockPublicAcls");
  });

  it("auto-fixable hint for IgnorePublicAcls shows correct field", () => {
    const finding = makeFinding({
      autoFixable: true,
      desiredStatePatch: { PublicAccessBlockConfiguration: { IgnorePublicAcls: true } },
      propertyPath: "PublicAccessBlockConfiguration.IgnorePublicAcls",
    });

    const action = resolveAction(finding);
    expect(action.command).toContain("--set IgnorePublicAcls=");
  });

  it("auto-fixable hint for EBS encryption drills into array to find correct field", () => {
    const finding = makeFinding({
      autoFixable: true,
      desiredStatePatch: { BlockDeviceMappings: [{ Ebs: { Encrypted: true } }] },
      propertyPath: "BlockDeviceMappings[0].Ebs.Encrypted",
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("auto-fixable");
    expect(action.command).toContain("--set EbsEncrypted=");
  });

  it("returns wizard-fixable for interactive fixType findings with patch", () => {
    const finding = makeFinding({
      fixType: "interactive",
      interactiveOptions: [
        { label: "Enter an IAM role ARN", action: "prompt_value", targetField: "IamInstanceProfile" },
        { label: "Skip", action: "skip" },
      ],
      propertyPath: "IamInstanceProfile",
      desiredStatePatch: { IamInstanceProfile: "some-role" },
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("wizard-fixable");
    expect(action.fixable).toBe(true);
    expect(action.hint).toBe("Enter an IAM role ARN");
  });

  it("returns wizard-fixable when propertyPath root key is in wizardKeyMap and has patch", () => {
    const finding = makeFinding({
      propertyPath: "BlockDeviceMappings[0].Ebs.Encrypted",
      desiredStatePatch: { BlockDeviceMappings: [{ Ebs: { Encrypted: true } }] },
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("wizard-fixable");
    expect(action.fixable).toBe(true);
    expect(action.command).toContain("--set EbsEncrypted=");
  });

  it("returns manual when propertyPath has wizardKeyMap match but no patch", () => {
    const finding = makeFinding({
      propertyPath: "BlockDeviceMappings[0].Ebs.Encrypted",
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("manual");
    expect(action.fixable).toBe(false);
    expect(action.command).toContain("--set EbsEncrypted=");
  });

  it("returns manual for findings with property_path not in wizardKeyMap", () => {
    const finding = makeFinding({
      propertyPath: "SomeUnknownProperty.Nested",
      remediation: "Configure SomeUnknownProperty in AWS console",
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("manual");
    expect(action.fixable).toBe(false);
    expect(action.hint).toBe("Configure SomeUnknownProperty in AWS console");
  });

  it("returns awareness for fixType info", () => {
    const finding = makeFinding({
      fixType: "info",
      propertyPath: "SomePath",
      remediation: "Check after deployment",
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("awareness");
    expect(action.fixable).toBe(false);
    expect(action.hint).toBe("Check after deployment");
  });

  it("returns awareness when no propertyPath", () => {
    const finding = makeFinding({
      propertyPath: undefined,
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("awareness");
    expect(action.fixable).toBe(false);
  });

  it("uses fixHint when available (manual finding)", () => {
    const finding = makeFinding({
      propertyPath: "SomeUnknownProperty",
      fixHint: "Enable in AWS console after deployment",
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("manual");
    expect(action.hint).toBe("Enable in AWS console after deployment");
  });

  it("uses fixHint for awareness findings", () => {
    const finding = makeFinding({
      fixType: "info",
      fixHint: "Check CloudWatch metrics after launch",
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("awareness");
    expect(action.hint).toBe("Check CloudWatch metrics after launch");
  });

  it("empty desiredStatePatch ({}) should NOT be auto-fixable", () => {
    const finding = makeFinding({
      autoFixable: true,
      desiredStatePatch: {},
      propertyPath: "SomeUnknownProperty",
    });

    const action = resolveAction(finding);
    expect(action.category).not.toBe("auto-fixable");
  });

  it("empty string propertyPath should be awareness category", () => {
    const finding = makeFinding({
      propertyPath: "",
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("awareness");
    expect(action.fixable).toBe(false);
  });

  it("interactive finding with undefined label and no fixHint uses fallback hint", () => {
    const finding = makeFinding({
      fixType: "interactive",
      interactiveOptions: [
        { label: undefined as unknown as string, action: "prompt_value", targetField: "SomeField" },
        { label: "Skip", action: "skip" },
      ],
      propertyPath: "SomeField",
      desiredStatePatch: { SomeField: "value" },
    });

    const action = resolveAction(finding);
    expect(action.category).toBe("wizard-fixable");
    expect(action.hint).toBe("Select an option to fix");
    expect(action.hint).not.toBe("undefined");
  });

  it("interactive finding without desiredStatePatch should NOT be wizard-fixable or fixable", () => {
    const finding = makeFinding({
      fixType: "interactive",
      interactiveOptions: [
        { label: "Enter a value", action: "prompt_value", targetField: "SomeField" },
        { label: "Skip", action: "skip" },
      ],
      propertyPath: "SomeField",
      // no desiredStatePatch
    });

    const action = resolveAction(finding);
    expect(action.category).not.toBe("wizard-fixable");
    expect(action.fixable).toBe(false);
  });
});

describe("countFixable", () => {
  it("counts auto-fixable and wizard-fixable findings (with patches)", () => {
    const findings = [
      makeFinding({
        autoFixable: true,
        desiredStatePatch: { VersioningConfiguration: true },
        propertyPath: "VersioningConfiguration",
      }),
      makeFinding({
        propertyPath: "MetadataOptions.HttpTokens",
        desiredStatePatch: { MetadataOptions: { HttpTokens: "required" } },
      }),
      makeFinding({
        fixType: "info",
        propertyPath: "SomePath",
      }),
    ];

    expect(countFixable(findings)).toBe(2);
  });

  it("returns 0 when no findings are fixable", () => {
    const findings = [
      makeFinding({ fixType: "info", propertyPath: "Foo" }),
      makeFinding({ propertyPath: undefined }),
    ];
    expect(countFixable(findings)).toBe(0);
  });
});

describe("countAutoFixable", () => {
  it("counts only auto-fixable findings", () => {
    const findings = [
      makeFinding({
        autoFixable: true,
        desiredStatePatch: { VersioningConfiguration: true },
        propertyPath: "VersioningConfiguration",
      }),
      makeFinding({ propertyPath: "MetadataOptions.HttpTokens" }),
    ];

    expect(countAutoFixable(findings)).toBe(1);
  });
});
