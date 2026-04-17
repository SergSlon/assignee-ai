import { describe, it, expect } from "vitest";
import { enrichOptionLabel } from "./option-enrichment.js";
import { defaultPluginRegistry, RESOURCE_TYPES } from "../index.js";

describe("enrichOptionLabel", () => {
  it("appends all metadata when costHint, fitHint, and recommended are present", () => {
    const result = enrichOptionLabel({
      value: "gp3",
      label: "gp3 (General Purpose SSD v3) — ~$0.023/GB-month",
      costHint: "$0.023/GB-mo",
      fitHint: "Best price-performance",
      recommended: true,
    });
    expect(result).toContain("$0.023/GB-mo");
    expect(result).toContain("Best price-performance");
    expect(result).toContain("Recommended");
  });

  it("appends only fitHint when costHint is absent", () => {
    const result = enrichOptionLabel({
      value: "t3.small",
      label: "t3.small (2 vCPU, 2 GiB) — ~$0.0208/hr",
      fitHint: "Light production workloads",
      recommended: true,
    });
    expect(result).toContain("Light production workloads");
    expect(result).toContain("Recommended");
    expect(result).not.toContain("undefined");
  });

  it("appends only costHint when fitHint is absent", () => {
    const result = enrichOptionLabel({
      value: "test",
      label: "Test Option",
      costHint: "$5/mo",
    });
    expect(result).toContain("$5/mo");
    expect(result).not.toContain("Recommended");
  });

  it("returns original label unchanged when no metadata is present", () => {
    const result = enrichOptionLabel({
      value: "plain",
      label: "Plain Option",
    });
    expect(result).toBe("Plain Option");
  });

  it("returns original label when all metadata fields are undefined", () => {
    const result = enrichOptionLabel({
      value: "plain",
      label: "Plain Option",
      costHint: undefined,
      fitHint: undefined,
      recommended: undefined,
    });
    expect(result).toBe("Plain Option");
  });

  it("appends recommended without other hints", () => {
    const result = enrichOptionLabel({
      value: "test",
      label: "Test",
      recommended: true,
    });
    expect(result).toContain("Recommended");
  });

  it("does NOT append recommended when false", () => {
    const result = enrichOptionLabel({
      value: "test",
      label: "Test",
      recommended: false,
      fitHint: "Some hint",
    });
    expect(result).toContain("Some hint");
    expect(result).not.toContain("Recommended");
  });
});

describe("S3 plugin option metadata (AC: #1, #2)", () => {
  const s3Plugin = defaultPluginRegistry.get(RESOURCE_TYPES.S3_BUCKET)!;

  it("BucketEncryption has a hint mentioning KMS", () => {
    // Tier C: dropped redundant toBeDefined() — toContain fails on undefined
    const field = s3Plugin.commonFields.find(
      (f) => f.name === "BucketEncryption",
    )!;
    expect(field.question.hint).toContain("KMS");
  });

  it("VersioningConfiguration has a hint mentioning storage", () => {
    // Tier C: dropped redundant toBeDefined()
    const field = s3Plugin.commonFields.find(
      (f) => f.name === "VersioningConfiguration",
    )!;
    expect(field.question.hint).toContain("storage");
  });

  it("PublicAccessBlockConfiguration has a hint mentioning security", () => {
    // Tier C: dropped redundant toBeDefined()
    const field = s3Plugin.commonFields.find(
      (f) => f.name === "PublicAccessBlockConfiguration",
    )!;
    expect(field.question.hint).toContain("security");
  });
});

describe("graceful fallback (AC: #4)", () => {
  it("generic plugin options without metadata render unchanged", () => {
    const genericPlugin = defaultPluginRegistry.get("generic");
    if (!genericPlugin) return; // generic may not exist
    for (const field of genericPlugin.commonFields) {
      if (field.question.type === "enum" && field.question.options) {
        for (const opt of field.question.options) {
          const enriched = enrichOptionLabel(opt);
          // If no metadata, label is unchanged
          if (!opt.costHint && !opt.fitHint && !opt.recommended) {
            expect(enriched).toBe(opt.label);
          }
        }
      }
    }
  });

  it("options with empty strings for metadata render unchanged", () => {
    const result = enrichOptionLabel({
      value: "test",
      label: "Original Label",
      costHint: "",
      fitHint: "",
    });
    expect(result).toBe("Original Label");
  });
});

describe("enrichOptionLabel performance (AC: #3)", () => {
  it("enriches 100 options in <50ms", () => {
    const options = Array.from({ length: 100 }, (_, i) => ({
      value: `opt-${i}`,
      label: `Option ${i} — ~$${i}/hr`,
      costHint: `$${i}/mo`,
      fitHint: "Test workload",
      recommended: i === 0,
    }));

    const start = performance.now();
    for (const opt of options) {
      enrichOptionLabel(opt);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
