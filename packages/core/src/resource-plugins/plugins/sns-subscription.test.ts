import { describe, it, expect } from "vitest";
import { snsSubscriptionPlugin } from "./sns-subscription.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";

describe("snsSubscriptionPlugin", () => {
  it("has the correct resourceType", () => {
    expect(snsSubscriptionPlugin.resourceType).toBe(
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
  });

  it("declares Protocol default as 'sqs'", () => {
    expect(snsSubscriptionPlugin.defaults[CfnKey.PROTOCOL]).toBe("sqs");
  });

  it("declares RawMessageDelivery default as false", () => {
    expect(snsSubscriptionPlugin.defaults["RawMessageDelivery"]).toBe(false);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of snsSubscriptionPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("marks TopicArn, Protocol and Endpoint as required (matches CCAPI schema)", () => {
    // CCAPI schema probe (2026-04-09): required=[TopicArn, Protocol],
    // createOnly=[TopicArn, Protocol, Endpoint]. Endpoint is not
    // schema-required but is logically required — subscribing without
    // an endpoint is nonsensical. We mark it required in the plugin
    // so the wizard prompts for it.
    const topicArn = snsSubscriptionPlugin.commonFields.find(
      (f) => f.name === CfnKey.TOPIC_ARN,
    );
    const protocol = snsSubscriptionPlugin.commonFields.find(
      (f) => f.name === CfnKey.PROTOCOL,
    );
    const endpoint = snsSubscriptionPlugin.commonFields.find(
      (f) => f.name === CfnKey.ENDPOINT,
    );
    expect(topicArn?.required).toBe(true);
    expect(protocol?.required).toBe(true);
    expect(endpoint?.required).toBe(true);
  });

  describe("TopicArn validation", () => {
    const field = snsSubscriptionPlugin.commonFields.find(
      (f) => f.name === CfnKey.TOPIC_ARN,
    )!;

    it("rejects empty", () => {
      expect(field.question.validate?.("")).toBe("Topic ARN is required");
    });

    it("accepts a valid standard-partition SNS topic ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws:sns:us-east-1:123456789012:my-topic",
        ),
      ).toBeUndefined();
    });

    it("accepts GovCloud partition ARN (partition-aware)", () => {
      // feedback_partition_aware_arn_matching: detection must cover
      // arn:aws-us-gov: and arn:aws-cn: in addition to arn:aws:.
      expect(
        field.question.validate?.(
          "arn:aws-us-gov:sns:us-gov-west-1:123456789012:gov-topic",
        ),
      ).toBeUndefined();
    });

    it("accepts China partition ARN (partition-aware)", () => {
      expect(
        field.question.validate?.(
          "arn:aws-cn:sns:cn-north-1:123456789012:cn-topic",
        ),
      ).toBeUndefined();
    });

    it("rejects a non-SNS ARN", () => {
      expect(
        field.question.validate?.("arn:aws:sqs:us-east-1:123456789012:queue"),
      ).toMatch(/Must be a valid SNS topic ARN/);
    });

    it("rejects a bare string", () => {
      expect(field.question.validate?.("my-topic")).toMatch(
        /Must be a valid SNS topic ARN/,
      );
    });
  });

  describe("Endpoint validation", () => {
    const field = snsSubscriptionPlugin.commonFields.find(
      (f) => f.name === CfnKey.ENDPOINT,
    )!;

    it("rejects empty", () => {
      expect(field.question.validate?.("")).toBe("Endpoint is required");
    });

    it("rejects whitespace-only", () => {
      expect(field.question.validate?.("   ")).toBe("Endpoint cannot be empty");
    });

    it("accepts an SQS queue ARN (sqs protocol)", () => {
      expect(
        field.question.validate?.(
          "arn:aws:sqs:us-east-1:123456789012:my-queue",
        ),
      ).toBeUndefined();
    });

    it("accepts a Lambda function ARN (lambda protocol)", () => {
      expect(
        field.question.validate?.(
          "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
        ),
      ).toBeUndefined();
    });

    it("accepts an HTTPS webhook URL (https protocol)", () => {
      expect(
        field.question.validate?.("https://example.com/sns-webhook"),
      ).toBeUndefined();
    });

    it("accepts an email address (email protocol)", () => {
      expect(field.question.validate?.("ops@example.com")).toBeUndefined();
    });
  });

  describe("Protocol field", () => {
    const field = snsSubscriptionPlugin.commonFields.find(
      (f) => f.name === CfnKey.PROTOCOL,
    )!;

    it("is an enum with every protocol SNS supports", () => {
      expect(field.question.type).toBe("enum");
      const options =
        field.question.type === "enum" && field.question.options
          ? field.question.options.map((o) => o.value)
          : [];
      // SNS documented protocols (2026): http, https, email, email-json,
      // sms, sqs, lambda, application, firehose.
      expect(options).toEqual(
        expect.arrayContaining([
          "sqs",
          "lambda",
          "https",
          "http",
          "email",
          "email-json",
          "sms",
          "firehose",
          "application",
        ]),
      );
    });
  });

  describe("RedrivePolicy validation", () => {
    const field = snsSubscriptionPlugin.commonFields.find(
      (f) => f.name === "RedrivePolicy",
    )!;

    it("accepts empty (optional field)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid JSON with deadLetterTargetArn pointing at an SQS queue", () => {
      expect(
        field.question.validate?.(
          '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:123456789012:my-dlq"}',
        ),
      ).toBeUndefined();
    });

    it("rejects invalid JSON", () => {
      expect(field.question.validate?.("{not json")).toBe(
        "RedrivePolicy must be valid JSON",
      );
    });

    it("rejects missing deadLetterTargetArn", () => {
      expect(field.question.validate?.('{"foo":"bar"}')).toMatch(
        /deadLetterTargetArn/,
      );
    });

    it("rejects deadLetterTargetArn that is not an SQS ARN", () => {
      expect(
        field.question.validate?.(
          '{"deadLetterTargetArn":"arn:aws:sns:us-east-1:123456789012:topic"}',
        ),
      ).toMatch(/SQS queue ARN/);
    });

    it("accepts deadLetterTargetArn in GovCloud/China partitions", () => {
      expect(
        field.question.validate?.(
          '{"deadLetterTargetArn":"arn:aws-cn:sqs:cn-north-1:123456789012:dlq"}',
        ),
      ).toBeUndefined();
    });

    it("toCfn parses valid JSON into an object", () => {
      const parsed = field.toCfn?.(
        '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:123456789012:dlq"}',
      );
      expect(parsed).toEqual({
        deadLetterTargetArn: "arn:aws:sqs:us-east-1:123456789012:dlq",
      });
    });

    it("toCfn returns undefined for empty input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
      expect(field.toCfn?.("   ")).toBeUndefined();
    });
  });

  describe("FilterPolicy (advanced) validation", () => {
    const field = snsSubscriptionPlugin.advancedFields.find(
      (f) => f.name === "FilterPolicy",
    )!;

    it("accepts empty (optional)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid JSON object", () => {
      expect(
        field.question.validate?.(
          '{"eventType":["order.placed","order.paid"]}',
        ),
      ).toBeUndefined();
    });

    it("rejects invalid JSON", () => {
      expect(field.question.validate?.("not json")).toBe(
        "FilterPolicy must be valid JSON",
      );
    });

    it("rejects JSON that isn't an object", () => {
      expect(field.question.validate?.('"a string"')).toBe(
        "FilterPolicy must be a JSON object",
      );
    });
  });

  describe("SubscriptionRoleArn (advanced) validation", () => {
    const field = snsSubscriptionPlugin.advancedFields.find(
      (f) => f.name === "SubscriptionRoleArn",
    )!;

    it("accepts empty (only needed for firehose protocol)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts a valid IAM role ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws:iam::123456789012:role/sns-firehose-delivery",
        ),
      ).toBeUndefined();
    });

    it("accepts GovCloud IAM role ARN (partition-aware)", () => {
      expect(
        field.question.validate?.(
          "arn:aws-us-gov:iam::123456789012:role/sns-firehose",
        ),
      ).toBeUndefined();
    });

    it("rejects non-IAM ARNs", () => {
      expect(
        field.question.validate?.("arn:aws:sns:us-east-1:123456789012:topic"),
      ).toMatch(/IAM role ARN/);
    });
  });

  describe("configHints", () => {
    it("warns against including Tags (NOT taggable)", () => {
      const hints = snsSubscriptionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/NEVER include Tags/);
      expect(hints).toMatch(/not taggable/i);
    });

    it("documents the createOnly replacement semantics", () => {
      const hints = snsSubscriptionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/createOnly/);
      expect(hints).toMatch(/replace|replacement/i);
    });

    it("recommends RedrivePolicy / DLQ", () => {
      const hints = snsSubscriptionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/RedrivePolicy/);
      expect(hints).toMatch(/dead-letter|DLQ/i);
    });
  });
});
