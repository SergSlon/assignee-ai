import { describe, it, expect } from "vitest";
import { cloudFrontDistributionPlugin } from "./cloudfront-distribution.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { DISTRIBUTION_PRESETS } from "./_policy-templates/index.js";

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

  // ── MASTER-011 part A — preset-driven wizard UX ────────────────────────────
  describe("Preset selector (MASTER-011 part A)", () => {
    const presetField = cloudFrontDistributionPlugin.commonFields.find(
      (f) => f.name === "Preset",
    )!;

    it("exposes a Preset enum field as the first prompt", () => {
      expect(presetField).toBeDefined();
      expect(presetField.required).toBe(true);
      expect(presetField.question.type).toBe("enum");
    });

    it("offers all four documented presets (3 templates + custom-json)", () => {
      const values = (presetField.question.options ?? []).map((o) => o.value);
      expect(values).toEqual(
        expect.arrayContaining([
          DISTRIBUTION_PRESETS.SPA_WEBSITE,
          DISTRIBUTION_PRESETS.STATIC_SITE,
          DISTRIBUTION_PRESETS.API_PASSTHROUGH,
          DISTRIBUTION_PRESETS.CUSTOM_JSON,
        ]),
      );
      expect(values).toHaveLength(4);
    });

    it("defaults to spa-website (most common case)", () => {
      expect(presetField.question.initialValue).toBe(
        DISTRIBUTION_PRESETS.SPA_WEBSITE,
      );
    });

    it("Preset is wizard-only — toCfn drops it from CFN output", () => {
      expect(
        presetField.toCfn?.(DISTRIBUTION_PRESETS.SPA_WEBSITE),
      ).toBeUndefined();
      expect(
        presetField.toCfn?.(DISTRIBUTION_PRESETS.CUSTOM_JSON),
      ).toBeUndefined();
    });

    it("registers exactly one DistributionConfig variant per preset", () => {
      const variants = cloudFrontDistributionPlugin.commonFields.filter(
        (f) => f.name === "DistributionConfig",
      );
      expect(variants).toHaveLength(4);
      const presets = variants
        .map((v) => v.question.showIf?.value)
        .filter(Boolean);
      expect(presets).toEqual(
        expect.arrayContaining([
          DISTRIBUTION_PRESETS.SPA_WEBSITE,
          DISTRIBUTION_PRESETS.STATIC_SITE,
          DISTRIBUTION_PRESETS.API_PASSTHROUGH,
          DISTRIBUTION_PRESETS.CUSTOM_JSON,
        ]),
      );
    });
  });

  describe("Preset prefill — initialValue materializes a working template", () => {
    function variant(preset: string) {
      return cloudFrontDistributionPlugin.commonFields.find(
        (f) =>
          f.name === "DistributionConfig" &&
          f.question.showIf?.value === preset,
      )!;
    }

    it("spa-website prefill is valid JSON with the canonical SPA fields", () => {
      const f = variant(DISTRIBUTION_PRESETS.SPA_WEBSITE);
      const iv = f.question.initialValue as string;
      expect(typeof iv).toBe("string");
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      expect(parsed["Enabled"]).toBe(true);
      expect(parsed["DefaultRootObject"]).toBe("index.html");
      // SPA fallback to /index.html on 403/404 is the SPA hallmark.
      expect(parsed["CustomErrorResponses"]).toBeDefined();
      const cer = parsed["CustomErrorResponses"] as Record<string, unknown>;
      const items = cer["Items"] as Array<Record<string, unknown>>;
      expect(items.some((i) => i["ErrorCode"] === 403)).toBe(true);
      expect(items.some((i) => i["ErrorCode"] === 404)).toBe(true);
    });

    it("spa-website prefill uses S3OriginConfig (not CustomOriginConfig)", () => {
      const iv = variant(DISTRIBUTION_PRESETS.SPA_WEBSITE).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      const origins = parsed["Origins"] as Record<string, unknown>;
      const items = origins["Items"] as Array<Record<string, unknown>>;
      expect(items[0]).toHaveProperty("S3OriginConfig");
      expect(items[0]).not.toHaveProperty("CustomOriginConfig");
    });

    it("static-site prefill omits the SPA fallback (CustomErrorResponses)", () => {
      const iv = variant(DISTRIBUTION_PRESETS.STATIC_SITE).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      // Multi-page static sites need real 404s — no rewrite to /index.html.
      expect(parsed["CustomErrorResponses"]).toBeUndefined();
    });

    it("api-passthrough prefill uses CustomOriginConfig with HTTPS-only", () => {
      const iv = variant(DISTRIBUTION_PRESETS.API_PASSTHROUGH).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      const origins = parsed["Origins"] as Record<string, unknown>;
      const items = origins["Items"] as Array<Record<string, unknown>>;
      const customOrigin = items[0]!["CustomOriginConfig"] as Record<
        string,
        unknown
      >;
      expect(customOrigin).toBeDefined();
      expect(customOrigin["OriginProtocolPolicy"]).toBe("https-only");
    });

    it("api-passthrough prefill disables caching (DefaultTTL=0)", () => {
      const iv = variant(DISTRIBUTION_PRESETS.API_PASSTHROUGH).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      const dcb = parsed["DefaultCacheBehavior"] as Record<string, unknown>;
      expect(dcb["DefaultTTL"]).toBe(0);
      expect(dcb["MaxTTL"]).toBe(0);
    });

    it("every non-custom preset uses ViewerProtocolPolicy=redirect-to-https", () => {
      for (const preset of [
        DISTRIBUTION_PRESETS.SPA_WEBSITE,
        DISTRIBUTION_PRESETS.STATIC_SITE,
        DISTRIBUTION_PRESETS.API_PASSTHROUGH,
      ]) {
        const iv = variant(preset).question.initialValue as string;
        const parsed = JSON.parse(iv) as Record<string, unknown>;
        const dcb = parsed["DefaultCacheBehavior"] as Record<string, unknown>;
        expect(dcb["ViewerProtocolPolicy"]).toBe("redirect-to-https");
      }
    });

    it("every preset prefill passes the shared validate() check", () => {
      for (const preset of [
        DISTRIBUTION_PRESETS.SPA_WEBSITE,
        DISTRIBUTION_PRESETS.STATIC_SITE,
        DISTRIBUTION_PRESETS.API_PASSTHROUGH,
      ]) {
        const f = variant(preset);
        const iv = f.question.initialValue as string;
        expect(f.question.validate?.(iv)).toBeUndefined();
      }
    });

    it("custom-json variant has NO initialValue (preserves free-text paste)", () => {
      const f = variant(DISTRIBUTION_PRESETS.CUSTOM_JSON);
      expect(f.question.initialValue).toBeUndefined();
    });

    it("custom-json variant still validates a hand-crafted JSON paste", () => {
      const f = variant(DISTRIBUTION_PRESETS.CUSTOM_JSON);
      const validJson = JSON.stringify({
        CallerReference: "hand-crafted",
        Enabled: true,
        Origins: { Quantity: 1, Items: [] },
        DefaultCacheBehavior: { TargetOriginId: "x" },
      });
      expect(f.question.validate?.(validJson)).toBeUndefined();
      expect(f.question.validate?.("{broken")).toMatch(/valid JSON/);
    });

    it("custom-json variant's toCfn parses pasted JSON", () => {
      const f = variant(DISTRIBUTION_PRESETS.CUSTOM_JSON);
      const validJson = JSON.stringify({
        CallerReference: "x",
        Enabled: true,
        Origins: { Quantity: 1, Items: [] },
        DefaultCacheBehavior: { TargetOriginId: "x" },
      });
      const parsed = f.toCfn?.(validJson) as Record<string, unknown>;
      expect(parsed["CallerReference"]).toBe("x");
      expect(parsed["Enabled"]).toBe(true);
    });
  });

  // ── MASTER-011 part D — phantom CLI citation ───────────────────────────────
  describe("phantom CLI citation (MASTER-011 part D)", () => {
    it("does NOT reference the non-existent `assignee patterns show` command", () => {
      const allText = JSON.stringify({
        hints: cloudFrontDistributionPlugin.configHints,
        fields: cloudFrontDistributionPlugin.commonFields.map((f) => ({
          label: f.question.label,
          hint: f.question.hint,
          placeholder: f.question.placeholder,
        })),
      });
      // Phantom: `assignee patterns show static-website` — NOT a real command.
      expect(allText).not.toMatch(/assignee patterns show/);
    });

    it("references real CLI commands instead (assignee plan / assignee cost)", () => {
      const allText = JSON.stringify({
        hints: cloudFrontDistributionPlugin.configHints,
        fields: cloudFrontDistributionPlugin.commonFields.map((f) => ({
          hint: f.question.hint,
        })),
      });
      // Audit-cited replacement: `assignee plan --help` is a real command.
      expect(allText).toMatch(/assignee plan --help|assignee cost/);
    });
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

    // Story e92.1.a — CCAPI-shape guardrails. Sanitizer repairs these
    // shapes but the prompt should educate the LLM up front.
    it("requires {Items, Quantity} shape for Origins / CacheBehaviors / CustomErrorResponses (C-15)", () => {
      const hints = cloudFrontDistributionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Items.*Quantity|Quantity.*Items/);
      expect(hints).toMatch(/Origins/);
      expect(hints).toMatch(/CacheBehaviors/);
      expect(hints).toMatch(/CustomErrorResponses/);
    });

    it("requires EXACTLY ONE of S3OriginConfig / CustomOriginConfig (C-04)", () => {
      const hints = cloudFrontDistributionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/EXACTLY ONE|exactly one|one of/i);
      expect(hints).toMatch(/S3OriginConfig/);
      expect(hints).toMatch(/CustomOriginConfig/);
    });

    it("forbids empty-string OriginAccessIdentity placeholder (C-04)", () => {
      const hints = cloudFrontDistributionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/OriginAccessIdentity/);
      expect(hints).toMatch(/empty string|never emit|omitted/i);
    });
  });
});
