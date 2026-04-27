import { describe, it, expect } from "vitest";
import { s3BucketPolicyPlugin } from "./s3-bucket-policy.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { BUCKET_POLICY_PRESETS } from "./_policy-templates/index.js";

/**
 * MASTER-011 part C — s3-bucket-policy wizard JSON-paste replacement.
 *
 * The plugin previously required users to paste a raw PolicyDocument
 * JSON with no scaffold. Post-fix the wizard asks for a `PolicyTemplate`
 * enum (cloudfront-oac-read / tls-only / cross-account-decrypt /
 * public-read / custom-json) and pre-fills the JSON with a working
 * baseline they can tweak.
 */

describe("s3BucketPolicyPlugin", () => {
  it("has the correct resourceType", () => {
    expect(s3BucketPolicyPlugin.resourceType).toBe(
      RESOURCE_TYPES.S3_BUCKET_POLICY,
    );
  });

  it("all commonField question types are valid", () => {
    const valid = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of s3BucketPolicyPlugin.commonFields) {
      expect(valid.has(field.question.type)).toBe(true);
    }
  });

  it("has no advancedFields (minimum-viable wizard)", () => {
    expect(s3BucketPolicyPlugin.advancedFields).toEqual([]);
  });

  describe("Bucket field (preserved from pre-MASTER-011)", () => {
    const field = s3BucketPolicyPlugin.commonFields.find(
      (f) => f.name === "Bucket",
    )!;

    it("is required", () => {
      expect(field.required).toBe(true);
    });

    it("rejects empty values", () => {
      expect(field.question.validate?.("")).toBe("Bucket is required");
    });

    it("rejects bucket names that violate S3 naming rules", () => {
      expect(field.question.validate?.("Bad_Name")).toMatch(/3-63 chars/);
      expect(field.question.validate?.("ab")).toMatch(/3-63 chars/);
    });

    it("accepts a valid lowercase bucket name", () => {
      expect(
        field.question.validate?.("my-static-site-bucket"),
      ).toBeUndefined();
    });

    it("passes through compound marker tokens unmolested", () => {
      expect(
        field.question.validate?.("__ASSIGNEE_BUCKET_REF_static-site__"),
      ).toBeUndefined();
    });
  });

  describe("PolicyTemplate selector (MASTER-011 part C)", () => {
    const presetField = s3BucketPolicyPlugin.commonFields.find(
      (f) => f.name === "PolicyTemplate",
    )!;

    it("exposes a PolicyTemplate enum field", () => {
      expect(presetField).toBeDefined();
      expect(presetField.required).toBe(true);
      expect(presetField.question.type).toBe("enum");
    });

    it("offers all five documented templates (4 presets + custom-json)", () => {
      const values = (presetField.question.options ?? []).map((o) => o.value);
      expect(values).toEqual(
        expect.arrayContaining([
          BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ,
          BUCKET_POLICY_PRESETS.TLS_ONLY,
          BUCKET_POLICY_PRESETS.CROSS_ACCOUNT_DECRYPT,
          BUCKET_POLICY_PRESETS.PUBLIC_READ,
          BUCKET_POLICY_PRESETS.CUSTOM_JSON,
        ]),
      );
      expect(values).toHaveLength(5);
    });

    it("defaults to cloudfront-oac-read (most common case)", () => {
      expect(presetField.question.initialValue).toBe(
        BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ,
      );
    });

    it("PolicyTemplate is wizard-only — toCfn drops it from CFN output", () => {
      expect(
        presetField.toCfn?.(BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ),
      ).toBeUndefined();
      expect(
        presetField.toCfn?.(BUCKET_POLICY_PRESETS.CUSTOM_JSON),
      ).toBeUndefined();
    });

    it("registers exactly one PolicyDocument variant per template (5 total)", () => {
      const variants = s3BucketPolicyPlugin.commonFields.filter(
        (f) => f.name === "PolicyDocument",
      );
      expect(variants).toHaveLength(5);
      const presets = variants
        .map((v) => v.question.showIf?.value)
        .filter(Boolean);
      expect(presets).toEqual(
        expect.arrayContaining([
          BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ,
          BUCKET_POLICY_PRESETS.TLS_ONLY,
          BUCKET_POLICY_PRESETS.CROSS_ACCOUNT_DECRYPT,
          BUCKET_POLICY_PRESETS.PUBLIC_READ,
          BUCKET_POLICY_PRESETS.CUSTOM_JSON,
        ]),
      );
    });
  });

  describe("Preset prefill — initialValue materializes a working PolicyDocument", () => {
    function variant(preset: string) {
      return s3BucketPolicyPlugin.commonFields.find(
        (f) =>
          f.name === "PolicyDocument" && f.question.showIf?.value === preset,
      )!;
    }

    it("cloudfront-oac-read prefill grants the cloudfront service principal", () => {
      const iv = variant(BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      const stmt = (parsed["Statement"] as Array<Record<string, unknown>>)[0]!;
      const principal = stmt["Principal"] as Record<string, unknown>;
      expect(principal["Service"]).toBe("cloudfront.amazonaws.com");
      expect(stmt["Action"]).toBe("s3:GetObject");
      expect(stmt["Effect"]).toBe("Allow");
    });

    it("cloudfront-oac-read prefill includes the mandatory aws:SourceArn condition", () => {
      const iv = variant(BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      const stmt = (parsed["Statement"] as Array<Record<string, unknown>>)[0]!;
      const cond = stmt["Condition"] as Record<string, unknown>;
      const eq = cond["StringEquals"] as Record<string, unknown>;
      expect(eq["AWS:SourceArn"]).toMatch(/arn:aws:cloudfront::/);
    });

    it("tls-only prefill uses Effect=Deny + aws:SecureTransport=false", () => {
      const iv = variant(BUCKET_POLICY_PRESETS.TLS_ONLY).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      const stmt = (parsed["Statement"] as Array<Record<string, unknown>>)[0]!;
      expect(stmt["Effect"]).toBe("Deny");
      expect(stmt["Principal"]).toBe("*");
      const cond = stmt["Condition"] as Record<string, unknown>;
      const bool = cond["Bool"] as Record<string, unknown>;
      expect(bool["aws:SecureTransport"]).toBe("false");
    });

    it("tls-only prefill covers BOTH the bucket and its objects", () => {
      const iv = variant(BUCKET_POLICY_PRESETS.TLS_ONLY).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      const stmt = (parsed["Statement"] as Array<Record<string, unknown>>)[0]!;
      const resources = stmt["Resource"] as string[];
      expect(resources).toHaveLength(2);
      // bucket-level + object-level — both required to lock down all access.
      expect(resources.some((r) => r.endsWith("/*"))).toBe(true);
      expect(resources.some((r) => !r.endsWith("/*"))).toBe(true);
    });

    it("cross-account-decrypt prefill targets a placeholder cross-account ARN", () => {
      const iv = variant(BUCKET_POLICY_PRESETS.CROSS_ACCOUNT_DECRYPT).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      const stmt = (parsed["Statement"] as Array<Record<string, unknown>>)[0]!;
      const principal = stmt["Principal"] as Record<string, unknown>;
      expect(String(principal["AWS"])).toMatch(/REPLACE_WITH_OTHER_ACCOUNT_ID/);
      const actions = stmt["Action"] as string[];
      expect(actions).toEqual(
        expect.arrayContaining(["s3:GetObject", "s3:ListBucket"]),
      );
    });

    it("public-read prefill restricts via aws:SourceIp Condition", () => {
      const iv = variant(BUCKET_POLICY_PRESETS.PUBLIC_READ).question
        .initialValue as string;
      const parsed = JSON.parse(iv) as Record<string, unknown>;
      const stmt = (parsed["Statement"] as Array<Record<string, unknown>>)[0]!;
      expect(stmt["Effect"]).toBe("Allow");
      expect(stmt["Principal"]).toBe("*");
      const cond = stmt["Condition"] as Record<string, unknown>;
      expect(cond["IpAddress"]).toBeDefined();
    });

    it("every non-custom preset prefill passes the shared validate() check", () => {
      for (const preset of [
        BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ,
        BUCKET_POLICY_PRESETS.TLS_ONLY,
        BUCKET_POLICY_PRESETS.CROSS_ACCOUNT_DECRYPT,
        BUCKET_POLICY_PRESETS.PUBLIC_READ,
      ]) {
        const f = variant(preset);
        const iv = f.question.initialValue as string;
        expect(f.question.validate?.(iv)).toBeUndefined();
      }
    });

    it("every non-custom preset uses Version=2012-10-17", () => {
      for (const preset of [
        BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ,
        BUCKET_POLICY_PRESETS.TLS_ONLY,
        BUCKET_POLICY_PRESETS.CROSS_ACCOUNT_DECRYPT,
        BUCKET_POLICY_PRESETS.PUBLIC_READ,
      ]) {
        const iv = variant(preset).question.initialValue as string;
        const parsed = JSON.parse(iv) as Record<string, unknown>;
        expect(parsed["Version"]).toBe("2012-10-17");
      }
    });

    it("custom-json variant has NO initialValue (preserves free-text paste)", () => {
      expect(
        variant(BUCKET_POLICY_PRESETS.CUSTOM_JSON).question.initialValue,
      ).toBeUndefined();
    });

    it("custom-json validates a hand-crafted PolicyDocument", () => {
      const f = variant(BUCKET_POLICY_PRESETS.CUSTOM_JSON);
      const valid = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "Custom",
            Effect: "Allow",
            Principal: { AWS: "arn:aws:iam::210987654321:root" },
            Action: "s3:GetObject",
            Resource: "arn:aws:s3:::my-bucket/*",
          },
        ],
      });
      expect(f.question.validate?.(valid)).toBeUndefined();
    });

    it("custom-json rejects empty input", () => {
      const f = variant(BUCKET_POLICY_PRESETS.CUSTOM_JSON);
      expect(f.question.validate?.("")).toBe("PolicyDocument is required");
    });

    it("custom-json rejects invalid JSON", () => {
      const f = variant(BUCKET_POLICY_PRESETS.CUSTOM_JSON);
      expect(f.question.validate?.("{broken")).toMatch(/valid JSON/);
    });

    it("custom-json rejects wrong Version", () => {
      const f = variant(BUCKET_POLICY_PRESETS.CUSTOM_JSON);
      const bad = JSON.stringify({
        Version: "2008-10-17",
        Statement: [{ Effect: "Allow" }],
      });
      expect(f.question.validate?.(bad)).toMatch(/Version/);
    });

    it("custom-json rejects empty Statement array", () => {
      const f = variant(BUCKET_POLICY_PRESETS.CUSTOM_JSON);
      const bad = JSON.stringify({
        Version: "2012-10-17",
        Statement: [],
      });
      expect(f.question.validate?.(bad)).toMatch(/Statement/);
    });

    it("custom-json rejects non-array Statement", () => {
      const f = variant(BUCKET_POLICY_PRESETS.CUSTOM_JSON);
      const bad = JSON.stringify({
        Version: "2012-10-17",
        Statement: { Effect: "Allow" },
      });
      expect(f.question.validate?.(bad)).toMatch(/Statement.*array/);
    });

    it("custom-json's toCfn parses a pasted PolicyDocument", () => {
      const f = variant(BUCKET_POLICY_PRESETS.CUSTOM_JSON);
      const valid = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Principal: "*", Action: "s3:GetObject" },
        ],
      });
      const parsed = f.toCfn?.(valid) as Record<string, unknown>;
      expect(parsed["Version"]).toBe("2012-10-17");
      expect(Array.isArray(parsed["Statement"])).toBe(true);
    });

    it("toCfn passes through a pre-resolved object (compound pre-fill)", () => {
      const f = variant(BUCKET_POLICY_PRESETS.CUSTOM_JSON);
      const obj = {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow" }],
      };
      expect(f.toCfn?.(obj)).toEqual(obj);
    });
  });

  describe("configHints", () => {
    it("warns about non-taggability", () => {
      const hints = s3BucketPolicyPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Tags|taggable/i);
      expect(hints).toMatch(/never include|omit/i);
    });

    it("warns about the 1-policy-per-bucket invariant", () => {
      const hints = s3BucketPolicyPlugin.configHints!.join(" ");
      expect(hints).toMatch(/exactly one|one BucketPolicy/i);
    });

    it("explains aws:SourceArn requirement for CloudFront OAC grants", () => {
      const hints = s3BucketPolicyPlugin.configHints!.join(" ");
      expect(hints).toMatch(/aws:SourceArn|SourceArn/);
      expect(hints).toMatch(/cloudfront/i);
    });

    it("explains the 20 KB policy size cap", () => {
      const hints = s3BucketPolicyPlugin.configHints!.join(" ");
      expect(hints).toMatch(/20 KB|20KB/i);
    });
  });
});
