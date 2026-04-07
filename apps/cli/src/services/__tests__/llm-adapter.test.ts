import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { LlmError } from "@assignee/core";

// Mock all provider packages before importing the adapter.
// NOTE: Plain functions (not vi.fn) for the provider factories so impls
// survive vitest's mockReset:true. The `generateText` mock is re-installed
// in beforeEach to keep call tracking + per-test return values.
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => ({ modelId: "mock-anthropic" }),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => () => ({ modelId: "mock-openai" }),
}));
vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: () => () => ({ modelId: "mock-bedrock" }),
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => ({ modelId: "mock-google" }),
}));
vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: { object: vi.fn() },
}));

import {
  parseModelString,
  LlmAdapter,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  detectBedrockRegionError,
  KNOWN_BEDROCK_REGIONS,
} from "../llm-adapter.js";
import { generateText } from "ai";

const savedEnv = { ...process.env };

describe("parseModelString", () => {
  it("parses anthropic/ prefix correctly", () => {
    const result = parseModelString("anthropic/claude-sonnet-4-5");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });

  it("parses openai/ prefix correctly", () => {
    const result = parseModelString("openai/gpt-4o");
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("parses bedrock/ prefix with colon in model ID", () => {
    const result = parseModelString("bedrock/amazon.nova-lite-v1:0");
    expect(result).toEqual({
      provider: "bedrock",
      modelId: "amazon.nova-lite-v1:0",
    });
  });

  it("parses ollama/ prefix correctly", () => {
    const result = parseModelString("ollama/llama3");
    expect(result).toEqual({ provider: "ollama", modelId: "llama3" });
  });

  it("parses google/ prefix correctly", () => {
    const result = parseModelString("google/gemini-2.0-flash");
    expect(result).toEqual({
      provider: "google",
      modelId: "gemini-2.0-flash",
    });
  });

  it("throws LlmError for missing slash", () => {
    expect(() => parseModelString("just-a-model")).toThrow(LlmError);
    expect(() => parseModelString("just-a-model")).toThrow(
      /Invalid ASSIGNEE_MODEL format/,
    );
  });

  it("throws LlmError for empty model ID", () => {
    expect(() => parseModelString("anthropic/")).toThrow(LlmError);
    expect(() => parseModelString("anthropic/")).toThrow(/Model ID is empty/);
  });

  it("throws LlmError for unsupported provider", () => {
    expect(() => parseModelString("cohere/command-r")).toThrow(LlmError);
    expect(() => parseModelString("cohere/command-r")).toThrow(
      /Unsupported provider/,
    );
  });
});

describe("DEFAULT_MODEL", () => {
  it("defaults to bedrock/amazon.nova-lite-v1:0 for backward compatibility", () => {
    expect(DEFAULT_MODEL).toBe("bedrock/amazon.nova-lite-v1:0");
  });
});

describe("DEFAULT_MAX_TOKENS", () => {
  it("defaults to 1024 per NFR-15", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(1024);
  });
});

describe("LlmAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-install default impl (mockReset wipes it).
    vi.mocked(generateText).mockResolvedValue({
      text: "mock text",
      output: { resourceType: "AWS::S3::Bucket" },
    } as never);
    // Set required API keys for tests
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["OPENAI_API_KEY"] = "test-key";
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "test-key";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("uses DEFAULT_MODEL when no modelString is provided", () => {
    // Should not throw — defaults to bedrock which doesn't need API key env var
    const adapter = new LlmAdapter();
    expect(adapter).toBeDefined();
  });

  it("accepts explicit modelString", () => {
    const adapter = new LlmAdapter({
      modelString: "anthropic/claude-sonnet-4-5",
    });
    expect(adapter).toBeDefined();
  });

  describe("generateText", () => {
    it("calls Vercel AI SDK generateText with default maxTokens", async () => {
      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err, result] = await adapter.generateText("Hello");

      expect(err).toBeNull();
      expect(result).toBe("mock text");

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          maxOutputTokens: 1024,
          messages: [{ role: "user", content: "Hello" }],
        }),
      );
    });

    it("respects maxTokens override", async () => {
      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      await adapter.generateText("Hello", { maxTokens: 2048 });

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          maxOutputTokens: 2048,
        }),
      );
    });

    it("returns LlmError on failure", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(new Error("API down"));

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err, result] = await adapter.generateText("Hello");

      expect(err).toBeInstanceOf(LlmError);
      expect(err?.message).toContain("Text LLM call failed");
      expect(result).toBeNull();
    });

    it("includes guardrail opts for bedrock provider", async () => {
      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
        guardrailId: "my-guardrail",
        guardrailVersion: "2",
      });
      await adapter.generateText("Hello");

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          guardrailIdentifier: "my-guardrail",
          guardrailVersion: "2",
        }),
      );
    });

    // Companion to the H6 regression: ensures generateText also forwards
    // realistic-shaped guardrail identifiers (12-char id, "DRAFT" version).
    it("forwards realistic guardrail identifier and version for bedrock", async () => {
      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
        guardrailId: "abcd1234efgh",
        guardrailVersion: "DRAFT",
      });
      await adapter.generateText("Hello");

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          guardrailIdentifier: "abcd1234efgh",
          guardrailVersion: "DRAFT",
        }),
      );
    });

    it("does not include guardrail opts for non-bedrock providers", async () => {
      const adapter = new LlmAdapter({
        modelString: "anthropic/claude-sonnet-4-5",
        guardrailId: "my-guardrail",
      });
      await adapter.generateText("Hello");

      const callArgs = vi.mocked(generateText).mock.calls[0]?.[0];
      expect(callArgs).not.toHaveProperty("guardrailIdentifier");
    });
  });

  describe("generateStructured", () => {
    it("returns validated structured output", async () => {
      const schema = z.object({ resourceType: z.string() });
      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });

      const [err, result] = await adapter.generateStructured(
        "Parse this",
        schema,
      );

      expect(err).toBeNull();
      expect(result).toEqual({ resourceType: "AWS::S3::Bucket" });
    });

    it("returns LlmError on failure", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(new Error("schema fail"));

      const schema = z.object({ resourceType: z.string() });
      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err, result] = await adapter.generateStructured(
        "Parse this",
        schema,
      );

      expect(err).toBeInstanceOf(LlmError);
      expect(err?.message).toContain("Structured LLM call failed");
      expect(result).toBeNull();
    });

    // Regression for H6: generateStructured was bypassing the configured
    // Bedrock guardrail because it omitted the `...this.guardrailOpts` spread.
    // Any node calling generateStructured (intent-parser, workload-classifier)
    // would skip the only runtime defense against prompt-injected outputs.
    it("includes guardrail opts for bedrock provider (H6 regression)", async () => {
      const schema = z.object({ resourceType: z.string() });
      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
        guardrailId: "abcd1234efgh",
        guardrailVersion: "DRAFT",
      });
      await adapter.generateStructured("Parse this", schema);

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          guardrailIdentifier: "abcd1234efgh",
          guardrailVersion: "DRAFT",
        }),
      );
    });

    it("does not include guardrail opts for non-bedrock providers", async () => {
      const schema = z.object({ resourceType: z.string() });
      const adapter = new LlmAdapter({
        modelString: "anthropic/claude-sonnet-4-5",
        guardrailId: "abcd1234efgh",
      });
      await adapter.generateStructured("Parse this", schema);

      const callArgs = vi.mocked(generateText).mock.calls[0]?.[0];
      expect(callArgs).not.toHaveProperty("guardrailIdentifier");
    });
  });

  describe("missing API key errors", () => {
    it("produces clear error for missing ANTHROPIC_API_KEY", async () => {
      delete process.env["ANTHROPIC_API_KEY"];
      const adapter = new LlmAdapter({
        modelString: "anthropic/claude-sonnet-4-5",
      });
      const [err] = await adapter.generateText("Hello");

      expect(err).toBeInstanceOf(LlmError);
      expect(err?.message).toContain("ANTHROPIC_API_KEY");
    });

    it("produces clear error for missing OPENAI_API_KEY", async () => {
      delete process.env["OPENAI_API_KEY"];
      const adapter = new LlmAdapter({
        modelString: "openai/gpt-4o",
      });
      const [err] = await adapter.generateText("Hello");

      expect(err).toBeInstanceOf(LlmError);
      expect(err?.message).toContain("OPENAI_API_KEY");
    });

    it("produces clear error for missing GOOGLE_GENERATIVE_AI_API_KEY", async () => {
      delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
      const adapter = new LlmAdapter({
        modelString: "google/gemini-2.0-flash",
      });
      const [err] = await adapter.generateText("Hello");

      expect(err).toBeInstanceOf(LlmError);
      expect(err?.message).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    });

    it("bedrock does not require explicit API key env var", async () => {
      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err] = await adapter.generateText("Hello");
      // Bedrock uses AWS SDK credential chain, no explicit key needed
      expect(err).toBeNull();
    });

    it("ollama does not require explicit API key env var", async () => {
      const adapter = new LlmAdapter({
        modelString: "ollama/llama3",
      });
      const [err] = await adapter.generateText("Hello");
      expect(err).toBeNull();
    });
  });

  // ── Wave 12 P2: Bedrock cross-region detection ──────────────────────────
  describe("detectBedrockRegionError (Wave 12 P2)", () => {
    it("returns null for non-bedrock providers (no false positives)", () => {
      const hint = detectBedrockRegionError(
        new Error("AccessDeniedException: foo"),
        "us-east-1",
        "anthropic/claude-sonnet-4-5",
      );
      expect(hint).toBeNull();
    });

    it("returns null for unrelated errors on bedrock provider", () => {
      const hint = detectBedrockRegionError(
        new Error("Network timeout"),
        "us-east-1",
        "bedrock/amazon.nova-lite-v1:0",
      );
      expect(hint).toBeNull();
    });

    it("detects AccessDeniedException on bedrock provider", () => {
      const hint = detectBedrockRegionError(
        new Error(
          "AccessDeniedException: You don't have access to the model with the specified model ID.",
        ),
        "us-east-1",
        "bedrock/amazon.nova-lite-v1:0",
      );
      expect(hint).not.toBeNull();
      expect(hint).toContain("not available");
      expect(hint).toContain("us-east-1");
      expect(hint).toContain("bedrock/amazon.nova-lite-v1:0");
    });

    it("detects ValidationException model identifier errors", () => {
      const hint = detectBedrockRegionError(
        new Error(
          "ValidationException: The provided model identifier is invalid.",
        ),
        "eu-west-2",
        "bedrock/anthropic.claude-3-haiku-20240307-v1:0",
      );
      expect(hint).not.toBeNull();
      expect(hint).toContain("eu-west-2");
    });

    it("detects ResourceNotFoundException", () => {
      const hint = detectBedrockRegionError(
        new Error(
          "ResourceNotFoundException: Could not resolve the foundation model from the provided model identifier",
        ),
        "ap-south-1",
        "bedrock/amazon.nova-lite-v1:0",
      );
      expect(hint).not.toBeNull();
    });

    it("recommends switching AWS_REGION when caller is on a non-canonical region", () => {
      const hint = detectBedrockRegionError(
        new Error("AccessDeniedException"),
        "ap-south-1",
        "bedrock/amazon.nova-lite-v1:0",
      );
      expect(hint).toContain("Set AWS_REGION");
      expect(hint).toContain("us-east-1");
    });

    it("recommends model-access enrollment when caller is on a canonical region", () => {
      const hint = detectBedrockRegionError(
        new Error("AccessDeniedException"),
        "us-east-1",
        "bedrock/amazon.nova-lite-v1:0",
      );
      expect(hint).toContain("Bedrock console");
      expect(hint).toContain("Model access");
    });

    it("includes the original AWS error message for debuggability", () => {
      const original = "AccessDeniedException: account 999 lacks model access";
      const hint = detectBedrockRegionError(
        new Error(original),
        "us-east-1",
        "bedrock/amazon.nova-lite-v1:0",
      );
      expect(hint).toContain(original);
    });

    it("KNOWN_BEDROCK_REGIONS contains the canonical big-three", () => {
      expect(KNOWN_BEDROCK_REGIONS).toContain("us-east-1");
      expect(KNOWN_BEDROCK_REGIONS).toContain("us-west-2");
      expect(KNOWN_BEDROCK_REGIONS).toContain("eu-central-1");
    });
  });

  // ── Wave 12 P2: end-to-end propagation through generateText ──────────────
  describe("region error propagation through generateText (Wave 12 P2)", () => {
    it("wraps Bedrock AccessDeniedException with the actionable hint", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error(
          "AccessDeniedException: You don't have access to the model with the specified model ID.",
        ),
      );

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err, text] = await adapter.generateText("Hello");

      expect(text).toBeNull();
      expect(err).toBeInstanceOf(LlmError);
      expect(err!.message).toContain("not available");
      expect(err!.message).toContain("bedrock/amazon.nova-lite-v1:0");
      expect(err!.message).toMatch(/AWS_REGION=[a-z0-9-]+/);
    });

    it("wraps Bedrock errors via generateStructured too", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error(
          "ResourceNotFoundException: Could not resolve the foundation model",
        ),
      );

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err] = await adapter.generateStructured(
        "Classify this",
        z.object({ resourceType: z.string() }),
      );

      expect(err).toBeInstanceOf(LlmError);
      expect(err!.message).toContain("not available");
    });

    it("does NOT wrap unrelated errors (preserves original message)", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error("ECONNRESET: socket hang up"),
      );

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err] = await adapter.generateText("Hello");

      expect(err).toBeInstanceOf(LlmError);
      expect(err!.message).toContain("Text LLM call failed");
      expect(err!.message).toContain("ECONNRESET");
      expect(err!.message).not.toContain("not available");
    });

    it("does NOT wrap non-bedrock provider errors with the bedrock hint", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error("AccessDeniedException: anthropic key revoked"),
      );

      const adapter = new LlmAdapter({
        modelString: "anthropic/claude-sonnet-4-5",
      });
      const [err] = await adapter.generateText("Hello");

      expect(err).toBeInstanceOf(LlmError);
      expect(err!.message).toContain("Text LLM call failed");
      expect(err!.message).not.toContain("AWS_REGION");
    });
  });
});
