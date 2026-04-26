import { describe, it, expect } from "vitest";
import { logGroupPlugin } from "./logs-loggroup.js";

describe("logGroupPlugin", () => {
  it("has the correct resourceType", () => {
    expect(logGroupPlugin.resourceType).toBe("AWS::Logs::LogGroup");
  });

  it("commonFields count is ≤10", () => {
    expect(logGroupPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count matches expected 4 fields", () => {
    expect(logGroupPlugin.commonFields.length).toBe(4);
  });

  it("commonFields contain expected field names", () => {
    const names = logGroupPlugin.commonFields.map((f) => f.name);
    expect(names).toContain("LogGroupName");
    expect(names).toContain("RetentionInDays");
    expect(names).toContain("KmsKeyId");
    expect(names).toContain("Tags");
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of logGroupPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("advancedFields count matches expected 2 fields", () => {
    expect(logGroupPlugin.advancedFields.length).toBe(2);
  });

  it("advancedFields contain expected field names", () => {
    const names = logGroupPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("LogGroupClass");
    expect(names).toContain("DataProtectionPolicy");
  });

  describe("RetentionInDays field", () => {
    const field = logGroupPlugin.commonFields.find(
      (f) => f.name === "RetentionInDays",
    )!;

    it("is an enum type", () => {
      expect(field.question.type).toBe("enum");
    });

    it("defaults to 30", () => {
      expect(field.question.initialValue).toBe("30");
    });

    it("includes all 22 valid retention values (21 numeric + never)", () => {
      const values = field.question.options!.map((o) => o.value);
      expect(values).toHaveLength(22);
      // All valid AWS retention values
      const expected = [
        "1",
        "3",
        "5",
        "7",
        "14",
        "30",
        "60",
        "90",
        "120",
        "150",
        "180",
        "365",
        "400",
        "545",
        "731",
        "1096",
        "1827",
        "2192",
        "2557",
        "2922",
        "3653",
        "never",
      ];
      for (const val of expected) {
        expect(values).toContain(val);
      }
    });

    it("toCfn converts numeric string to number", () => {
      expect(field.toCfn!("14")).toBe(14);
      expect(field.toCfn!("365")).toBe(365);
    });

    it("toCfn returns undefined for 'never'", () => {
      expect(field.toCfn!("never")).toBeUndefined();
    });

    it("toCfn returns undefined for undefined", () => {
      expect(field.toCfn!(undefined)).toBeUndefined();
    });
  });

  describe("LogGroupName validation", () => {
    const field = logGroupPlugin.commonFields.find(
      (f) => f.name === "LogGroupName",
    )!;

    it("accepts empty value (auto-generated)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid Lambda log group name", () => {
      expect(
        field.question.validate?.("/aws/lambda/my-function"),
      ).toBeUndefined();
    });

    it("accepts valid ECS log group name", () => {
      expect(
        field.question.validate?.("/aws/ecs/my-cluster/my-service"),
      ).toBeUndefined();
    });

    it("rejects names longer than 512 characters with length error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("a".repeat(513))).toBe(
        "Log group name must be 512 characters or fewer",
      );
    });

    it("accepts exactly 512 chars (boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("a".repeat(512))).toBeUndefined();
    });

    it("rejects names with invalid characters with charset error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("my log group!")).toBe(
        "Log group name can only contain alphanumeric characters, underscores, hyphens, slashes, hash signs, and periods",
      );
    });
  });

  it("KmsKeyId uses discover-kms-keys fetcher", () => {
    const field = logGroupPlugin.commonFields.find(
      (f) => f.name === "KmsKeyId",
    )!;
    expect(field.question.type).toBe("enum");
    expect(field.question.fetcher).toBe("discover-kms-keys");
  });

  describe("KmsKeyId validation", () => {
    const field = logGroupPlugin.commonFields.find(
      (f) => f.name === "KmsKeyId",
    )!;

    it("accepts empty value (optional)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid KMS ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
        ),
      ).toBeUndefined();
    });

    it("rejects non-KMS ARN with KMS-format error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("not-an-arn")).toBe(
        "Must be a KMS key ARN (arn:aws:kms:...)",
      );
    });
  });

  describe("Tags toCfn transform", () => {
    const field = logGroupPlugin.commonFields.find((f) => f.name === "Tags")!;

    it("has callable toCfn", () => {
      // Tier C: strengthened — function-ness check
      expect(typeof field.toCfn).toBe("function");
    });

    it("transforms comma-separated tags to CloudFormation format", () => {
      expect(field.toCfn!("env:production, team:backend")).toEqual([
        { Key: "env", Value: "production" },
        { Key: "team", Value: "backend" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  describe("LogGroupClass field", () => {
    const field = logGroupPlugin.advancedFields.find(
      (f) => f.name === "LogGroupClass",
    )!;

    it("is an enum type", () => {
      expect(field.question.type).toBe("enum");
    });

    it("defaults to STANDARD", () => {
      expect(field.question.initialValue).toBe("STANDARD");
    });

    it("has STANDARD and INFREQUENT_ACCESS options", () => {
      const values = field.question.options!.map((o) => o.value);
      expect(values).toContain("STANDARD");
      expect(values).toContain("INFREQUENT_ACCESS");
    });
  });

  it("defaults contain RetentionInDays: 30", () => {
    expect(logGroupPlugin.defaults["RetentionInDays"]).toBe(30);
  });

  it("defaults contain LogGroupClass: STANDARD", () => {
    expect(logGroupPlugin.defaults["LogGroupClass"]).toBe("STANDARD");
  });

  it("has at least 3 configHints (Tier C: was toBeDefined+>0)", () => {
    // Tier C: strengthened — meaningful floor
    expect(logGroupPlugin.configHints).toBeInstanceOf(Array);
    expect(logGroupPlugin.configHints!.length).toBeGreaterThanOrEqual(3);
  });
});
