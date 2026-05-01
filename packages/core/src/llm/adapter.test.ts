import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { z } from "zod";
import { LlmError } from "../errors.js";
import { isRetryableError, backoffDelayMs } from "./adapter.js";

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
} from "./index.js";
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
      /Invalid ASSIGNEE_LLM_DEFAULT format/,
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
    // Tier C: strengthened — assert it's actually an LlmAdapter instance
    const adapter = new LlmAdapter();
    expect(adapter).toBeInstanceOf(LlmAdapter);
  });

  it("accepts explicit modelString", () => {
    // Tier C: strengthened — instanceof check
    const adapter = new LlmAdapter({
      modelString: "anthropic/claude-sonnet-4-5",
    });
    expect(adapter).toBeInstanceOf(LlmAdapter);
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

  // ── P018: Guardrail-missing warning ────────────────────────────────────
  describe("guardrail-missing warning (P018)", () => {
    let stderrSpy: MockInstance;

    beforeEach(() => {
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      // Ensure disable flag is clear before each test
      delete process.env["BEDROCK_GUARDRAIL_DISABLE"];
    });

    afterEach(() => {
      stderrSpy.mockRestore();
      delete process.env["BEDROCK_GUARDRAIL_DISABLE"];
    });

    it("emits warning when Bedrock provider has no guardrailId configured", () => {
      new LlmAdapter({ modelString: "bedrock/amazon.nova-lite-v1:0" });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const written = String(stderrSpy.mock.calls[0]?.[0] ?? "");
      expect(written).toContain(
        "WARNING: Bedrock invocations are running WITHOUT a Guardrail",
      );
      expect(written).toContain("BEDROCK_GUARDRAIL_ID");
      expect(written).toContain("BEDROCK_GUARDRAIL_DISABLE=1");
      expect(written).toContain("assignee doctor");
    });

    it("does NOT emit warning when guardrailId is provided", () => {
      new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
        guardrailId: "abcd1234efgh",
        guardrailVersion: "1",
      });

      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does NOT emit warning when BEDROCK_GUARDRAIL_DISABLE=1", () => {
      process.env["BEDROCK_GUARDRAIL_DISABLE"] = "1";
      new LlmAdapter({ modelString: "bedrock/amazon.nova-lite-v1:0" });

      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does NOT emit warning when BEDROCK_GUARDRAIL_DISABLE=true", () => {
      process.env["BEDROCK_GUARDRAIL_DISABLE"] = "true";
      new LlmAdapter({ modelString: "bedrock/amazon.nova-lite-v1:0" });

      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does NOT emit warning for non-bedrock providers (anthropic)", () => {
      new LlmAdapter({ modelString: "anthropic/claude-sonnet-4-5" });

      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does NOT emit warning for non-bedrock providers (openai)", () => {
      new LlmAdapter({ modelString: "openai/gpt-4o" });

      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does NOT emit warning for non-bedrock providers (google)", () => {
      new LlmAdapter({ modelString: "google/gemini-2.0-flash" });

      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("emits warning once per adapter instance (not per invocation)", () => {
      // Warning fires at constructor time — not on each generateText call
      new LlmAdapter({ modelString: "bedrock/amazon.nova-lite-v1:0" });
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      // Resetting to check construction creates exactly one warning per instance
      stderrSpy.mockClear();
      new LlmAdapter({ modelString: "bedrock/amazon.nova-lite-v1:0" });
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("isGuardrailDisabled returns true for '1'", () => {
      process.env["BEDROCK_GUARDRAIL_DISABLE"] = "1";
      expect(LlmAdapter.isGuardrailDisabled()).toBe(true);
    });

    it("isGuardrailDisabled returns true for 'true'", () => {
      process.env["BEDROCK_GUARDRAIL_DISABLE"] = "true";
      expect(LlmAdapter.isGuardrailDisabled()).toBe(true);
    });

    it("isGuardrailDisabled returns false when unset", () => {
      delete process.env["BEDROCK_GUARDRAIL_DISABLE"];
      expect(LlmAdapter.isGuardrailDisabled()).toBe(false);
    });

    it("isGuardrailDisabled returns false for arbitrary truthy strings (non-standard opt-out)", () => {
      process.env["BEDROCK_GUARDRAIL_DISABLE"] = "yes";
      expect(LlmAdapter.isGuardrailDisabled()).toBe(false);
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

  // ── W11-S4: isRetryableError unit tests ────────────────────────────────────
  describe("isRetryableError", () => {
    it("returns true for ThrottlingException in message", () => {
      expect(
        isRetryableError(new Error("ThrottlingException: Rate exceeded")),
      ).toBe(true);
    });

    it("returns true for ThrottlingException in error name", () => {
      const err = new Error("Rate exceeded");
      err.name = "ThrottlingException";
      expect(isRetryableError(err)).toBe(true);
    });

    it("returns true for ServiceUnavailableException", () => {
      expect(
        isRetryableError(
          new Error("ServiceUnavailableException: service is down"),
        ),
      ).toBe(true);
    });

    it("returns true for TooManyRequestsException", () => {
      expect(
        isRetryableError(new Error("TooManyRequestsException: quota exceeded")),
      ).toBe(true);
    });

    it("returns false for AccessDeniedException (auth error)", () => {
      expect(
        isRetryableError(new Error("AccessDeniedException: not authorized")),
      ).toBe(false);
    });

    it("returns false for ValidationException (config error)", () => {
      expect(
        isRetryableError(new Error("ValidationException: invalid model id")),
      ).toBe(false);
    });

    it("returns false for network ECONNRESET", () => {
      expect(isRetryableError(new Error("ECONNRESET: socket hang up"))).toBe(
        false,
      );
    });

    it("returns false for non-Error values", () => {
      expect(isRetryableError("ThrottlingException")).toBe(false);
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(42)).toBe(false);
    });
  });

  // ── W11-S4: backoffDelayMs unit tests ─────────────────────────────────────
  describe("backoffDelayMs", () => {
    it("returns a non-negative number", () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        expect(backoffDelayMs(attempt, 1000)).toBeGreaterThanOrEqual(0);
      }
    });

    it("is bounded by 16× baseMs + jitter window", () => {
      // For base=1000 the exponential cap is 1000*16 = 16000; jitter adds up to
      // MAX_JITTER_WINDOW_MS (1000). The helper uses min(cap, cap+jitter) which
      // means ceil is cap itself (Math.min(cap, cap+1000) = cap = 16000).
      for (let attempt = 0; attempt < 10; attempt++) {
        const delay = backoffDelayMs(attempt, 1000);
        expect(delay).toBeLessThanOrEqual(17_000); // cap + jitter
      }
    });

    it("is always < base for attempt 0 at base 100", () => {
      // attempt 0: exponential = 100*1 = 100; cap = 100; result in [0, 100)
      for (let i = 0; i < 20; i++) {
        expect(backoffDelayMs(0, 100)).toBeLessThanOrEqual(100);
      }
    });
  });

  // ── W11-S4: end-to-end retry behaviour through LlmAdapter ─────────────────
  describe("retry on ThrottlingException (W11-S4)", () => {
    beforeEach(() => {
      // Zero out retry delay so tests don't actually sleep.
      process.env["ASSIGNEE_LLM_MAX_RETRIES"] = "3";
      process.env["ASSIGNEE_LLM_RETRY_BASE_MS"] = "0";
    });

    afterEach(() => {
      delete process.env["ASSIGNEE_LLM_MAX_RETRIES"];
      delete process.env["ASSIGNEE_LLM_RETRY_BASE_MS"];
    });

    it("retries generateText on ThrottlingException and succeeds on 2nd attempt", async () => {
      vi.mocked(generateText)
        .mockRejectedValueOnce(new Error("ThrottlingException: Rate exceeded"))
        .mockResolvedValueOnce({
          text: "success after throttle",
          output: {},
        } as never);

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err, result] = await adapter.generateText("Hello");

      expect(err).toBeNull();
      expect(result).toBe("success after throttle");
      expect(generateText).toHaveBeenCalledTimes(2);
    });

    it("retries generateStructured on ServiceUnavailableException and succeeds on 3rd attempt", async () => {
      const schema = z.object({ resourceType: z.string() });
      vi.mocked(generateText)
        .mockRejectedValueOnce(
          new Error("ServiceUnavailableException: service down"),
        )
        .mockRejectedValueOnce(
          new Error("ServiceUnavailableException: still down"),
        )
        .mockResolvedValueOnce({
          text: "",
          output: { resourceType: "AWS::S3::Bucket" },
        } as never);

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err, result] = await adapter.generateStructured(
        "Parse this",
        schema,
      );

      expect(err).toBeNull();
      expect(result).toEqual({ resourceType: "AWS::S3::Bucket" });
      expect(generateText).toHaveBeenCalledTimes(3);
    });

    it("exhausts retries and returns LlmError after 4 total attempts (3 retries)", async () => {
      vi.mocked(generateText).mockRejectedValue(
        new Error("ThrottlingException: persistent throttle"),
      );

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err, result] = await adapter.generateText("Hello");

      expect(result).toBeNull();
      expect(err).toBeInstanceOf(LlmError);
      expect(err!.message).toContain("Text LLM call failed");
      // 1 initial + 3 retries = 4 calls
      expect(generateText).toHaveBeenCalledTimes(4);
    });

    it("does NOT retry AccessDeniedException (non-retryable) — fails immediately", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error("AccessDeniedException: not authorized"),
      );

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err] = await adapter.generateText("Hello");

      expect(err).toBeInstanceOf(LlmError);
      // Must NOT retry — only 1 call
      expect(generateText).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry ValidationException (non-retryable) — fails immediately", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error("ValidationException: invalid model"),
      );

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err] = await adapter.generateText("Hello");

      expect(err).toBeInstanceOf(LlmError);
      expect(generateText).toHaveBeenCalledTimes(1);
    });

    it("respects ASSIGNEE_LLM_MAX_RETRIES=1 env override", async () => {
      process.env["ASSIGNEE_LLM_MAX_RETRIES"] = "1";
      vi.mocked(generateText).mockRejectedValue(
        new Error("ThrottlingException: throttled"),
      );

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      await adapter.generateText("Hello");

      // 1 initial + 1 retry = 2 calls
      expect(generateText).toHaveBeenCalledTimes(2);
    });

    it("retries generateText on TooManyRequestsException", async () => {
      vi.mocked(generateText)
        .mockRejectedValueOnce(new Error("TooManyRequestsException: quota"))
        .mockResolvedValueOnce({
          text: "ok",
          output: {},
        } as never);

      const adapter = new LlmAdapter({
        modelString: "bedrock/amazon.nova-lite-v1:0",
      });
      const [err, result] = await adapter.generateText("Hello");

      expect(err).toBeNull();
      expect(result).toBe("ok");
      expect(generateText).toHaveBeenCalledTimes(2);
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
