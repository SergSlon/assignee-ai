/**
 * Tests for the shared `--resource-type` filter helper used by `list` /
 * `status`. Covers HEADLINE_SHORTHANDS resolution, SSO validation, and
 * the P2-01 ambiguous-shorthand warning (Story 56-it2-04).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_TYPES_ARRAY } from "@assignee/core";
import {
  INVALID_RESOURCE_TYPE_CODE,
  normaliseResourceType,
  resolveResourceTypeFilter,
} from "./resource-type-filter.js";

describe("resolveResourceTypeFilter — exact + shorthand matches", () => {
  it("returns the canonical CFN form for an exact supported type (case-insensitive)", () => {
    expect(resolveResourceTypeFilter("AWS::S3::Bucket")).toBe(
      "AWS::S3::Bucket",
    );
    expect(resolveResourceTypeFilter("aws::s3::bucket")).toBe(
      "AWS::S3::Bucket",
    );
  });

  it("rejects unknown types with INVALID_RESOURCE_TYPE_CODE and embeds the SSO hint", () => {
    try {
      resolveResourceTypeFilter("NOT::A::Type");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code: string }).code).toBe(INVALID_RESOURCE_TYPE_CODE);
      expect((err as Error).message).toContain(
        'Unknown --resource-type "NOT::A::Type"',
      );
      // SSO hint header (registry-derived).
      expect((err as Error).message).toContain("What you can create");
    }
  });
});

describe("normaliseResourceType — P2-01 ambiguous-shorthand warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when shorthand resolves to a service that has >1 supported CFN types", () => {
    // Precondition: RDS owns both DBInstance AND DBSubnetGroup in the
    // registry — without this, the test wouldn't exercise the warning
    // path and would give a false-positive pass.
    const rdsTypes = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::RDS::"),
    );
    expect(rdsTypes.length).toBeGreaterThan(1);

    const resolved = normaliseResourceType("rds");
    expect(resolved).toBe("AWS::RDS::DBInstance");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const message = warnSpy.mock.calls[0]![0] as string;
    expect(message).toContain('"rds"');
    expect(message).toContain("AWS::RDS::DBInstance");
    // Mentions the sibling RDS type(s) by name.
    const siblings = rdsTypes.filter((t) => t !== "AWS::RDS::DBInstance");
    for (const sibling of siblings) {
      expect(message).toContain(sibling);
    }
  });

  it("does NOT warn when the shorthand's service has exactly one supported type", () => {
    // Lambda owns only AWS::Lambda::Function in the registry, so the
    // `lambda` shorthand is unambiguous and should NOT fire the
    // ambiguous-shorthand warning.
    const lambdaTypes = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::Lambda::"),
    );
    expect(lambdaTypes).toEqual(["AWS::Lambda::Function"]);

    const resolved = normaliseResourceType("lambda");
    expect(resolved).toBe("AWS::Lambda::Function");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn for exact CFN matches (user already typed the full form)", () => {
    const resolved = normaliseResourceType("AWS::RDS::DBInstance");
    expect(resolved).toBe("AWS::RDS::DBInstance");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
