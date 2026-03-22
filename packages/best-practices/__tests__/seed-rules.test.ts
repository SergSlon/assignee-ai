import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { loadBestPractices } from "../src/loader.js";
import { bestPracticeSchema } from "../src/schema.js";

const BP_ROOT = join(import.meta.dirname, "..");
const S3_DIR = join(BP_ROOT, "s3");
const EC2_DIR = join(BP_ROOT, "ec2");
const LAMBDA_DIR = join(BP_ROOT, "lambda");

describe("Seed BP Library — Sprint A (20 rules)", () => {
  const practices = loadBestPractices(BP_ROOT);

  it("loads exactly 20 best practice entries", () => {
    expect(practices).toHaveLength(20);
  });

  it("every entry validates against bestPracticeSchema without errors", () => {
    for (const bp of practices) {
      const result = bestPracticeSchema.safeParse(bp);
      expect(
        result.success,
        `Schema validation failed for ${bp.id}: ${JSON.stringify(result.success ? null : result.error.errors)}`,
      ).toBe(true);
    }
  });

  it("has no duplicate id values across all entries", () => {
    const ids = practices.map((bp) => bp.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("every entry has a non-empty remediation field", () => {
    for (const bp of practices) {
      expect(bp.remediation, `Missing remediation for ${bp.id}`).toBeTruthy();
      expect(
        bp.remediation!.length,
        `Empty remediation for ${bp.id}`,
      ).toBeGreaterThan(0);
    }
  });

  it("every entry has a valid lastVerified date not older than 2026-01-01", () => {
    const minDate = new Date("2026-01-01");
    for (const bp of practices) {
      expect(bp.lastVerified, `Missing lastVerified for ${bp.id}`).toBeTruthy();
      const date = new Date(bp.lastVerified);
      expect(
        date.getTime(),
        `lastVerified for ${bp.id} (${bp.lastVerified}) is older than 2026-01-01`,
      ).toBeGreaterThanOrEqual(minDate.getTime());
    }
  });

  it("S3 directory contains 8 YAML files", () => {
    const files = readdirSync(S3_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(8);
  });

  it("EC2 directory contains 7 YAML files", () => {
    const files = readdirSync(EC2_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(7);
  });

  it("Lambda directory contains 5 YAML files", () => {
    const files = readdirSync(LAMBDA_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(5);
  });

  it("all FSBP-sourced entries have a source_id field", () => {
    const fsbpEntries = practices.filter((bp) => bp.source.includes("FSBP"));
    expect(fsbpEntries.length).toBeGreaterThan(0);
    for (const bp of fsbpEntries) {
      expect(
        bp.source_id,
        `FSBP entry ${bp.id} is missing source_id`,
      ).toBeTruthy();
    }
  });

  it("covers all three resource types: S3, EC2, Lambda", () => {
    const resourceTypes = new Set(practices.map((bp) => bp.resource_type));
    expect(resourceTypes.has("AWS::S3::Bucket")).toBe(true);
    expect(resourceTypes.has("AWS::EC2::Instance")).toBe(true);
    expect(resourceTypes.has("AWS::Lambda::Function")).toBe(true);
  });

  it("every entry has a non-empty description", () => {
    for (const bp of practices) {
      expect(bp.description, `Missing description for ${bp.id}`).toBeTruthy();
      expect(
        bp.description!.length,
        `Empty description for ${bp.id}`,
      ).toBeGreaterThan(0);
    }
  });

  it("snapshot: loadBestPractices output matches expected structure", () => {
    const snapshot = practices.map((bp) => ({
      id: bp.id,
      severity: bp.severity,
      resource_type: bp.resource_type,
      check_type: bp.check_type,
      category: bp.category,
    }));
    expect(snapshot).toMatchSnapshot();
  });
});
