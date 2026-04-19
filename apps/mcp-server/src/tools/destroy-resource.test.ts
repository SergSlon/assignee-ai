/**
 * Tests for the MCP destroy-resource tool's per-invocation region
 * resolver. Covers Story 56-it2-04 P2-03 — empty / whitespace-only
 * AWS_REGION must coalesce to DEFAULT_AWS_REGION instead of silently
 * passing an empty string to the AWS SDK.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AWS_REGION } from "@assignee/core";
import { resolveDefaultRegion } from "./destroy-resource.js";

describe("destroy-resource resolveDefaultRegion (P2-03)", () => {
  const origRegion = process.env["AWS_REGION"];

  beforeEach(() => {
    delete process.env["AWS_REGION"];
  });

  afterEach(() => {
    if (origRegion === undefined) {
      delete process.env["AWS_REGION"];
    } else {
      process.env["AWS_REGION"] = origRegion;
    }
  });

  it("returns the AWS_REGION value when it is a non-empty string", () => {
    process.env["AWS_REGION"] = "eu-west-2";
    expect(resolveDefaultRegion()).toBe("eu-west-2");
  });

  it("falls back to DEFAULT_AWS_REGION when AWS_REGION is unset", () => {
    delete process.env["AWS_REGION"];
    expect(resolveDefaultRegion()).toBe(DEFAULT_AWS_REGION);
  });

  it("falls back to DEFAULT_AWS_REGION when AWS_REGION is an empty string", () => {
    // Exported-but-empty shells (`export AWS_REGION=`) used to pass
    // "" straight to the SDK — the `??` coalesce only fires on
    // undefined. Empty must fall through to the default.
    process.env["AWS_REGION"] = "";
    expect(resolveDefaultRegion()).toBe(DEFAULT_AWS_REGION);
  });

  it("falls back to DEFAULT_AWS_REGION when AWS_REGION is whitespace-only", () => {
    process.env["AWS_REGION"] = "   ";
    expect(resolveDefaultRegion()).toBe(DEFAULT_AWS_REGION);
  });

  it("trims a region value with leading/trailing whitespace", () => {
    process.env["AWS_REGION"] = "  us-east-1  ";
    expect(resolveDefaultRegion()).toBe("us-east-1");
  });
});
