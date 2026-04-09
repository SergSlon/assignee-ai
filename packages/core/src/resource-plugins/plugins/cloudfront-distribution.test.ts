import { describe, it, expect } from "vitest";
import { cloudFrontDistributionPlugin } from "./cloudfront-distribution.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";

describe("cloudFrontDistributionPlugin", () => {
  it("has the correct resourceType", () => {
    expect(cloudFrontDistributionPlugin.resourceType).toBe(
      RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
    );
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of cloudFrontDistributionPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("has no advancedFields (minimum-viable wizard)", () => {
    expect(cloudFrontDistributionPlugin.advancedFields).toEqual([]);
  });

  describe("DistributionConfig validation", () => {
    const field = cloudFrontDistributionPlugin.commonFields.find(
      (f) => f.name === "DistributionConfig",
    )!;

    it("is marked required", () => {
      expect(field.required).toBe(true);
    });

    it("rejects empty", () => {
      expect(field.question.validate?.("")).toBe(
        "DistributionConfig is required",
      );
    });

    it("rejects invalid JSON", () => {
      expect(field.question.validate?.("{not json")).toBe(
        "DistributionConfig must be valid JSON",
      );
    });

    it("rejects non-object JSON (arrays)", () => {
      expect(field.question.validate?.("[]")).toBe(
        "DistributionConfig must be a JSON object",
      );
    });

    it("rejects non-object JSON (strings)", () => {
      expect(field.question.validate?.('"hello"')).toBe(
        "DistributionConfig must be a JSON object",
      );
    });

    it("rejects config missing CallerReference", () => {
      const config = JSON.stringify({
        Enabled: true,
        Origins: { Quantity: 1, Items: [] },
        DefaultCacheBehavior: {},
      });
      expect(field.question.validate?.(config)).toMatch(/CallerReference/);
    });

    it("rejects config missing Origins", () => {
      const config = JSON.stringify({
        CallerReference: "ref",
        Enabled: true,
        DefaultCacheBehavior: {},
      });
      expect(field.question.validate?.(config)).toMatch(/Origins/);
    });

    it("rejects config missing DefaultCacheBehavior", () => {
      const config = JSON.stringify({
        CallerReference: "ref",
        Enabled: true,
        Origins: { Quantity: 1, Items: [] },
      });
      expect(field.question.validate?.(config)).toMatch(/DefaultCacheBehavior/);
    });

    it("lists ALL missing required fields at once, not just the first", () => {
      const config = JSON.stringify({ Enabled: true });
      const err = field.question.validate?.(config);
      expect(err).toMatch(/CallerReference/);
      expect(err).toMatch(/Origins/);
      expect(err).toMatch(/DefaultCacheBehavior/);
    });

    it("accepts a minimum-viable SPA config", () => {
      const config = JSON.stringify({
        CallerReference: "my-spa-dist",
        Enabled: true,
        Origins: {
          Quantity: 1,
          Items: [
            {
              Id: "s3-origin",
              DomainName: "my-bucket.s3.us-east-1.amazonaws.com",
              S3OriginConfig: { OriginAccessIdentity: "" },
            },
          ],
        },
        DefaultCacheBehavior: {
          TargetOriginId: "s3-origin",
          ViewerProtocolPolicy: "redirect-to-https",
          ForwardedValues: { QueryString: false, Cookies: { Forward: "none" } },
        },
      });
      expect(field.question.validate?.(config)).toBeUndefined();
    });

    it("toCfn parses valid JSON into an object", () => {
      const config = JSON.stringify({
        CallerReference: "ref",
        Enabled: true,
        Origins: { Quantity: 1, Items: [] },
        DefaultCacheBehavior: { TargetOriginId: "x" },
      });
      const parsed = field.toCfn?.(config);
      expect(parsed).toMatchObject({
        CallerReference: "ref",
        Enabled: true,
      });
    });

    it("toCfn returns undefined for empty input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
      expect(field.toCfn?.("   ")).toBeUndefined();
    });

    it("toCfn returns undefined for invalid JSON", () => {
      expect(field.toCfn?.("{broken")).toBeUndefined();
    });
  });

  describe("Tags toCfn (CloudFront wraps in { Items })", () => {
    const field = cloudFrontDistributionPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;

    it("returns undefined for blank input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
      expect(field.toCfn?.("   ")).toBeUndefined();
    });

    it("wraps parsed tags in { Items } (NOT a flat array)", () => {
      // CloudFront::Distribution is one of the few CFN types that
      // accepts Tags as { Items: [...] } rather than a flat array —
      // the plugin adapter must handle the service-specific shape.
      const parsed = field.toCfn?.("env:production, team:platform");
      expect(parsed).toEqual({
        Items: [
          { Key: "env", Value: "production" },
          { Key: "team", Value: "platform" },
        ],
      });
    });

    it("preserves colons inside the value", () => {
      expect(field.toCfn?.("uri:https://example.com/path")).toEqual({
        Items: [{ Key: "uri", Value: "https://example.com/path" }],
      });
    });

    it("skips malformed entries without a colon", () => {
      expect(field.toCfn?.("valid:yes, bogus, env:prod")).toEqual({
        Items: [
          { Key: "valid", Value: "yes" },
          { Key: "env", Value: "prod" },
        ],
      });
    });
  });

  describe("configHints", () => {
    it("warns about the 5-60 minute propagation window", () => {
      const hints = cloudFrontDistributionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/5-60 MINUTES|propagat/i);
    });

    it("recommends the static-website compound pattern for SPA use cases", () => {
      const hints = cloudFrontDistributionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/static-website/);
      expect(hints).toMatch(/compound pattern/i);
    });

    it("enforces redirect-to-https for ViewerProtocolPolicy", () => {
      const hints = cloudFrontDistributionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/redirect-to-https/);
    });

    it("flags the us-east-1 ACM certificate requirement for custom domains", () => {
      const hints = cloudFrontDistributionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/us-east-1/);
      expect(hints).toMatch(/ACM|certificate/i);
    });

    it("explains the disable-first destroy flow", () => {
      const hints = cloudFrontDistributionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Enabled.*false|pre-disable|disable/i);
      expect(hints).toMatch(/delete|destroy/i);
    });
  });
});
