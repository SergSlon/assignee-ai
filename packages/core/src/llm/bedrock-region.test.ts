/**
 * Unit tests for the in-core Bedrock region detector (Story 50-4 Wave 5.1),
 * the model lifecycle pre-flight (PR-007 / W24b-S2), and the
 * partition-aware region hints (PR-016/017 / W24b-S3).
 *
 * Pins feedback_bedrock_region_error_hints behavior on the canonical
 * implementation that now lives in `@assignee/core/llm`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  detectBedrockRegionError,
  detectBedrockModelLifecycle,
  KNOWN_BEDROCK_REGIONS,
  type BedrockLifecycleClient,
  type GetFoundationModelCommandFactory,
} from "./bedrock-region.js";
import { parseDefaultRegionFromConfig } from "../config/detect-aws-region.js";

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

  // ---------------------------------------------------------------------------
  // PR-016/017 (W24b-S3) — partition-aware hints
  // ---------------------------------------------------------------------------

  it("emits GovCloud-specific hint and suppresses commercial region list for us-gov-west-1", () => {
    const err = new Error("AccessDeniedException — model not available");
    const hint = detectBedrockRegionError(
      err,
      "us-gov-west-1",
      "bedrock/anthropic.claude-sonnet",
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("GovCloud");
    expect(hint).toContain("us-gov-west-1");
    // Must NOT suggest commercial regions to a GovCloud user.
    expect(hint).not.toContain("us-east-1");
    expect(hint).not.toContain("eu-west-1");
  });

  it("emits GovCloud-specific hint for us-gov-east-1 (covers both GovCloud regions)", () => {
    const err = new Error(
      "ValidationException — could not resolve the foundation model",
    );
    const hint = detectBedrockRegionError(
      err,
      "us-gov-east-1",
      "bedrock/anthropic.claude-sonnet",
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("GovCloud");
    expect(hint).not.toContain("us-east-1");
  });

  it("emits China-partition hint and suppresses commercial region list for cn-north-1", () => {
    const err = new Error("ResourceNotFoundException — model not found");
    const hint = detectBedrockRegionError(
      err,
      "cn-north-1",
      "bedrock/anthropic.claude-sonnet",
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("China partition");
    expect(hint).toContain("non-Bedrock provider");
    // Must NOT suggest commercial regions to a China-partition user.
    expect(hint).not.toContain("us-east-1");
    expect(hint).not.toContain("eu-west-1");
  });

  it("emits China-partition hint for cn-northwest-1 (covers both China regions)", () => {
    const err = new Error("AccessDeniedException — model not enabled");
    const hint = detectBedrockRegionError(
      err,
      "cn-northwest-1",
      "bedrock/anthropic.claude-sonnet",
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("China partition");
    expect(hint).not.toContain("us-east-1");
  });

  it("still emits commercial region list for ap-east-1 (commercial, non-canonical region)", () => {
    const err = new Error(
      "ValidationException — could not resolve the foundation model",
    );
    const hint = detectBedrockRegionError(err, "ap-east-1", "bedrock/x");
    expect(hint).not.toBeNull();
    expect(hint).toContain("not on the canonical Bedrock-enabled list");
    // Commercial-region list SHOULD appear for commercial partitions.
    for (const r of KNOWN_BEDROCK_REGIONS) {
      expect(hint).toContain(r);
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

// ---------------------------------------------------------------------------
// detectBedrockModelLifecycle — PR-007 / W24b-S2
// ---------------------------------------------------------------------------

/**
 * Build a mock BedrockLifecycleClient whose send() resolves to the
 * given modelLifecycle block.
 */
function makeLifecycleClient(
  lifecycle:
    | {
        status?: string;
        endOfLifeTime?: Date;
        legacyTime?: Date;
      }
    | undefined,
): BedrockLifecycleClient {
  return {
    send: vi.fn().mockResolvedValue({
      modelDetails:
        lifecycle !== undefined ? { modelLifecycle: lifecycle } : {},
    }),
  };
}

/** Client that throws with the given error on send(). */
function makeThrowingClient(err: Error): BedrockLifecycleClient {
  return {
    send: vi.fn().mockRejectedValue(err),
  };
}

/** Trivial command factory — tests don't care about the command object shape. */
const trivialFactory: GetFoundationModelCommandFactory = (modelId: string) => ({
  modelIdentifier: modelId,
});

describe("detectBedrockModelLifecycle", () => {
  it("returns ACTIVE when modelLifecycle.status is 'ACTIVE'", async () => {
    const client = makeLifecycleClient({ status: "ACTIVE" });
    const result = await detectBedrockModelLifecycle(
      "amazon.nova-lite-v1:0",
      client,
      trivialFactory,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("ACTIVE");
    expect(result!.endOfLifeDate).toBeUndefined();
    expect(result!.legacyDate).toBeUndefined();
  });

  it("returns LEGACY when modelLifecycle.status is 'LEGACY'", async () => {
    const client = makeLifecycleClient({ status: "LEGACY" });
    const result = await detectBedrockModelLifecycle(
      "anthropic.claude-instant-v1",
      client,
      trivialFactory,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("LEGACY");
  });

  it("populates endOfLifeDate when endOfLifeTime is present on LEGACY model", async () => {
    const eolDate = new Date("2025-09-30T00:00:00.000Z");
    const legacyDate = new Date("2025-03-01T00:00:00.000Z");
    const client = makeLifecycleClient({
      status: "LEGACY",
      endOfLifeTime: eolDate,
      legacyTime: legacyDate,
    });
    const result = await detectBedrockModelLifecycle(
      "anthropic.claude-v2",
      client,
      trivialFactory,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("LEGACY");
    expect(result!.endOfLifeDate).toBe("2025-09-30");
    expect(result!.legacyDate).toBe("2025-03-01");
  });

  it("returns ACTIVE with no dates when lifecycle block is absent", async () => {
    const client = makeLifecycleClient(undefined);
    const result = await detectBedrockModelLifecycle(
      "amazon.titan-text-lite-v1",
      client,
      trivialFactory,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("ACTIVE");
    expect(result!.endOfLifeDate).toBeUndefined();
  });

  it("returns null when SDK throws ResourceNotFoundException (unknown model)", async () => {
    const err = new Error(
      "ResourceNotFoundException: Model amazon.nova-bogus not found",
    );
    const client = makeThrowingClient(err);
    const result = await detectBedrockModelLifecycle(
      "amazon.nova-bogus",
      client,
      trivialFactory,
    );
    expect(result).toBeNull();
  });

  it("returns null when SDK throws AccessDeniedException (no GetFoundationModel permission)", async () => {
    const err = new Error(
      "AccessDeniedException: User is not authorized to perform bedrock:GetFoundationModel",
    );
    const client = makeThrowingClient(err);
    const result = await detectBedrockModelLifecycle(
      "amazon.nova-lite-v1:0",
      client,
      trivialFactory,
    );
    expect(result).toBeNull();
  });

  it("returns null when SDK throws a generic network error", async () => {
    const client = makeThrowingClient(new Error("ECONNREFUSED"));
    const result = await detectBedrockModelLifecycle(
      "amazon.nova-lite-v1:0",
      client,
      trivialFactory,
    );
    expect(result).toBeNull();
  });

  it("treats status case-insensitively (lowercase 'legacy' → LEGACY)", async () => {
    const client = makeLifecycleClient({ status: "legacy" });
    const result = await detectBedrockModelLifecycle(
      "anthropic.claude-instant-v1",
      client,
      trivialFactory,
    );
    expect(result!.status).toBe("LEGACY");
  });
});

// ---------------------------------------------------------------------------
// parseDefaultRegionFromConfig — PR-016 / W24b-S3
// ---------------------------------------------------------------------------

describe("parseDefaultRegionFromConfig", () => {
  it("returns the region from a standard [default] profile", () => {
    const config = `
[default]
region = us-west-2
output = json
`.trim();
    expect(parseDefaultRegionFromConfig(config)).toBe("us-west-2");
  });

  it("returns the region from a [profile default] heading (alternative INI form)", () => {
    const config = `
[profile default]
region = eu-central-1
`.trim();
    expect(parseDefaultRegionFromConfig(config)).toBe("eu-central-1");
  });

  it("returns the region from a GovCloud default profile", () => {
    const config = `
[default]
region = us-gov-west-1
`.trim();
    expect(parseDefaultRegionFromConfig(config)).toBe("us-gov-west-1");
  });

  it("returns the region from a China default profile", () => {
    const config = `
[default]
region = cn-north-1
`.trim();
    expect(parseDefaultRegionFromConfig(config)).toBe("cn-north-1");
  });

  it("ignores non-default profiles and returns region from [default]", () => {
    const config = `
[profile prod]
region = ap-southeast-1

[default]
region = eu-west-1

[profile dev]
region = us-east-2
`.trim();
    expect(parseDefaultRegionFromConfig(config)).toBe("eu-west-1");
  });

  it("returns undefined when [default] profile is absent", () => {
    const config = `
[profile prod]
region = ap-southeast-1
`.trim();
    expect(parseDefaultRegionFromConfig(config)).toBeUndefined();
  });

  it("returns undefined when [default] profile has no region line", () => {
    const config = `
[default]
output = json
`.trim();
    expect(parseDefaultRegionFromConfig(config)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(parseDefaultRegionFromConfig("")).toBeUndefined();
  });

  it("handles CRLF line endings gracefully", () => {
    const config = "[default]\r\nregion = us-east-1\r\noutput = json\r\n";
    expect(parseDefaultRegionFromConfig(config)).toBe("us-east-1");
  });

  it("returns undefined when region value is empty", () => {
    const config = `
[default]
region =
`.trim();
    expect(parseDefaultRegionFromConfig(config)).toBeUndefined();
  });

  it("trims whitespace around key and value", () => {
    const config = `
[default]
  region  =  ap-northeast-1
`.trim();
    expect(parseDefaultRegionFromConfig(config)).toBe("ap-northeast-1");
  });
});
