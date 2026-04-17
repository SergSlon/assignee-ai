/**
 * Unit tests for the in-core model-parser (Story 50-4 Wave 5.1).
 *
 * Lifted from `apps/cli/src/services/__tests__/llm-adapter.test.ts`
 * (only the model-parser describe blocks). The CLI test continues to
 * exist and will exercise the same functions through the shim chain
 * — duplicating the assertions in core lets us keep coverage high
 * even when (in a future wave) the CLI shim is removed entirely.
 */
import { describe, it, expect } from "vitest";
import { LlmError } from "../errors.js";
import {
  parseModelString,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} from "./model-parser.js";

describe("parseModelString", () => {
  it("parses anthropic/<model-id>", () => {
    const result = parseModelString("anthropic/claude-sonnet-4-5");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-5");
  });

  it("parses openai/<model-id>", () => {
    const result = parseModelString("openai/gpt-4o");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
  });

  it("parses bedrock/<model-id> (including a colon-bearing model id)", () => {
    const result = parseModelString("bedrock/amazon.nova-lite-v1:0");
    expect(result.provider).toBe("bedrock");
    expect(result.modelId).toBe("amazon.nova-lite-v1:0");
  });

  it("parses ollama/<model-id>", () => {
    const result = parseModelString("ollama/llama3");
    expect(result.provider).toBe("ollama");
    expect(result.modelId).toBe("llama3");
  });

  it("parses google/<model-id>", () => {
    const result = parseModelString("google/gemini-2.0-flash");
    expect(result.provider).toBe("google");
    expect(result.modelId).toBe("gemini-2.0-flash");
  });

  it("throws LlmError when no slash present", () => {
    expect(() => parseModelString("just-a-model")).toThrow(LlmError);
    expect(() => parseModelString("just-a-model")).toThrow(
      /Expected "provider\/model-id"/,
    );
  });

  it("throws LlmError when modelId is empty after slash", () => {
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
  it("defaults to bedrock/amazon.nova-lite-v1:0", () => {
    expect(DEFAULT_MODEL).toBe("bedrock/amazon.nova-lite-v1:0");
  });
});

describe("DEFAULT_MAX_TOKENS", () => {
  it("equals 1024 (NFR-15 cap)", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(1024);
  });
});
