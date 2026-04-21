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
      expect(field.question.validate?.("a".repeat(257))).toBe(
        "Topic name must be 1-256 characters",
      );
    });

    it("accepts exactly 256 chars (boundary)", () => {
      expect(field.question.validate?.("a".repeat(256))).toBeUndefined();
    });

    it("rejects names with special characters with charset error", () => {
      expect(field.question.validate?.("my topic!")).toBe(
        "Topic name can only contain alphanumeric characters, hyphens, and underscores",
      );
    });
  });

  describe("TopicName toCfn auto-generation (Epic 92 Wave 4.b / A-15)", () => {
    const field = snsTopicPlugin.commonFields.find(
      (f) => f.name === "TopicName",
    )!;
    const AUTO_NAME_PATTERN = /^assignee-sns-topic-[0-9a-f]{8}$/;

    it("auto-generates assignee-sns-topic-<8hex> on empty input", () => {
      const result = field.toCfn!("");
      expect(typeof result).toBe("string");
      expect(result as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("auto-generates on whitespace-only input", () => {
      expect(field.toCfn!("   ") as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("auto-generates on undefined input", () => {
      expect(field.toCfn!(undefined) as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("replaces the literal placeholder 'my-sns-topic' (LLM echo guard)", () => {
      expect(field.toCfn!("my-sns-topic") as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("replaces the literal placeholder 'my-topic'", () => {
      expect(field.toCfn!("my-topic") as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("replaces 'example-topic' / 'example-sns-topic'", () => {
      expect(field.toCfn!("example-topic") as string).toMatch(
        AUTO_NAME_PATTERN,
      );
      expect(field.toCfn!("example-sns-topic") as string).toMatch(
        AUTO_NAME_PATTERN,
      );
    });

    it("preserves user-specified names unchanged", () => {
      expect(field.toCfn!("my-real-business-topic")).toBe(
        "my-real-business-topic",
      );
      expect(field.toCfn!("payments-q3-events")).toBe("payments-q3-events");
    });

    it("strips .fifo suffix on user-provided name (AWS appends it)", () => {
      expect(field.toCfn!("orders.fifo")).toBe("orders");
    });

    it("returns a different auto-name on each call (crypto.randomBytes)", () => {
      const a = field.toCfn!("");
      const b = field.toCfn!("");
      expect(a).not.toBe(b);
    });

    it("defaults[TopicName] getter yields the auto-name pattern", () => {
      const v = snsTopicPlugin.defaults["TopicName"];
      expect(typeof v).toBe("string");
      expect(v as string).toMatch(AUTO_NAME_PATTERN);
      const w = snsTopicPlugin.defaults["TopicName"];
      expect(v).not.toBe(w);
    });
  });

  it("FifoTopic is a boolean field", () => {
    const field = snsTopicPlugin.commonFields.find(
      (f) => f.name === "FifoTopic",
    )!;
    expect(field).toMatchObject({
      name: "FifoTopic",
      question: { type: "boolean", initialValue: false },
    });
  });

  it("DisplayName validation rejects > 100 chars with length error", () => {
    const field = snsTopicPlugin.commonFields.find(
      (f) => f.name === "DisplayName",
    )!;
    expect(field.question.validate?.("a".repeat(101))).toBe(
      "Display name must be 100 characters or fewer",
    );
    expect(field.question.validate?.("valid name")).toBeUndefined();
    expect(field.question.validate?.("a".repeat(100))).toBeUndefined();
  });

  it("Tags field has callable toCfn transform", () => {
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
      expect(field.question.validate?.("not-a-valid-key")).toBe(
        "Must be a KMS key ARN or alias",
      );
    });
  });

  describe("configHints", () => {
    it("has at least 3 configHints (Tier C: was toBeDefined+>0)", () => {
      expect(snsTopicPlugin.configHints).toBeInstanceOf(Array);
      expect(snsTopicPlugin.configHints!.length).toBeGreaterThanOrEqual(3);
    });

    it("includes guidance about KMS encryption", () => {
      const hints = snsTopicPlugin.configHints!.join(" ");
      expect(hints).toMatch(/KmsMasterKeyId/i);
      expect(hints).toMatch(/encryption/i);
    });

    it("includes guidance to OMIT TopicName for auto-generation (A-15)", () => {
      const hints = snsTopicPlugin.configHints!.join(" ");
      expect(hints).toMatch(/TopicName/);
      expect(hints).toMatch(/OMIT|auto-generate/i);
      expect(hints).toMatch(/assignee-sns-topic/);
    });
  });
});
