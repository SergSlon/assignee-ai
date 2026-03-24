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

    it("rejects names longer than 80 chars", () => {
      expect(field.question.validate?.("a".repeat(81))).toBeDefined();
    });

    it("rejects names with special characters", () => {
      expect(field.question.validate?.("my queue!")).toBeDefined();
    });
  });

  it("FifoQueue is a boolean field", () => {
    const field = sqsQueuePlugin.commonFields.find(
      (f) => f.name === "FifoQueue",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("boolean");
    expect(field?.question.initialValue).toBe(false);
  });

  it("MessageRetentionPeriod is an enum with 5 options", () => {
    const field = sqsQueuePlugin.commonFields.find(
      (f) => f.name === "MessageRetentionPeriod",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.options).toHaveLength(5);
  });

  it("Tags field has toCfn transform", () => {
    const field = sqsQueuePlugin.commonFields.find((f) => f.name === "Tags");
    expect(field?.toCfn).toBeDefined();
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
