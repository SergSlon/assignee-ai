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

  it("does NOT fire when field is non-numeric (safe default)", () => {
    const bp = makeBP({
      check_type: "greater_than",
      expected_value: 90,
      property_path: "RetentionDays",
    });
    const ctx = makeCtx({ desiredState: { RetentionDays: "not-a-number" } });

    const findings = evaluateTriggers(ctx, [bp]);
    expect(findings).toHaveLength(0);
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
