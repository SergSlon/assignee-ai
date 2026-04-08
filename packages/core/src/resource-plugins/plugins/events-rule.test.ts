import { describe, it, expect } from "vitest";
import { eventsRulePlugin } from "./events-rule.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";

describe("eventsRulePlugin", () => {
  it("has the correct resourceType", () => {
    expect(eventsRulePlugin.resourceType).toBe(RESOURCE_TYPES.EVENTS_RULE);
  });

  it("declares a default State of ENABLED", () => {
    expect(eventsRulePlugin.defaults["State"]).toBe("ENABLED");
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of eventsRulePlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  describe("Name validation (createOnly)", () => {
    const field = eventsRulePlugin.commonFields.find((f) => f.name === "Name")!;

    it("accepts empty (auto-generated)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid name with alphanumerics, dots, underscores, hyphens", () => {
      expect(field.question.validate?.("my-rule.v2_final")).toBeUndefined();
    });

    it("rejects names longer than 64 chars", () => {
      expect(field.question.validate?.("a".repeat(65))).toBe(
        "Rule name must be 1-64 characters",
      );
    });

    it("rejects names with spaces", () => {
      expect(field.question.validate?.("my rule")).toBe(
        "Rule name can only contain alphanumerics, '.', '_', '-'",
      );
    });

    it("rejects names with special characters", () => {
      expect(field.question.validate?.("my/rule")).toBe(
        "Rule name can only contain alphanumerics, '.', '_', '-'",
      );
    });
  });

  describe("ScheduleExpression validation", () => {
    const field = eventsRulePlugin.commonFields.find(
      (f) => f.name === "ScheduleExpression",
    )!;

    it("accepts empty (EventPattern used instead)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts rate(5 minutes)", () => {
      expect(field.question.validate?.("rate(5 minutes)")).toBeUndefined();
    });

    it("accepts rate(1 hour)", () => {
      expect(field.question.validate?.("rate(1 hour)")).toBeUndefined();
    });

    it("accepts rate(7 days)", () => {
      expect(field.question.validate?.("rate(7 days)")).toBeUndefined();
    });

    it("accepts cron expression", () => {
      expect(field.question.validate?.("cron(0 12 * * ? *)")).toBeUndefined();
    });

    it("rejects bare strings that are not rate() or cron()", () => {
      expect(field.question.validate?.("every 5 minutes")).toBe(
        "Must be rate(...) or cron(...)",
      );
    });

    it("rejects rate(0 minutes)", () => {
      expect(field.question.validate?.("rate(0 minutes)")).toBe(
        "rate() value must be at least 1",
      );
    });
  });

  describe("EventPattern validation", () => {
    const field = eventsRulePlugin.commonFields.find(
      (f) => f.name === "EventPattern",
    )!;

    it("accepts empty (ScheduleExpression used instead)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts a valid JSON object pattern", () => {
      expect(
        field.question.validate?.('{"source":["aws.s3"]}'),
      ).toBeUndefined();
    });

    it("rejects invalid JSON", () => {
      expect(field.question.validate?.("{source: [aws.s3]}")).toBe(
        "Event pattern must be valid JSON",
      );
    });

    it("rejects JSON that is not an object", () => {
      expect(field.question.validate?.('"a string"')).toBe(
        "Event pattern must be a JSON object",
      );
    });

    it("rejects JSON null", () => {
      expect(field.question.validate?.("null")).toBe(
        "Event pattern must be a JSON object",
      );
    });

    it("toCfn parses a valid pattern into an object", () => {
      const result = field.toCfn?.(
        '{"source":["aws.s3"],"detail-type":["Object Created"]}',
      );
      expect(result).toEqual({
        source: ["aws.s3"],
        "detail-type": ["Object Created"],
      });
    });

    it("toCfn returns undefined for empty input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
    });

    it("toCfn returns undefined for invalid JSON (toCfn is permissive — validator handles UX)", () => {
      expect(field.toCfn?.("not json")).toBeUndefined();
    });
  });

  describe("State enum", () => {
    const field = eventsRulePlugin.commonFields.find(
      (f) => f.name === "State",
    )!;

    it("only permits ENABLED or DISABLED", () => {
      if (field.question.type !== "enum") throw new Error("expected enum");
      const values = (field.question.options ?? []).map((o) => o.value);
      expect(values).toEqual(["ENABLED", "DISABLED"]);
    });

    it("initialValue is ENABLED", () => {
      if (field.question.type !== "enum") throw new Error("expected enum");
      expect(field.question.initialValue).toBe("ENABLED");
    });
  });

  describe("RoleArn validation (advanced)", () => {
    const field = eventsRulePlugin.advancedFields.find(
      (f) => f.name === "RoleArn",
    )!;

    it("accepts empty (optional)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts a standard IAM role ARN", () => {
      expect(
        field.question.validate?.("arn:aws:iam::123456789012:role/my-role"),
      ).toBeUndefined();
    });

    it("accepts a GovCloud IAM role ARN (partition-aware)", () => {
      expect(
        field.question.validate?.(
          "arn:aws-us-gov:iam::123456789012:role/my-role",
        ),
      ).toBeUndefined();
    });

    it("rejects a malformed ARN", () => {
      expect(field.question.validate?.("role/my-role")).toBe(
        "Must be an IAM role ARN",
      );
    });

    it("rejects an SNS topic ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws:sns:us-east-1:123456789012:my-topic",
        ),
      ).toBe("Must be an IAM role ARN");
    });
  });

  describe("EventBusName field", () => {
    const field = eventsRulePlugin.advancedFields.find(
      (f) => f.name === "EventBusName",
    )!;

    it("defaults to 'default' via initialValue", () => {
      if (field.question.type !== "string") throw new Error("expected string");
      expect(field.question.initialValue).toBe("default");
    });
  });

  describe("configHints", () => {
    it("warns about required EventPattern xor ScheduleExpression", () => {
      const hints = (eventsRulePlugin.configHints ?? []).join("\n");
      expect(hints).toMatch(/EITHER a ScheduleExpression OR an EventPattern/);
    });

    it("warns about the need for at least one Target", () => {
      const hints = (eventsRulePlugin.configHints ?? []).join("\n");
      expect(hints).toMatch(/at least one Target/);
    });

    it("warns about custom bus pricing", () => {
      const hints = (eventsRulePlugin.configHints ?? []).join("\n");
      expect(hints).toMatch(/Custom event buses bill/);
    });

    it("warns about Name being createOnly", () => {
      const hints = (eventsRulePlugin.configHints ?? []).join("\n");
      expect(hints).toMatch(/Name is createOnly/);
    });
  });
});
