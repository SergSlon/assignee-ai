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

  describe("VisibilityTimeout field (Epic 92 A-07)", () => {
    const field = sqsQueuePlugin.commonFields.find(
      (f) => f.name === "VisibilityTimeout",
    );

    it("uses the schema-accurate key name 'VisibilityTimeout' (not the stripped alias)", () => {
      // The desired-state-sanitizer strips "VisibilityTimeoutSeconds" because
      // that key is NOT in the AWS::SQS::Queue CCAPI schema. The real key is
      // "VisibilityTimeout" (see test-fixtures/mcp-mock-responses/schema-sqs-queue.ts).
      expect(field).toBeDefined();
      expect(field!.name).toBe("VisibilityTimeout");
    });

    it("has initialValue '30' for the wizard default", () => {
      expect(field!.question.initialValue).toBe("30");
    });

    it("toCfn coerces numeric string to integer", () => {
      expect(field!.toCfn!("30")).toBe(30);
      expect(field!.toCfn!("43200")).toBe(43200);
    });

    it("toCfn returns undefined for non-numeric input", () => {
      // Number("abc") is NaN → undefined. Note: Number("") is 0 (JS
      // coercion quirk); empty inputs are handled upstream by the
      // elicitor (field is skipped entirely) so this path is not a
      // user-facing concern.
      expect(field!.toCfn!("abc")).toBeUndefined();
      expect(field!.toCfn!("not-a-number")).toBeUndefined();
    });

    it("validate rejects values above 43200 (max 12 hours)", () => {
      expect(field!.question.validate?.("43201")).toBe(
        "Must be 0-43200 seconds",
      );
    });

    it("validate rejects negative values", () => {
      expect(field!.question.validate?.("-1")).toBe("Must be 0-43200 seconds");
    });

    it("validate rejects non-integer values", () => {
      expect(field!.question.validate?.("30.5")).toBe(
        "Must be 0-43200 seconds",
      );
    });

    it("validate accepts 0 (boundary)", () => {
      expect(field!.question.validate?.("0")).toBeUndefined();
    });

    it("validate accepts 43200 (boundary)", () => {
      expect(field!.question.validate?.("43200")).toBeUndefined();
    });
  });

  describe("plugin.defaults (Epic 92 A-07)", () => {
    it("declares a default of 30 for VisibilityTimeout (schema-accurate key)", () => {
      // This default survives desired-state-sanitizer because the schema
      // property is "VisibilityTimeout" (not "VisibilityTimeoutSeconds").
      expect(sqsQueuePlugin.defaults["VisibilityTimeout"]).toBe(30);
    });

    it("keeps the SqsManagedSseEnabled default (free SSE-SQS)", () => {
      expect(sqsQueuePlugin.defaults["SqsManagedSseEnabled"]).toBe(true);
    });

    it("does NOT register a default under the legacy broken alias 'VisibilityTimeoutSeconds'", () => {
      // Regression guard: make sure we never re-introduce the
      // sanitizer-stripped key path.
      expect(
        sqsQueuePlugin.defaults["VisibilityTimeoutSeconds"],
      ).toBeUndefined();
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
      const arn = "arn:aws:sqs:us-east-1:210987654321:my-dlq";
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
