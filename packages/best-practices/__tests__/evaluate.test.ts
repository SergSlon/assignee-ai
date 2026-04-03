import { describe, it, expect } from "vitest";
import { evaluateTriggers, getField, matchesTrigger } from "../src/evaluate.js";
import type { EvalContext } from "../src/evaluate.js";
import type { BestPractice, Trigger } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal BestPractice for testing. */
function makeBP(overrides: Partial<BestPractice> = {}): BestPractice {
  return {
    id: "BP-TEST-001",
    title: "Test practice",
    severity: "HIGH",
    resource_type: "AWS::S3::Bucket",
    property_path: "PublicAccessBlockConfiguration.BlockPublicAcls",
    check_type: "equals",
    expected_value: true,
    source: "test",
    description: "Test description",
    category: "security",
    lastVerified: "2026-03-22",
    ...overrides,
  };
}

/** Build a minimal EvalContext for testing. */
function makeCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    resourceType: "AWS::S3::Bucket",
    desiredState: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getField
// ---------------------------------------------------------------------------

describe("getField", () => {
  it("returns top-level field value", () => {
    expect(getField({ foo: 42 }, "foo")).toBe(42);
  });

  it("returns nested field value", () => {
    const obj = { a: { b: { c: "deep" } } };
    expect(getField(obj, "a.b.c")).toBe("deep");
  });

  it("returns undefined for missing path", () => {
    expect(getField({ a: 1 }, "b")).toBeUndefined();
  });

  it("returns undefined for missing nested path", () => {
    expect(getField({ a: { x: 1 } }, "a.b.c")).toBeUndefined();
  });

  it("handles null intermediate values", () => {
    const obj = { a: null } as unknown as Record<string, unknown>;
    expect(getField(obj, "a.b")).toBeUndefined();
  });

  it("traverses array index notation like BlockDeviceMappings[0].Ebs.Encrypted", () => {
    const obj = {
      BlockDeviceMappings: [{ Ebs: { Encrypted: true, VolumeType: "gp3" } }],
    };
    expect(getField(obj, "BlockDeviceMappings[0].Ebs.Encrypted")).toBe(true);
    expect(getField(obj, "BlockDeviceMappings[0].Ebs.VolumeType")).toBe("gp3");
  });

  it("returns undefined for array index out of bounds", () => {
    const obj = { items: [{ name: "first" }] };
    expect(getField(obj, "items[5].name")).toBeUndefined();
  });

  it("returns undefined when field is not an array but index notation used", () => {
    const obj = { items: "not-an-array" };
    expect(getField(obj, "items[0]")).toBeUndefined();
  });

  it("handles nested array indices like Rules[0].Conditions[1].Value", () => {
    const obj = {
      Rules: [{ Conditions: [{ Value: "a" }, { Value: "b" }] }],
    };
    expect(getField(obj, "Rules[0].Conditions[1].Value")).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// matchesTrigger
// ---------------------------------------------------------------------------

describe("matchesTrigger", () => {
  it("returns false when trigger resourceType does not match", () => {
    const trigger: Trigger = { resourceType: "AWS::EC2::Instance" };
    const ctx = makeCtx({ resourceType: "AWS::S3::Bucket" });
    expect(matchesTrigger(trigger, ctx)).toBe(false);
  });

  it("returns true when trigger resourceType matches and no other conditions", () => {
    const trigger: Trigger = { resourceType: "AWS::S3::Bucket" };
    const ctx = makeCtx({ resourceType: "AWS::S3::Bucket" });
    expect(matchesTrigger(trigger, ctx)).toBe(true);
  });

  it("returns true when always is true and resourceType matches", () => {
    const trigger: Trigger = { resourceType: "AWS::S3::Bucket", always: true };
    const ctx = makeCtx({ resourceType: "AWS::S3::Bucket" });
    expect(matchesTrigger(trigger, ctx)).toBe(true);
  });

  it("returns false when always is true but resourceType does not match", () => {
    const trigger: Trigger = {
      resourceType: "AWS::EC2::Instance",
      always: true,
    };
    const ctx = makeCtx({ resourceType: "AWS::S3::Bucket" });
    expect(matchesTrigger(trigger, ctx)).toBe(false);
  });

  it("matches intentKeywords case-insensitively", () => {
    const trigger: Trigger = { intentKeywords: ["storage", "backup"] };
    const ctx = makeCtx({ userIntent: "Create a STORAGE bucket" });
    expect(matchesTrigger(trigger, ctx)).toBe(true);
  });

  it("returns false when no intentKeywords match", () => {
    const trigger: Trigger = { intentKeywords: ["database"] };
    const ctx = makeCtx({ userIntent: "Create a bucket" });
    expect(matchesTrigger(trigger, ctx)).toBe(false);
  });

  it("returns false when intentKeywords set but no userIntent provided", () => {
    const trigger: Trigger = { intentKeywords: ["storage"] };
    const ctx = makeCtx();
    expect(matchesTrigger(trigger, ctx)).toBe(false);
  });

  it("matches patternId exactly", () => {
    const trigger: Trigger = { patternId: "static-website" };
    const ctx = makeCtx({ patternId: "static-website" });
    expect(matchesTrigger(trigger, ctx)).toBe(true);
  });

  it("returns false when patternId does not match", () => {
    const trigger: Trigger = { patternId: "static-website" };
    const ctx = makeCtx({ patternId: "api-backend" });
    expect(matchesTrigger(trigger, ctx)).toBe(false);
  });

  it("uses AND logic for multiple conditions", () => {
    const trigger: Trigger = {
      resourceType: "AWS::S3::Bucket",
      intentKeywords: ["storage"],
    };
    // resourceType matches but intentKeywords don't
    const ctx = makeCtx({
      resourceType: "AWS::S3::Bucket",
      userIntent: "Create a database",
    });
    expect(matchesTrigger(trigger, ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — check type: equals
// ---------------------------------------------------------------------------

describe("evaluateTriggers — equals", () => {
  it("fires when field does not equal expected value (check FAILS)", () => {
    const bp = makeBP({ check_type: "equals", expected_value: true });
    const ctx = makeCtx({
      desiredState: {
        PublicAccessBlockConfiguration: { BlockPublicAcls: false },
      },
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-TEST-001");
    expect(findings[0]!.severity).toBe("HIGH");
  });

  it("does NOT fire when field equals expected value (check PASSES)", () => {
    const bp = makeBP({ check_type: "equals", expected_value: true });
    const ctx = makeCtx({
      desiredState: {
        PublicAccessBlockConfiguration: { BlockPublicAcls: true },
      },
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });

  it("fires when field is missing (undefined !== expected)", () => {
    const bp = makeBP({ check_type: "equals", expected_value: true });
    const ctx = makeCtx({ desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — check type: not_equals
// ---------------------------------------------------------------------------

describe("evaluateTriggers — not_equals", () => {
  it("fires when field matches the unwanted value", () => {
    const bp = makeBP({
      check_type: "not_equals",
      expected_value: "DISABLED",
      property_path: "Encryption",
    });
    const ctx = makeCtx({ desiredState: { Encryption: "DISABLED" } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("does NOT fire when field is different from unwanted value", () => {
    const bp = makeBP({
      check_type: "not_equals",
      expected_value: "DISABLED",
      property_path: "Encryption",
    });
    const ctx = makeCtx({ desiredState: { Encryption: "AES256" } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — check type: exists
// ---------------------------------------------------------------------------

describe("evaluateTriggers — exists", () => {
  it("fires when field is missing from config", () => {
    const bp = makeBP({
      check_type: "exists",
      property_path: "EncryptionConfiguration",
    });
    const ctx = makeCtx({ desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("does NOT fire when field exists", () => {
    const bp = makeBP({
      check_type: "exists",
      property_path: "EncryptionConfiguration",
    });
    const ctx = makeCtx({
      desiredState: { EncryptionConfiguration: { Algorithm: "AES256" } },
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — check type: not_exists
// ---------------------------------------------------------------------------

describe("evaluateTriggers — not_exists", () => {
  it("fires when field unexpectedly exists", () => {
    const bp = makeBP({
      check_type: "not_exists",
      property_path: "PublicAccess",
    });
    const ctx = makeCtx({ desiredState: { PublicAccess: true } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("does NOT fire when field is absent", () => {
    const bp = makeBP({
      check_type: "not_exists",
      property_path: "PublicAccess",
    });
    const ctx = makeCtx({ desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — check type: greater_than / less_than
// ---------------------------------------------------------------------------

describe("evaluateTriggers — greater_than", () => {
  it("fires when field is NOT greater than expected", () => {
    const bp = makeBP({
      check_type: "greater_than",
      expected_value: 90,
      property_path: "RetentionDays",
    });
    const ctx = makeCtx({ desiredState: { RetentionDays: 30 } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("does NOT fire when field IS greater than expected", () => {
    const bp = makeBP({
      check_type: "greater_than",
      expected_value: 90,
      property_path: "RetentionDays",
    });
    const ctx = makeCtx({ desiredState: { RetentionDays: 180 } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });

  it("fires when field is non-numeric (surfaces misconfiguration)", () => {
    const bp = makeBP({
      check_type: "greater_than",
      expected_value: 90,
      property_path: "RetentionDays",
    });
    const ctx = makeCtx({ desiredState: { RetentionDays: "not-a-number" } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });
});

describe("evaluateTriggers — less_than", () => {
  it("fires when field is NOT less than expected", () => {
    const bp = makeBP({
      check_type: "less_than",
      expected_value: 5,
      property_path: "MaxRetries",
    });
    const ctx = makeCtx({ desiredState: { MaxRetries: 10 } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("does NOT fire when field IS less than expected", () => {
    const bp = makeBP({
      check_type: "less_than",
      expected_value: 5,
      property_path: "MaxRetries",
    });
    const ctx = makeCtx({ desiredState: { MaxRetries: 2 } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — resourceType filtering
// ---------------------------------------------------------------------------

describe("evaluateTriggers — resourceType filtering", () => {
  it("returns empty findings when resource type does not match", () => {
    const bp = makeBP({ resource_type: "AWS::EC2::Instance" });
    const ctx = makeCtx({ resourceType: "AWS::S3::Bucket" });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — triggers array
// ---------------------------------------------------------------------------

describe("evaluateTriggers — triggers array", () => {
  it("practice with always:true trigger fires for matching resource type", () => {
    const bp = makeBP({
      property_path: "SomeField",
      check_type: "exists",
      triggers: [{ resourceType: "AWS::S3::Bucket", always: true }],
    });
    const ctx = makeCtx({ desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("practice with always:true trigger does not fire for non-matching resource type", () => {
    const bp = makeBP({
      triggers: [{ resourceType: "AWS::EC2::Instance", always: true }],
    });
    const ctx = makeCtx({ resourceType: "AWS::S3::Bucket", desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });

  it("intentKeywords trigger fires when keyword present in userIntent", () => {
    const bp = makeBP({
      property_path: "Versioning",
      check_type: "exists",
      triggers: [
        {
          resourceType: "AWS::S3::Bucket",
          intentKeywords: ["backup", "archive"],
        },
      ],
    });
    const ctx = makeCtx({
      userIntent: "I want to create a backup bucket",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("intentKeywords trigger does not fire when no keyword matches", () => {
    const bp = makeBP({
      property_path: "Versioning",
      check_type: "exists",
      triggers: [
        {
          resourceType: "AWS::S3::Bucket",
          intentKeywords: ["backup", "archive"],
        },
      ],
    });
    const ctx = makeCtx({
      userIntent: "Create a simple website hosting bucket",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });

  it("practice without triggers array falls back to resource_type match", () => {
    const bp = makeBP({ resource_type: "AWS::S3::Bucket" });
    // bp has no triggers field
    const ctx = makeCtx({
      resourceType: "AWS::S3::Bucket",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    // Should fire because BlockPublicAcls is missing (equals check fails)
    expect(findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — edge cases
// ---------------------------------------------------------------------------

describe("evaluateTriggers — edge cases", () => {
  it("returns empty array for empty practices list", () => {
    const ctx = makeCtx({ desiredState: { foo: "bar" } });
    const findings = evaluateTriggers(ctx, []);
    expect(findings).toHaveLength(0);
  });

  it("handles nested property_path traversal (3+ levels deep)", () => {
    const bp = makeBP({
      property_path: "Level1.Level2.Level3.Value",
      check_type: "equals",
      expected_value: "secure",
    });
    const ctx = makeCtx({
      desiredState: {
        Level1: { Level2: { Level3: { Value: "insecure" } } },
      },
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("handles deeply nested property_path that passes", () => {
    const bp = makeBP({
      property_path: "Level1.Level2.Level3.Value",
      check_type: "equals",
      expected_value: "secure",
    });
    const ctx = makeCtx({
      desiredState: {
        Level1: { Level2: { Level3: { Value: "secure" } } },
      },
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });

  it("builds correct finding shape", () => {
    const bp = makeBP({
      id: "BP-S3-001",
      title: "Block public ACLs",
      severity: "CRITICAL",
      category: "security",
      description: "Public ACLs are bad",
      remediation: "Set BlockPublicAcls to true",
    });
    const ctx = makeCtx({ desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.practiceId).toBe("BP-S3-001");
    expect(f.title).toBe("Block public ACLs");
    expect(f.severity).toBe("CRITICAL");
    expect(f.category).toBe("security");
    expect(f.message).toBe("Public ACLs are bad");
    expect(f.remediation).toBe("Set BlockPublicAcls to true");
    expect(f.blocking).toBe(false);
  });

  it("propagates blocking: true from practice to finding", () => {
    const bp = makeBP({
      id: "BP-S3-001",
      title: "Blocking rule",
      blocking: true,
    });
    const ctx = makeCtx({ desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.blocking).toBe(true);
  });

  it("defaults blocking to false when not set on practice", () => {
    const bp = makeBP(); // no blocking field
    const ctx = makeCtx({ desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.blocking).toBe(false);
  });

  it("contains check: fieldValue is undefined → should fail (finding fires)", () => {
    const bp = makeBP({
      check_type: "contains",
      expected_value: "something",
      property_path: "Tags",
    });
    const ctx = makeCtx({ desiredState: {} }); // Tags is undefined

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-TEST-001");
  });

  it("contains check: fieldValue is array of objects, expectedValue is structurally equal object → should pass", () => {
    const bp = makeBP({
      check_type: "contains",
      expected_value: { Key: "Environment", Value: "prod" },
      property_path: "Tags",
    });
    const ctx = makeCtx({
      desiredState: {
        Tags: [
          { Key: "Name", Value: "my-bucket" },
          { Key: "Environment", Value: "prod" },
        ],
      },
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0); // check passes, no finding
  });

  it("not_contains check: fieldValue is array with structurally equal object → should fail (finding fires)", () => {
    const bp = makeBP({
      check_type: "not_contains",
      expected_value: { Key: "PublicAccess", Value: "true" },
      property_path: "Tags",
    });
    const ctx = makeCtx({
      desiredState: {
        Tags: [{ Key: "PublicAccess", Value: "true" }],
      },
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1); // not_contains fails → finding fires
  });

  it("conditional_forbidden: fieldValue is null → should pass (null treated as absent)", () => {
    const bp = makeBP({
      check_type: "conditional_forbidden",
      property_path: "PublicAccess",
    });
    const ctx = makeCtx({
      desiredState: { PublicAccess: null },
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0); // null is treated as absent → passes
  });

  it("greater_than: expectedValue is undefined → should fail (finding fires)", () => {
    const bp = makeBP({
      check_type: "greater_than",
      expected_value: undefined,
      property_path: "RetentionDays",
    });
    const ctx = makeCtx({ desiredState: { RetentionDays: 90 } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1); // undefined expected is a config error → finding fires
  });

  it("less_than: expectedValue is undefined → should fail (finding fires)", () => {
    const bp = makeBP({
      check_type: "less_than",
      expected_value: undefined,
      property_path: "MaxRetries",
    });
    const ctx = makeCtx({ desiredState: { MaxRetries: 2 } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1); // undefined expected is a config error → finding fires
  });

  it("uses fallback message when description is undefined", () => {
    const bp = makeBP({
      description: undefined,
      title: "My Rule",
      property_path: "Foo",
      check_type: "exists",
      expected_value: undefined,
    });
    const ctx = makeCtx({ desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toBe(
      "My Rule — expected Foo exists undefined",
    );
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — Story 35.5/35.7 field propagation to BPFinding
// ---------------------------------------------------------------------------

describe("evaluateTriggers — BPFinding field propagation (Stories 35.5, 35.7)", () => {
  it("P0-4. propagates propertyPath from BP to BPFinding (Story 35.5)", () => {
    // Dot-notation path
    const bp1 = makeBP({
      property_path: "PublicAccessBlockConfiguration.BlockPublicAcls",
      check_type: "equals",
      expected_value: true,
    });
    const ctx1 = makeCtx({ desiredState: {} });
    const findings1 = evaluateTriggers(ctx1, [bp1]);
    expect(findings1).toHaveLength(1);
    expect(findings1[0]!.propertyPath).toBe(
      "PublicAccessBlockConfiguration.BlockPublicAcls",
    );

    // Array-notation path
    const bp2 = makeBP({
      id: "BP-EC2-003",
      resource_type: "AWS::EC2::Instance",
      property_path: "BlockDeviceMappings[0].Ebs.Encrypted",
      check_type: "equals",
      expected_value: true,
    });
    const ctx2 = makeCtx({
      resourceType: "AWS::EC2::Instance",
      desiredState: {},
    });
    const findings2 = evaluateTriggers(ctx2, [bp2]);
    expect(findings2).toHaveLength(1);
    expect(findings2[0]!.propertyPath).toBe(
      "BlockDeviceMappings[0].Ebs.Encrypted",
    );
  });

  it("P0-5. propagates fix_hint to BPFinding.fixHint (Story 35.7)", () => {
    // With fix_hint set
    const bp = makeBP({
      fix_hint:
        "Enable versioning in the S3 console under Properties > Bucket Versioning",
      check_type: "exists",
      property_path: "VersioningConfiguration.Status",
    });
    const ctx = makeCtx({ desiredState: {} });
    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fixHint).toBe(
      "Enable versioning in the S3 console under Properties > Bucket Versioning",
    );

    // Without fix_hint — fixHint should be undefined (not null, not empty string)
    const bpNoHint = makeBP({
      check_type: "exists",
      property_path: "EncryptionConfiguration",
    });
    const ctxNoHint = makeCtx({ desiredState: {} });
    const findingsNoHint = evaluateTriggers(ctxNoHint, [bpNoHint]);
    expect(findingsNoHint).toHaveLength(1);
    expect(findingsNoHint[0]!.fixHint).toBeUndefined();
  });

  it("P0-6. propagates fixType and interactiveOptions to BPFinding", () => {
    const bp = makeBP({
      fixType: "interactive",
      interactiveOptions: [
        {
          label: "IMDSv2 (recommended)",
          action: "prompt_value" as const,
          targetField: "HttpTokens",
        },
        { label: "Skip", action: "skip" as const },
      ],
      property_path: "MetadataOptions.HttpTokens",
      check_type: "equals",
      expected_value: "required",
    });
    const ctx = makeCtx({ desiredState: {} });
    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fixType).toBe("interactive");
    expect(findings[0]!.interactiveOptions).toHaveLength(2);
    expect(findings[0]!.interactiveOptions![0]!.label).toBe(
      "IMDSv2 (recommended)",
    );
    expect(findings[0]!.interactiveOptions![0]!.action).toBe("prompt_value");
    expect(findings[0]!.interactiveOptions![0]!.targetField).toBe("HttpTokens");
    expect(findings[0]!.interactiveOptions![1]!.label).toBe("Skip");
    expect(findings[0]!.interactiveOptions![1]!.action).toBe("skip");

    // Without fixType — should be undefined
    const bpNoFix = makeBP({
      check_type: "exists",
      property_path: "SomeField",
    });
    const ctxNoFix = makeCtx({ desiredState: {} });
    const findingsNoFix = evaluateTriggers(ctxNoFix, [bpNoFix]);
    expect(findingsNoFix).toHaveLength(1);
    expect(findingsNoFix[0]!.fixType).toBeUndefined();
    expect(findingsNoFix[0]!.interactiveOptions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P2-4: autoFixable + desiredStatePatch propagation in buildFinding
// ---------------------------------------------------------------------------

describe("evaluateTriggers — autoFixable and desiredStatePatch propagation (P2-4)", () => {
  it("propagates autoFixable=true and desiredStatePatch when set on BP", () => {
    const bp = makeBP({
      autoFixable: true,
      desiredStatePatch: {
        PublicAccessBlockConfiguration: { BlockPublicAcls: true },
      },
      check_type: "equals",
      expected_value: true,
      property_path: "PublicAccessBlockConfiguration.BlockPublicAcls",
    });
    const ctx = makeCtx({ desiredState: {} });
    const findings = evaluateTriggers(ctx, [bp]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.autoFixable).toBe(true);
    expect(findings[0]!.desiredStatePatch).toEqual({
      PublicAccessBlockConfiguration: { BlockPublicAcls: true },
    });
  });

  it("does not set autoFixable when BP.autoFixable is undefined", () => {
    const bp = makeBP({
      // autoFixable not set (undefined)
      check_type: "exists",
      property_path: "SomeField",
    });
    const ctx = makeCtx({ desiredState: {} });
    const findings = evaluateTriggers(ctx, [bp]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.autoFixable).toBeUndefined();
    expect(findings[0]!.desiredStatePatch).toBeUndefined();
  });

  it("does not set autoFixable when BP.autoFixable is false", () => {
    const bp = makeBP({
      autoFixable: false,
      desiredStatePatch: { ShouldNotAppear: true },
      check_type: "exists",
      property_path: "MissingField",
    });
    const ctx = makeCtx({ desiredState: {} });
    const findings = evaluateTriggers(ctx, [bp]);

    expect(findings).toHaveLength(1);
    // autoFixable is false (falsy) so buildFinding should NOT copy it or desiredStatePatch
    expect(findings[0]!.autoFixable).toBeUndefined();
    expect(findings[0]!.desiredStatePatch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P2-5: awareness check_type always fires (returns false from checkPasses)
// ---------------------------------------------------------------------------

describe("evaluateTriggers — awareness check_type always fires (P2-5)", () => {
  it("awareness check_type fires regardless of field value", () => {
    const bp = makeBP({
      check_type: "awareness",
      property_path: "SomeField",
      expected_value: undefined,
    });
    // Even when the field exists and matches, awareness should still fire
    const ctx = makeCtx({ desiredState: { SomeField: "any-value" } });
    const findings = evaluateTriggers(ctx, [bp]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-TEST-001");
  });

  it("awareness check_type fires even when field is missing", () => {
    const bp = makeBP({
      check_type: "awareness",
      property_path: "MissingField",
      expected_value: undefined,
    });
    const ctx = makeCtx({ desiredState: {} });
    const findings = evaluateTriggers(ctx, [bp]);

    expect(findings).toHaveLength(1);
  });

  it("cross_resource_count check_type always fires (same as awareness)", () => {
    const bp = makeBP({
      check_type: "cross_resource_count",
      property_path: "SomeField",
      expected_value: 3,
    });
    const ctx = makeCtx({ desiredState: { SomeField: 3 } });
    const findings = evaluateTriggers(ctx, [bp]);

    // Even though field value matches expected, cross_resource_count always fires
    expect(findings).toHaveLength(1);
  });

  it("cross_resource_reference check_type always fires", () => {
    const bp = makeBP({
      check_type: "cross_resource_reference",
      property_path: "RoleArn",
      expected_value: "some-arn",
    });
    const ctx = makeCtx({ desiredState: { RoleArn: "some-arn" } });
    const findings = evaluateTriggers(ctx, [bp]);

    expect(findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — excludePatterns (pattern-level suppression)
// ---------------------------------------------------------------------------

describe("evaluateTriggers — excludePatterns", () => {
  it("suppresses rule when context patternId matches an excludePattern", () => {
    const bp = makeBP({
      id: "BP-S3-009",
      property_path: "NotificationConfiguration",
      check_type: "exists",
      triggers: [{ excludePatterns: ["static-website"] }],
    });
    const ctx = makeCtx({
      patternId: "static-website",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });

  it("does NOT suppress rule when context patternId is not in excludePatterns", () => {
    const bp = makeBP({
      id: "BP-S3-009",
      property_path: "NotificationConfiguration",
      check_type: "exists",
      triggers: [{ excludePatterns: ["static-website"] }],
    });
    const ctx = makeCtx({
      patternId: "api-backend",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("does NOT suppress rule when context has no patternId", () => {
    const bp = makeBP({
      id: "BP-S3-009",
      property_path: "NotificationConfiguration",
      check_type: "exists",
      triggers: [{ excludePatterns: ["static-website"] }],
    });
    const ctx = makeCtx({ desiredState: {} });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("suppresses when excludePatterns contains multiple entries and one matches", () => {
    const bp = makeBP({
      id: "BP-S3-017",
      property_path: "LoggingConfiguration",
      check_type: "exists",
      triggers: [{ excludePatterns: ["static-website", "cdn-origin"] }],
    });
    const ctx = makeCtx({
      patternId: "cdn-origin",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });

  it("excludePatterns on one trigger suppresses even if another trigger would match", () => {
    const bp = makeBP({
      id: "BP-S3-011",
      property_path: "BucketPolicy.Statement",
      check_type: "awareness",
      triggers: [
        { excludePatterns: ["static-website"] },
        { resourceType: "AWS::S3::Bucket", always: true },
      ],
    });
    const ctx = makeCtx({
      patternId: "static-website",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers — resource_type always checked first
// ---------------------------------------------------------------------------

describe("evaluateTriggers — resource_type always checked first", () => {
  it("returns 0 findings when resource type does not match, even with excludePatterns trigger", () => {
    const bp = makeBP({
      id: "BP-S3-009",
      resource_type: "AWS::S3::Bucket",
      property_path: "NotificationConfiguration",
      check_type: "exists",
      triggers: [{ excludePatterns: ["static-website"] }],
    });
    const ctx = makeCtx({
      resourceType: "AWS::SSM::Parameter",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });

  it("returns 1 finding when resource type matches and excludePattern is not matched", () => {
    const bp = makeBP({
      id: "BP-S3-009",
      resource_type: "AWS::S3::Bucket",
      property_path: "NotificationConfiguration",
      check_type: "exists",
      triggers: [{ excludePatterns: ["static-website"] }],
    });
    const ctx = makeCtx({
      resourceType: "AWS::S3::Bucket",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(1);
  });

  it("returns 0 findings when resource type matches but patternId is excluded", () => {
    const bp = makeBP({
      id: "BP-S3-009",
      resource_type: "AWS::S3::Bucket",
      property_path: "NotificationConfiguration",
      check_type: "exists",
      triggers: [{ excludePatterns: ["static-website"] }],
    });
    const ctx = makeCtx({
      resourceType: "AWS::S3::Bucket",
      patternId: "static-website",
      desiredState: {},
    });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Performance test
// ---------------------------------------------------------------------------

describe("evaluateTriggers — performance", () => {
  it("evaluates 50 practices in <10ms", () => {
    // Create 50 synthetic practices
    const practices: BestPractice[] = [];
    for (let i = 0; i < 50; i++) {
      practices.push(
        makeBP({
          id: `BP-PERF-${String(i).padStart(3, "0")}`,
          property_path: `Config.Field${i}`,
          check_type: i % 2 === 0 ? "equals" : "exists",
          expected_value: i % 2 === 0 ? true : undefined,
        }),
      );
    }

    // Build a context with some matching fields
    const desiredState: Record<string, unknown> = {
      Config: Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`Field${i * 2}`, true]),
      ),
    };
    const ctx = makeCtx({ desiredState });

    // Warm up
    evaluateTriggers(ctx, practices);

    // Measure
    const start = performance.now();
    const findings = evaluateTriggers(ctx, practices);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
    // Verify we get some findings (sanity check that evaluation actually ran)
    expect(findings.length).toBeGreaterThan(0);
  });
});
