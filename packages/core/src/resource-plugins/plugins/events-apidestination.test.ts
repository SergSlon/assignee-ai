import { describe, it, expect } from "vitest";
import { eventsApiDestinationPlugin } from "./events-apidestination.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";

describe("eventsApiDestinationPlugin", () => {
  it("has the correct resourceType", () => {
    expect(eventsApiDestinationPlugin.resourceType).toBe(
      RESOURCE_TYPES.EVENTS_API_DESTINATION,
    );
  });

  it("defaults HttpMethod to POST", () => {
    expect(eventsApiDestinationPlugin.defaults["HttpMethod"]).toBe("POST");
  });

  it("marks Name, ConnectionArn, InvocationEndpoint, HttpMethod as required", () => {
    const required = [
      "Name",
      "ConnectionArn",
      "InvocationEndpoint",
      "HttpMethod",
    ];
    for (const name of required) {
      const field = eventsApiDestinationPlugin.commonFields.find(
        (f) => f.name === name,
      );
      expect(field?.required, `${name} must be required`).toBe(true);
    }
  });

  describe("Name validation (createOnly)", () => {
    const field = eventsApiDestinationPlugin.commonFields.find(
      (f) => f.name === "Name",
    )!;

    it("rejects empty", () => {
      expect(field.question.validate?.("")).toBe("Name is required");
    });

    it("accepts valid name", () => {
      expect(
        field.question.validate?.("slack-alerts-destination"),
      ).toBeUndefined();
    });

    it("rejects names longer than 64 chars", () => {
      expect(field.question.validate?.("a".repeat(65))).toMatch(
        /1-64 characters/,
      );
    });

    it("rejects names with disallowed characters", () => {
      expect(field.question.validate?.("my destination")).toMatch(
        /alphanumerics/,
      );
    });
  });

  describe("ConnectionArn validation", () => {
    const field = eventsApiDestinationPlugin.commonFields.find(
      (f) => f.name === "ConnectionArn",
    )!;

    it("rejects empty", () => {
      expect(field.question.validate?.("")).toBe("ConnectionArn is required");
    });

    it("accepts a valid standard-partition connection ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws:events:us-east-1:123456789012:connection/slack-webhook/abcd-1234",
        ),
      ).toBeUndefined();
    });

    it("accepts GovCloud partition connection ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws-us-gov:events:us-gov-west-1:123456789012:connection/gov-conn/efgh",
        ),
      ).toBeUndefined();
    });

    it("accepts China partition connection ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws-cn:events:cn-north-1:123456789012:connection/cn-conn/ijkl",
        ),
      ).toBeUndefined();
    });

    it("rejects non-events ARNs", () => {
      expect(
        field.question.validate?.(
          "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
        ),
      ).toMatch(/valid EventBridge connection ARN/);
    });

    it("rejects events ARNs that are not connections (e.g. rules)", () => {
      expect(
        field.question.validate?.(
          "arn:aws:events:us-east-1:123456789012:rule/my-rule",
        ),
      ).toMatch(/:connection\//);
    });
  });

  describe("InvocationEndpoint validation", () => {
    const field = eventsApiDestinationPlugin.commonFields.find(
      (f) => f.name === "InvocationEndpoint",
    )!;

    it("rejects empty", () => {
      expect(field.question.validate?.("")).toBe(
        "InvocationEndpoint is required",
      );
    });

    it("rejects plain HTTP (not HTTPS)", () => {
      expect(field.question.validate?.("http://example.com/hook")).toBe(
        "InvocationEndpoint must be an HTTPS URL",
      );
    });

    it("accepts a valid HTTPS webhook URL", () => {
      expect(
        field.question.validate?.("https://hooks.slack.com/services/T0/B0/xyz"),
      ).toBeUndefined();
    });

    it("accepts URLs with path-substitution placeholders", () => {
      expect(
        field.question.validate?.(
          "https://api.example.com/users/{user_id}/events",
        ),
      ).toBeUndefined();
    });

    it("rejects URLs shorter than 10 characters", () => {
      expect(field.question.validate?.("https://")).toMatch(/10-2048/);
    });

    it("rejects URLs longer than 2048 characters", () => {
      const long = "https://example.com/" + "a".repeat(2050);
      expect(field.question.validate?.(long)).toMatch(/10-2048/);
    });
  });

  describe("HttpMethod enum", () => {
    const field = eventsApiDestinationPlugin.commonFields.find(
      (f) => f.name === "HttpMethod",
    )!;

    it("covers every standard HTTP verb EventBridge supports", () => {
      expect(field.question.type).toBe("enum");
      const options =
        field.question.type === "enum" && field.question.options
          ? field.question.options.map((o) => o.value)
          : [];
      expect(options).toEqual(
        expect.arrayContaining([
          "POST",
          "PUT",
          "PATCH",
          "GET",
          "DELETE",
          "HEAD",
          "OPTIONS",
        ]),
      );
    });
  });

  describe("InvocationRateLimitPerSecond (advanced) validation", () => {
    const field = eventsApiDestinationPlugin.advancedFields.find(
      (f) => f.name === "InvocationRateLimitPerSecond",
    )!;

    it("accepts empty (defaults to 300)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts 1 (minimum)", () => {
      expect(field.question.validate?.("1")).toBeUndefined();
    });

    it("accepts 300 (maximum)", () => {
      expect(field.question.validate?.("300")).toBeUndefined();
    });

    it("rejects 0", () => {
      expect(field.question.validate?.("0")).toMatch(/between 1 and 300/);
    });

    it("rejects 301 (above max)", () => {
      expect(field.question.validate?.("301")).toMatch(/between 1 and 300/);
    });

    it("rejects floats", () => {
      expect(field.question.validate?.("100.5")).toMatch(/integer/);
    });

    it("rejects non-numeric strings", () => {
      expect(field.question.validate?.("unlimited")).toMatch(/integer/);
    });

    it("toCfn converts valid integer string to number", () => {
      expect(field.toCfn?.("300")).toBe(300);
      expect(field.toCfn?.("1")).toBe(1);
    });

    it("toCfn returns undefined for empty input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
    });
  });

  describe("configHints", () => {
    it("warns Tags must not be included (not taggable)", () => {
      const hints = eventsApiDestinationPlugin.configHints!.join(" ");
      expect(hints).toMatch(/NEVER include Tags/);
      expect(hints).toMatch(/not taggable/i);
    });

    it("enforces HTTPS-only at documentation level", () => {
      const hints = eventsApiDestinationPlugin.configHints!.join(" ");
      expect(hints).toMatch(/HTTPS/);
      expect(hints).toMatch(/http:\/\/|insecure/i);
    });

    it("documents the $0.20 per 1M invocation fee", () => {
      const hints = eventsApiDestinationPlugin.configHints!.join(" ");
      expect(hints).toMatch(/0\.20/);
      expect(hints).toMatch(/1M|million/i);
    });

    it("explains the 300 rate limit cap", () => {
      const hints = eventsApiDestinationPlugin.configHints!.join(" ");
      expect(hints).toMatch(/300/);
      expect(hints).toMatch(/rate limit|caps/i);
    });
  });
});
