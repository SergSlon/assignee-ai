import { describe, it, expect } from "vitest";
import { sqsQueuePlugin } from "./sqs-queue.js";

describe("sqsQueuePlugin", () => {
  it("has the correct resourceType", () => {
    expect(sqsQueuePlugin.resourceType).toBe("AWS::SQS::Queue");
  });

  it("commonFields count is ≤10", () => {
    expect(sqsQueuePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 5", () => {
    expect(sqsQueuePlugin.commonFields.length).toBe(5);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of sqsQueuePlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  describe("QueueName validation", () => {
    const field = sqsQueuePlugin.commonFields.find(
      (f) => f.name === "QueueName",
    )!;

    it("accepts empty value (auto-generated)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid queue name", () => {
      expect(field.question.validate?.("my-queue-123")).toBeUndefined();
    });

    it("rejects names longer than 80 chars with length error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("a".repeat(81))).toBe(
        "Queue name must be 1-80 characters",
      );
    });

    it("accepts exactly 80 chars (boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("a".repeat(80))).toBeUndefined();
    });

    it("rejects names with special characters with charset error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("my queue!")).toBe(
        "Queue name can only contain alphanumeric characters, hyphens, and underscores",
      );
    });
  });

  it("FifoQueue is a boolean field", () => {
    // Tier C: strengthened — find!() + toMatchObject
    const field = sqsQueuePlugin.commonFields.find(
      (f) => f.name === "FifoQueue",
    )!;
    expect(field).toMatchObject({
      name: "FifoQueue",
      question: { type: "boolean", initialValue: false },
    });
  });

  it("MessageRetentionPeriod is an enum with 5 options", () => {
    // Tier C: strengthened
    const field = sqsQueuePlugin.commonFields.find(
      (f) => f.name === "MessageRetentionPeriod",
    )!;
    expect(field.question.type).toBe("enum");
    expect(field.question.options).toHaveLength(5);
  });

  it("Tags field has callable toCfn transform", () => {
    // Tier C: strengthened — function-ness check
    const field = sqsQueuePlugin.commonFields.find((f) => f.name === "Tags")!;
    expect(typeof field.toCfn).toBe("function");
  });

  describe("Tags toCfn transform", () => {
    const field = sqsQueuePlugin.commonFields.find((f) => f.name === "Tags")!;

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

  it("advancedFields contains delay, size, KMS, and DLQ fields", () => {
    const names = sqsQueuePlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("DelaySeconds");
    expect(names).toContain("MaximumMessageSize");
    expect(names).toContain("KmsMasterKeyId");
    expect(names).toContain("RedrivePolicy");
  });

  describe("RedrivePolicy toCfn transform", () => {
    const field = sqsQueuePlugin.advancedFields.find(
      (f) => f.name === "RedrivePolicy",
    )!;

    it("transforms ARN to DLQ policy object", () => {
      const arn = "arn:aws:sqs:us-east-1:123456789012:my-dlq";
      expect(field.toCfn!(arn)).toEqual({
        deadLetterTargetArn: arn,
        maxReceiveCount: 3,
      });
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });
});
