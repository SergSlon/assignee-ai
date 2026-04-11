import { describe, it, expect } from "vitest";
import { snsTopicPlugin } from "./sns-topic.js";

describe("snsTopicPlugin", () => {
  it("has the correct resourceType", () => {
    expect(snsTopicPlugin.resourceType).toBe("AWS::SNS::Topic");
  });

  it("commonFields count is ≤10", () => {
    expect(snsTopicPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 5", () => {
    expect(snsTopicPlugin.commonFields.length).toBe(5);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of snsTopicPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  describe("TopicName validation", () => {
    const field = snsTopicPlugin.commonFields.find(
      (f) => f.name === "TopicName",
    )!;

    it("accepts empty value (auto-generated)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid topic name", () => {
      expect(field.question.validate?.("my-topic-123")).toBeUndefined();
    });

    it("rejects names longer than 256 chars with length error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("a".repeat(257))).toBe(
        "Topic name must be 1-256 characters",
      );
    });

    it("accepts exactly 256 chars (boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("a".repeat(256))).toBeUndefined();
    });

    it("rejects names with special characters with charset error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("my topic!")).toBe(
        "Topic name can only contain alphanumeric characters, hyphens, and underscores",
      );
    });
  });

  it("FifoTopic is a boolean field", () => {
    // Tier C: strengthened — find!() + toMatchObject
    const field = snsTopicPlugin.commonFields.find(
      (f) => f.name === "FifoTopic",
    )!;
    expect(field).toMatchObject({
      name: "FifoTopic",
      question: { type: "boolean", initialValue: false },
    });
  });

  it("DisplayName validation rejects > 100 chars with length error", () => {
    // Tier C: strengthened from toBeDefined()
    const field = snsTopicPlugin.commonFields.find(
      (f) => f.name === "DisplayName",
    )!;
    expect(field.question.validate?.("a".repeat(101))).toBe(
      "Display name must be 100 characters or fewer",
    );
    expect(field.question.validate?.("valid name")).toBeUndefined();
    // Boundary
    expect(field.question.validate?.("a".repeat(100))).toBeUndefined();
  });

  it("Tags field has callable toCfn transform", () => {
    // Tier C: strengthened — function-ness check
    const field = snsTopicPlugin.commonFields.find((f) => f.name === "Tags")!;
    expect(typeof field.toCfn).toBe("function");
  });

  describe("Tags toCfn transform", () => {
    const field = snsTopicPlugin.commonFields.find((f) => f.name === "Tags")!;

    it("converts comma-separated Key:Value pairs", () => {
      expect(field.toCfn!("env:prod, team:backend")).toEqual([
        { Key: "env", Value: "prod" },
        { Key: "team", Value: "backend" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  it("advancedFields exposes ContentBasedDeduplication gated on FifoTopic=true", () => {
    // wizard-interaction-matrix (2026-04-11): the SNS "fifo" intent rule
    // pre-populates ContentBasedDeduplication, which requires the field to
    // exist as a user-facing advanced field. It's gated on FifoTopic=true
    // because AWS rejects ContentBasedDeduplication on standard topics.
    expect(snsTopicPlugin.advancedFields).toHaveLength(1);
    const cbd = snsTopicPlugin.advancedFields[0]!;
    expect(cbd.name).toBe("ContentBasedDeduplication");
    expect(cbd.question.type).toBe("boolean");
    expect(cbd.question.showIf).toEqual({ field: "FifoTopic", value: true });
  });

  describe("KmsMasterKeyId validation", () => {
    const field = snsTopicPlugin.commonFields.find(
      (f) => f.name === "KmsMasterKeyId",
    )!;

    it("accepts empty value", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid KMS ARN", () => {
      expect(
        field.question.validate?.("arn:aws:kms:us-east-1:123456789012:key/abc"),
      ).toBeUndefined();
    });

    it("accepts alias format", () => {
      expect(field.question.validate?.("alias/aws/sns")).toBeUndefined();
    });

    it("rejects invalid format with KMS-format error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("not-a-valid-key")).toBe(
        "Must be a KMS key ARN or alias",
      );
    });
  });

  describe("configHints", () => {
    it("has at least 3 configHints (Tier C: was toBeDefined+>0)", () => {
      // Tier C: strengthened — meaningful floor
      expect(snsTopicPlugin.configHints).toBeInstanceOf(Array);
      expect(snsTopicPlugin.configHints!.length).toBeGreaterThanOrEqual(3);
    });

    it("includes guidance about KMS encryption", () => {
      const hints = snsTopicPlugin.configHints!.join(" ");
      expect(hints).toMatch(/KmsMasterKeyId/i);
      expect(hints).toMatch(/encryption/i);
    });
  });
});
