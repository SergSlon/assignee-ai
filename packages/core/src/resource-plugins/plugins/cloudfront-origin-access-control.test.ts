import { describe, it, expect } from "vitest";
import { cloudFrontOriginAccessControlPlugin } from "./cloudfront-origin-access-control.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";

/**
 * MASTER-011 part B — OAC wizard JSON-paste replacement.
 *
 * The OAC plugin previously asked users to paste raw
 * OriginAccessControlConfig JSON. Post-fix the wizard asks for an
 * `OriginType` enum (s3 / mediastore / mediapackagev2 / lambda /
 * custom-json) and pre-fills the JSON config with a working SigV4 /
 * SigningBehavior=always template per origin type.
 */

describe("cloudFrontOriginAccessControlPlugin", () => {
  it("has the correct resourceType", () => {
    expect(cloudFrontOriginAccessControlPlugin.resourceType).toBe(
      RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
    );
  });

  it("all commonField question types are valid", () => {
    const valid = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of cloudFrontOriginAccessControlPlugin.commonFields) {
      expect(valid.has(field.question.type)).toBe(true);
    }
  });

  it("has no advancedFields (minimum-viable wizard)", () => {
    expect(cloudFrontOriginAccessControlPlugin.advancedFields).toEqual([]);
  });

  describe("OriginType selector (MASTER-011 part B)", () => {
    const originTypeField =
      cloudFrontOriginAccessControlPlugin.commonFields.find(
        (f) => f.name === "OriginType",
      )!;

    it("exposes an OriginType enum field as the first prompt", () => {
      expect(originTypeField).toBeDefined();
      expect(originTypeField.required).toBe(true);
      expect(originTypeField.question.type).toBe("enum");
    });

    it("offers the four AWS-supported origin types plus custom-json", () => {
      const values = (originTypeField.question.options ?? []).map(
        (o) => o.value,
      );
      expect(values).toEqual(
        expect.arrayContaining([
          "s3",
          "mediastore",
          "mediapackagev2",
          "lambda",
          "custom-json",
        ]),
      );
      expect(values).toHaveLength(5);
    });

    it("defaults to s3 (most common origin)", () => {
      expect(originTypeField.question.initialValue).toBe("s3");
    });

    it("OriginType is wizard-only — toCfn drops it from CFN output", () => {
      expect(originTypeField.toCfn?.("s3")).toBeUndefined();
      expect(originTypeField.toCfn?.("custom-json")).toBeUndefined();
    });

    it("registers exactly one OriginAccessControlConfig variant per OriginType (5 total)", () => {
      const variants = cloudFrontOriginAccessControlPlugin.commonFields.filter(
        (f) => f.name === "OriginAccessControlConfig",
      );
      expect(variants).toHaveLength(5);
      const values = variants
        .map((v) => v.question.showIf?.value)
        .filter(Boolean);
      expect(values).toEqual(
        expect.arrayContaining([
          "s3",
          "mediastore",
          "mediapackagev2",
          "lambda",
          "custom-json",
        ]),
      );
    });
  });

  describe("Preset prefill — initialValue materializes a working OAC config", () => {
    function variant(originType: string) {
      return cloudFrontOriginAccessControlPlugin.commonFields.find(
        (f) =>
          f.name === "OriginAccessControlConfig" &&
          f.question.showIf?.value === originType,
      )!;
    }

    for (const originType of ["s3", "mediastore", "mediapackagev2", "lambda"]) {
      it(`${originType} prefill is valid JSON with the matching OriginType`, () => {
        const f = variant(originType);
        const iv = f.question.initialValue as string;
        expect(typeof iv).toBe("string");
        const parsed = JSON.parse(iv) as Record<string, unknown>;
        expect(parsed["OriginAccessControlOriginType"]).toBe(originType);
        expect(parsed["SigningProtocol"]).toBe("sigv4");
        expect(parsed["SigningBehavior"]).toBe("always");
        expect(parsed["Name"]).toBeTruthy();
      });

      it(`${originType} prefill passes the shared validate() check`, () => {
        const f = variant(originType);
        const iv = f.question.initialValue as string;
        expect(f.question.validate?.(iv)).toBeUndefined();
      });

      it(`${originType} prefill's toCfn parses to a typed object`, () => {
        const f = variant(originType);
        const iv = f.question.initialValue as string;
        const parsed = f.toCfn?.(iv) as Record<string, unknown>;
        expect(parsed["OriginAccessControlOriginType"]).toBe(originType);
        expect(parsed["SigningBehavior"]).toBe("always");
      });
    }

    it("BP-OAC-001 enforced: every preset uses SigningBehavior=always (the safe default)", () => {
      for (const originType of [
        "s3",
        "mediastore",
        "mediapackagev2",
        "lambda",
      ]) {
        const f = variant(originType);
        const iv = f.question.initialValue as string;
        const parsed = JSON.parse(iv) as Record<string, unknown>;
        expect(parsed["SigningBehavior"]).toBe("always");
      }
    });

    it("custom-json variant has NO initialValue (preserves free-text paste)", () => {
      expect(variant("custom-json").question.initialValue).toBeUndefined();
    });

    it("custom-json variant still validates a hand-crafted JSON paste", () => {
      const f = variant("custom-json");
      const validJson = JSON.stringify({
        Name: "hand-crafted-oac",
        SigningProtocol: "sigv4",
        SigningBehavior: "no-override",
        OriginAccessControlOriginType: "s3",
      });
      expect(f.question.validate?.(validJson)).toBeUndefined();
    });

    it("custom-json variant rejects invalid JSON", () => {
      const f = variant("custom-json");
      expect(f.question.validate?.("{not json")).toMatch(/valid JSON/);
    });

    it("custom-json rejects bad SigningProtocol (only sigv4 is supported)", () => {
      const f = variant("custom-json");
      const bad = JSON.stringify({
        Name: "x",
        SigningProtocol: "sigv3",
        SigningBehavior: "always",
        OriginAccessControlOriginType: "s3",
      });
      expect(f.question.validate?.(bad)).toMatch(/sigv4/);
    });

    it("custom-json rejects bad SigningBehavior", () => {
      const f = variant("custom-json");
      const bad = JSON.stringify({
        Name: "x",
        SigningProtocol: "sigv4",
        SigningBehavior: "sometimes",
        OriginAccessControlOriginType: "s3",
      });
      expect(f.question.validate?.(bad)).toMatch(/SigningBehavior/);
    });

    it("custom-json rejects bad OriginAccessControlOriginType", () => {
      const f = variant("custom-json");
      const bad = JSON.stringify({
        Name: "x",
        SigningProtocol: "sigv4",
        SigningBehavior: "always",
        OriginAccessControlOriginType: "mongodb",
      });
      expect(f.question.validate?.(bad)).toMatch(
        /OriginAccessControlOriginType/,
      );
    });

    it("custom-json rejects missing required fields", () => {
      const f = variant("custom-json");
      const bad = JSON.stringify({ Name: "incomplete" });
      expect(f.question.validate?.(bad)).toMatch(
        /SigningProtocol|SigningBehavior|OriginAccessControlOriginType/,
      );
    });
  });

  describe("plugin defaults — fully-safe baseline preserved", () => {
    it("provides a default OriginAccessControlConfig that satisfies BP-OAC-001", () => {
      const cfg = cloudFrontOriginAccessControlPlugin.defaults[
        "OriginAccessControlConfig"
      ] as Record<string, unknown>;
      expect(cfg).toBeDefined();
      expect(cfg["SigningProtocol"]).toBe("sigv4");
      expect(cfg["SigningBehavior"]).toBe("always");
      expect(cfg["OriginAccessControlOriginType"]).toBe("s3");
    });
  });

  describe("configHints", () => {
    it("warns about non-taggability", () => {
      const hints = cloudFrontOriginAccessControlPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Tags|taggable/i);
      expect(hints).toMatch(/never include|omit/i);
    });

    it("explains SigningBehavior=always recommendation", () => {
      const hints = cloudFrontOriginAccessControlPlugin.configHints!.join(" ");
      expect(hints).toMatch(/always.*safe default|always.*private S3/i);
    });

    it("explains the OAC-vs-OAI migration", () => {
      const hints = cloudFrontOriginAccessControlPlugin.configHints!.join(" ");
      expect(hints).toMatch(/OAI|Origin Access Identity/);
    });
  });
});
