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

    it("rejects names longer than 256 chars", () => {
      expect(field.question.validate?.("a".repeat(257))).toBeDefined();
    });

    it("rejects names with special characters", () => {
      expect(field.question.validate?.("my topic!")).toBeDefined();
    });
  });

  it("FifoTopic is a boolean field", () => {
    const field = snsTopicPlugin.commonFields.find(
      (f) => f.name === "FifoTopic",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("boolean");
    expect(field?.question.initialValue).toBe(false);
  });

  it("DisplayName validation rejects > 100 chars", () => {
    const field = snsTopicPlugin.commonFields.find(
      (f) => f.name === "DisplayName",
    )!;
    expect(field.question.validate?.("a".repeat(101))).toBeDefined();
    expect(field.question.validate?.("valid name")).toBeUndefined();
  });

  it("Tags field has toCfn transform", () => {
    const field = snsTopicPlugin.commonFields.find((f) => f.name === "Tags");
    expect(field?.toCfn).toBeDefined();
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

  it("advancedFields is empty", () => {
    expect(snsTopicPlugin.advancedFields).toHaveLength(0);
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

    it("rejects invalid format", () => {
      expect(field.question.validate?.("not-a-valid-key")).toBeDefined();
    });
  });

  describe("configHints", () => {
    it("has configHints defined", () => {
      expect(snsTopicPlugin.configHints).toBeDefined();
      expect(snsTopicPlugin.configHints!.length).toBeGreaterThan(0);
    });

    it("includes guidance about KMS encryption", () => {
      const hints = snsTopicPlugin.configHints!.join(" ");
      expect(hints).toMatch(/KmsMasterKeyId/i);
      expect(hints).toMatch(/encryption/i);
    });
  });
});
