/**
 * Unit tests for the in-core Bedrock region detector (Story 50-4 Wave 5.1).
 *
 * Pins feedback_bedrock_region_error_hints behavior on the canonical
 * implementation that now lives in `@assignee/core/llm`.
 */
import { describe, it, expect } from "vitest";
import {
  detectBedrockRegionError,
  KNOWN_BEDROCK_REGIONS,
} from "./bedrock-region.js";

describe("detectBedrockRegionError", () => {
  it("returns null when modelString is not a bedrock/ provider", () => {
    const err = new Error("AccessDeniedException — bad creds");
    expect(
      detectBedrockRegionError(err, "us-east-1", "anthropic/x"),
    ).toBeNull();
    expect(
      detectBedrockRegionError(err, "us-east-1", "openai/gpt-4o"),
    ).toBeNull();
  });

  it("returns null when the error message does not match a region pattern", () => {
    const err = new Error("Network timeout");
    expect(
      detectBedrockRegionError(
        err,
        "us-east-1",
        "bedrock/amazon.nova-lite-v1:0",
      ),
    ).toBeNull();
  });

  it("returns null when the error has no message string", () => {
    expect(
      detectBedrockRegionError(123 as unknown, "us-east-1", "bedrock/x"),
    ).toBeNull();
  });

  it("wraps the message with a hint when region IS on the known list", () => {
    const err = new Error("AccessDeniedException — model not enabled");
    const hint = detectBedrockRegionError(
      err,
      "us-east-1",
      "bedrock/anthropic.claude-sonnet",
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("us-east-1");
    expect(hint).toContain("bedrock/anthropic.claude-sonnet");
    expect(hint).toContain("Model access");
    expect(hint).toContain("Original AWS error");
  });

  it("wraps the message with a 'try a different region' hint when region is NOT on the canonical list", () => {
    const err = new Error(
      "ValidationException — could not resolve the foundation model",
    );
    const hint = detectBedrockRegionError(err, "ap-east-1", "bedrock/x");
    expect(hint).not.toBeNull();
    expect(hint).toContain("ap-east-1");
    expect(hint).toContain("not on the canonical Bedrock-enabled list");
    // All canonical regions should appear in the suggestion text.
    for (const r of KNOWN_BEDROCK_REGIONS) {
      expect(hint).toContain(r);
    }
  });

  it("recognises every documented region-error pattern", () => {
    const messages = [
      "AccessDeniedException foo",
      "ValidationException bar",
      "ResourceNotFoundException baz",
      "could not resolve the foundation model",
      "the provided model identifier is invalid",
      "you don't have access to the model",
      "not authorized to invoke",
    ];
    for (const m of messages) {
      const hint = detectBedrockRegionError(
        new Error(m),
        "us-east-1",
        "bedrock/x",
      );
      expect(hint, `should detect: ${m}`).not.toBeNull();
    }
  });
});

describe("KNOWN_BEDROCK_REGIONS", () => {
  it("includes the canonical short-list (snapshot 2026-04)", () => {
    expect(KNOWN_BEDROCK_REGIONS).toContain("us-east-1");
    expect(KNOWN_BEDROCK_REGIONS).toContain("us-west-2");
    expect(KNOWN_BEDROCK_REGIONS).toContain("eu-central-1");
    expect(KNOWN_BEDROCK_REGIONS).toContain("ap-northeast-1");
    expect(KNOWN_BEDROCK_REGIONS.length).toBeGreaterThanOrEqual(8);
  });
});
