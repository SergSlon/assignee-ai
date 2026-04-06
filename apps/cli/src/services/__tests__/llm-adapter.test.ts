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
      output: { foo: "bar" },
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
      const schema = z.object({ foo: z.string() });
      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });

      const [err, result] = await adapter.generateStructured(
        "Parse this",
        schema,
      );

      expect(err).toBeNull();
      expect(result).toEqual({ foo: "bar" });
    });

    it("returns LlmError on failure", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(new Error("schema fail"));

      const schema = z.object({ foo: z.string() });
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
});
