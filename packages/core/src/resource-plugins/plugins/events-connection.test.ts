import { describe, it, expect } from "vitest";
import { eventsConnectionPlugin } from "./events-connection.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";

describe("eventsConnectionPlugin", () => {
  it("has the correct resourceType", () => {
    expect(eventsConnectionPlugin.resourceType).toBe(
      RESOURCE_TYPES.EVENTS_CONNECTION,
    );
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of eventsConnectionPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("declares API_KEY as the default AuthorizationType", () => {
    expect(eventsConnectionPlugin.defaults["AuthorizationType"]).toBe(
      "API_KEY",
    );
  });

  it("marks Name + AuthorizationType + AuthParameters as required", () => {
    const name = eventsConnectionPlugin.commonFields.find(
      (f) => f.name === "Name",
    );
    const authType = eventsConnectionPlugin.commonFields.find(
      (f) => f.name === "AuthorizationType",
    );
    const authParams = eventsConnectionPlugin.commonFields.find(
      (f) => f.name === "AuthParameters",
    );
    expect(name?.required).toBe(true);
    expect(authType?.required).toBe(true);
    expect(authParams?.required).toBe(true);
  });

  describe("Name validation (createOnly)", () => {
    const field = eventsConnectionPlugin.commonFields.find(
      (f) => f.name === "Name",
    )!;

    it("rejects empty", () => {
      expect(field.question.validate?.("")).toBe("Name is required");
    });

    it("accepts valid alphanumeric with separators", () => {
      expect(
        field.question.validate?.("slack-webhook.v2_prod"),
      ).toBeUndefined();
    });

    it("rejects names longer than 64 chars", () => {
      expect(field.question.validate?.("a".repeat(65))).toMatch(
        /1-64 characters/,
      );
    });

    it("rejects names with spaces or slashes", () => {
      expect(field.question.validate?.("my connection")).toMatch(
        /alphanumerics/,
      );
      expect(field.question.validate?.("my/connection")).toMatch(
        /alphanumerics/,
      );
    });
  });

  describe("AuthorizationType enum", () => {
    const field = eventsConnectionPlugin.commonFields.find(
      (f) => f.name === "AuthorizationType",
    )!;

    it("covers API_KEY, BASIC, OAUTH_CLIENT_CREDENTIALS", () => {
      expect(field.question.type).toBe("enum");
      const options =
        field.question.type === "enum" && field.question.options
          ? field.question.options.map((o) => o.value)
          : [];
      expect(options).toEqual(
        expect.arrayContaining([
          "API_KEY",
          "BASIC",
          "OAUTH_CLIENT_CREDENTIALS",
        ]),
      );
    });
  });

  describe("AuthParameters validation (required + JSON shape)", () => {
    const field = eventsConnectionPlugin.commonFields.find(
      (f) => f.name === "AuthParameters",
    )!;

    it("rejects empty", () => {
      expect(field.question.validate?.("")).toBe("AuthParameters is required");
    });

    it("rejects invalid JSON", () => {
      expect(field.question.validate?.("{not json")).toBe(
        "AuthParameters must be valid JSON",
      );
    });

    it("rejects non-object JSON (arrays)", () => {
      expect(field.question.validate?.('["ApiKey"]')).toBe(
        "AuthParameters must be a JSON object",
      );
    });

    it("rejects non-object JSON (strings)", () => {
      expect(field.question.validate?.('"api-key-value"')).toBe(
        "AuthParameters must be a JSON object",
      );
    });

    it("rejects objects without a valid top-level auth key", () => {
      expect(field.question.validate?.('{"Foo":"bar"}')).toMatch(
        /ApiKeyAuthParameters|BasicAuthParameters|OAuthParameters/,
      );
    });

    it("accepts valid API_KEY shape", () => {
      expect(
        field.question.validate?.(
          '{"ApiKeyAuthParameters":{"ApiKeyName":"X-Api-Key","ApiKeyValue":"secret"}}',
        ),
      ).toBeUndefined();
    });

    it("accepts valid BASIC shape", () => {
      expect(
        field.question.validate?.(
          '{"BasicAuthParameters":{"Username":"bob","Password":"p@ss"}}',
        ),
      ).toBeUndefined();
    });

    it("accepts valid OAUTH shape", () => {
      expect(
        field.question.validate?.(
          '{"OAuthParameters":{"AuthorizationEndpoint":"https://example.com/oauth/token","HttpMethod":"POST","ClientParameters":{"ClientID":"id","ClientSecret":"secret"}}}',
        ),
      ).toBeUndefined();
    });

    it("accepts objects with just InvocationHttpParameters (header overrides)", () => {
      expect(
        field.question.validate?.(
          '{"ApiKeyAuthParameters":{"ApiKeyName":"X","ApiKeyValue":"v"},"InvocationHttpParameters":{"HeaderParameters":[]}}',
        ),
      ).toBeUndefined();
    });

    it("toCfn parses valid JSON into an object", () => {
      const parsed = field.toCfn?.(
        '{"ApiKeyAuthParameters":{"ApiKeyName":"X","ApiKeyValue":"v"}}',
      );
      expect(parsed).toEqual({
        ApiKeyAuthParameters: { ApiKeyName: "X", ApiKeyValue: "v" },
      });
    });

    it("toCfn returns undefined for empty input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
      expect(field.toCfn?.("   ")).toBeUndefined();
    });
  });

  describe("Description validation", () => {
    const field = eventsConnectionPlugin.commonFields.find(
      (f) => f.name === "Description",
    )!;

    it("accepts empty (optional)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("rejects descriptions over 512 characters", () => {
      expect(field.question.validate?.("a".repeat(513))).toMatch(
        /512 characters/,
      );
    });
  });

  describe("KmsKeyIdentifier (advanced) validation", () => {
    const field = eventsConnectionPlugin.advancedFields.find(
      (f) => f.name === "KmsKeyIdentifier",
    )!;

    it("accepts empty (AWS-managed secretsmanager key default)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts alias/aws/secretsmanager alias", () => {
      expect(
        field.question.validate?.("alias/aws/secretsmanager"),
      ).toBeUndefined();
    });

    it("accepts a full KMS key ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws:kms:us-east-1:123456789012:key/abcd-1234",
        ),
      ).toBeUndefined();
    });

    it("rejects non-KMS strings", () => {
      expect(field.question.validate?.("not-a-kms-ref")).toBeTruthy();
    });
  });

  describe("configHints", () => {
    it("warns Tags must not be included (not taggable)", () => {
      const hints = eventsConnectionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/NEVER include Tags/);
      expect(hints).toMatch(/not taggable/i);
    });

    it("explains the managed Secrets Manager secret lifecycle", () => {
      const hints = eventsConnectionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Secrets Manager|managed secret/i);
    });

    it("flags createOnly Name replacement cascade", () => {
      const hints = eventsConnectionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/createOnly/);
      expect(hints).toMatch(/replac|cascad/i);
    });

    it("documents Connection is free; cost lives on ApiDestination", () => {
      const hints = eventsConnectionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/free/i);
      expect(hints).toMatch(/ApiDestination/);
    });
  });
});
