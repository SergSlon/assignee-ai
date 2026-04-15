import { describe, it, expect } from "vitest";
import { eventsEventBusPlugin } from "./events-eventbus.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";

// A9 landed without a plugin test file. This file closes that gap
// during the A11 follow-up hygiene pass and also covers the
// A9-hygiene additions (DeadLetterConfig + LogConfig) that fixed
// the BP-EVENTBUS-003 field gap.

describe("eventsEventBusPlugin", () => {
  it("has the correct resourceType", () => {
    expect(eventsEventBusPlugin.resourceType).toBe(
      RESOURCE_TYPES.EVENTS_EVENT_BUS,
    );
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of eventsEventBusPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("all advancedField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of eventsEventBusPlugin.advancedFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  describe("Name validation (required + createOnly)", () => {
    const field = eventsEventBusPlugin.commonFields.find(
      (f) => f.name === "Name",
    )!;

    it("is marked required", () => {
      expect(field.required).toBe(true);
    });

    it("rejects empty", () => {
      expect(field.question.validate?.("")).toBe("Name is required");
    });

    it("accepts valid alphanumeric name", () => {
      expect(field.question.validate?.("orders-events")).toBeUndefined();
    });

    it("accepts name with dots, underscores, hyphens", () => {
      expect(field.question.validate?.("my.bus_v2-final")).toBeUndefined();
    });

    it("rejects the reserved 'default' bus name", () => {
      expect(field.question.validate?.("default")).toMatch(/built-in/);
    });

    it("rejects names longer than 256 characters", () => {
      expect(field.question.validate?.("a".repeat(257))).toMatch(
        /1-256 characters/,
      );
    });

    it("rejects names with spaces", () => {
      expect(field.question.validate?.("my bus")).toMatch(
        /alphanumerics, '\.', '_', '-'/,
      );
    });

    it("rejects names with slashes", () => {
      expect(field.question.validate?.("orders/events")).toMatch(
        /alphanumerics/,
      );
    });
  });

  describe("KmsKeyIdentifier validation", () => {
    const field = eventsEventBusPlugin.commonFields.find(
      (f) => f.name === "KmsKeyIdentifier",
    )!;

    it("accepts empty (AWS-owned key default)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts an alias/aws/events path", () => {
      expect(field.question.validate?.("alias/aws/events")).toBeUndefined();
    });

    it("accepts a full KMS key ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws:kms:us-east-1:123456789012:key/abcd-1234",
        ),
      ).toBeUndefined();
    });

    it("rejects a non-KMS string", () => {
      expect(field.question.validate?.("not-a-kms-ref")).toBeTruthy();
    });
  });

  describe("Tags toCfn", () => {
    const field = eventsEventBusPlugin.commonFields.find(
      (f) => f.name === CfnKey.TAGS,
    )!;

    it("returns undefined for blank input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
      expect(field.toCfn?.("   ")).toBeUndefined();
    });

    it("parses comma-separated key:value pairs", () => {
      expect(field.toCfn?.("env:production, team:platform")).toEqual([
        { Key: "env", Value: "production" },
        { Key: "team", Value: "platform" },
      ]);
    });

    it("preserves colons inside the value", () => {
      expect(field.toCfn?.("uri:https://example.com/path")).toEqual([
        { Key: "uri", Value: "https://example.com/path" },
      ]);
    });

    it("skips malformed entries without a colon", () => {
      expect(field.toCfn?.("valid:yes, bogus, env:prod")).toEqual([
        { Key: "valid", Value: "yes" },
        { Key: "env", Value: "prod" },
      ]);
    });
  });

  describe("Policy (advanced) validation + toCfn", () => {
    const field = eventsEventBusPlugin.advancedFields.find(
      (f) => f.name === "Policy",
    )!;

    it("accepts empty (optional)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid JSON object", () => {
      expect(
        field.question.validate?.('{"Version":"2012-10-17","Statement":[]}'),
      ).toBeUndefined();
    });

    it("rejects invalid JSON", () => {
      expect(field.question.validate?.("{broken")).toBe(
        "Policy must be valid JSON",
      );
    });

    it("rejects JSON that isn't an object", () => {
      expect(field.question.validate?.('"plain string"')).toBe(
        "Policy must be a JSON object",
      );
    });

    it("toCfn parses valid JSON into an object", () => {
      expect(field.toCfn?.('{"Version":"2012-10-17","Statement":[]}')).toEqual({
        Version: "2012-10-17",
        Statement: [],
      });
    });

    it("toCfn returns undefined for invalid JSON", () => {
      expect(field.toCfn?.("{broken")).toBeUndefined();
    });
  });

  describe("DeadLetterConfig (A9 hygiene)", () => {
    const field = eventsEventBusPlugin.advancedFields.find(
      (f) => f.name === "DeadLetterConfig",
    )!;

    it("exists as an advanced field — closes the BP-EVENTBUS-003 gap", () => {
      // Before the A10 follow-up hygiene pass the plugin had NO
      // field for DeadLetterConfig — BP-EVENTBUS-003 required
      // DeadLetterConfig.Arn to exist but there was no way for a
      // wizard user to satisfy the rule. This assertion locks in
      // the fix so a future refactor cannot silently re-open the
      // hole.
      expect(field).toBeDefined();
      expect(field.question.type).toBe("string");
    });

    it("accepts empty (optional — BP rule is advisory, not blocking)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts a valid SQS queue ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws:sqs:us-east-1:123456789012:eventbus-dlq",
        ),
      ).toBeUndefined();
    });

    it("accepts GovCloud / China partition SQS ARNs", () => {
      expect(
        field.question.validate?.(
          "arn:aws-us-gov:sqs:us-gov-west-1:123456789012:gov-dlq",
        ),
      ).toBeUndefined();
      expect(
        field.question.validate?.(
          "arn:aws-cn:sqs:cn-north-1:123456789012:cn-dlq",
        ),
      ).toBeUndefined();
    });

    it("rejects non-SQS ARNs", () => {
      expect(
        field.question.validate?.("arn:aws:sns:us-east-1:123456789012:topic"),
      ).toMatch(/valid SQS queue ARN/);
    });

    it("toCfn wraps the ARN into the { Arn } CFN shape", () => {
      expect(field.toCfn?.("arn:aws:sqs:us-east-1:123456789012:dlq")).toEqual({
        Arn: "arn:aws:sqs:us-east-1:123456789012:dlq",
      });
    });

    it("toCfn returns undefined for blank input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
      expect(field.toCfn?.("   ")).toBeUndefined();
    });

    it("toCfn trims surrounding whitespace", () => {
      expect(
        field.toCfn?.("  arn:aws:sqs:us-east-1:123456789012:dlq  "),
      ).toEqual({ Arn: "arn:aws:sqs:us-east-1:123456789012:dlq" });
    });
  });

  describe("LogConfig (A9 hygiene)", () => {
    const field = eventsEventBusPlugin.advancedFields.find(
      (f) => f.name === "LogConfig",
    )!;

    it("exists as an advanced field", () => {
      expect(field).toBeDefined();
      expect(field.question.type).toBe("enum");
    });

    it("offers NONE + FULL levels", () => {
      const options =
        field.question.type === "enum" && field.question.options
          ? field.question.options.map((o) => o.value)
          : [];
      expect(options).toEqual(expect.arrayContaining(["NONE", "FULL"]));
    });

    it("toCfn returns undefined for NONE (default, zero cost)", () => {
      expect(field.toCfn?.("NONE")).toBeUndefined();
    });

    it("toCfn returns undefined for empty input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
      expect(field.toCfn?.(undefined)).toBeUndefined();
    });

    it("toCfn wraps FULL into the { IncludeDetail } CFN shape", () => {
      expect(field.toCfn?.("FULL")).toEqual({ IncludeDetail: "FULL" });
    });
  });

  describe("configHints", () => {
    it("documents Name as createOnly + the replacement cost", () => {
      const hints = eventsEventBusPlugin.configHints!.join(" ");
      expect(hints).toMatch(/createOnly/);
      expect(hints).toMatch(/replac/i);
    });

    it("documents per-million-events bus-level billing WITHOUT hardcoded prices", () => {
      const hints = eventsEventBusPlugin.configHints!.join(" ");
      // Billing shape must be described but live rates route through the
      // Pricing MCP — see `feedback_no_hardcoded_prices`.
      expect(hints).toMatch(/per-million-events|million events/i);
      expect(hints).toMatch(/assignee cost|Pricing.MCP/i);
      expect(hints).not.toMatch(/\$\d/);
    });

    it("explains the DeadLetterConfig silent-drop failure mode", () => {
      const hints = eventsEventBusPlugin.configHints!.join(" ");
      expect(hints).toMatch(/DeadLetterConfig/);
      expect(hints).toMatch(/silently lost|silent/i);
    });
  });
});
