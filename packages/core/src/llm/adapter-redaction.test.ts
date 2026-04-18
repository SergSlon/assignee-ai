/**
 * LlmAdapter outbound redaction tests (Story 54-it1-05, L5-H2).
 *
 * Defence-in-depth: every prompt dispatched through `generateText` or
 * `generateStructured` is passed through `redactSensitive` so full ARNs
 * and 12-digit account IDs cannot leak to the backing LLM. The Bedrock
 * path is the only active provider today but the adapter contract is
 * provider-agnostic; future providers may not be equally trusted with
 * raw identifiers.
 *
 * Invariants pinned here:
 *   - Full ARN → `[ARN]` at the send-command argument.
 *   - Bare 12-digit account ID → `[ACCOUNT]`.
 *   - Partition-aware: `arn:aws-cn:…`, `arn:aws-us-gov:…` also redacted.
 *   - Clean prompt passes through verbatim.
 *   - Bedrock region-error hint wrapping still fires with redacted prompt.
 *   - Token-cost `callsite` still propagates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

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

import { LlmAdapter } from "./index.js";
import { generateText } from "ai";

const savedEnv = { ...process.env };

/** Helper: read the `messages[0].content` string from the most recent
 *  mocked `generateText` call. */
function lastSentPromptContent(): string {
  const args = vi.mocked(generateText).mock.calls[0]?.[0] as
    | { messages?: Array<{ role: string; content: string }> }
    | undefined;
  const content = args?.messages?.[0]?.content;
  if (typeof content !== "string") {
    throw new Error(
      `Expected string message content, got ${typeof content}: ${JSON.stringify(content)}`,
    );
  }
  return content;
}

describe("LlmAdapter outbound redaction — generateText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateText).mockResolvedValue({
      text: "mock text",
      output: { resourceType: "AWS::S3::Bucket" },
    } as never);
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("redacts a full commercial ARN in the outbound prompt", async () => {
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    await adapter.generateText(
      "attach arn:aws:iam::123456789012:role/assignee-operator to the lambda",
    );

    const sent = lastSentPromptContent();
    expect(sent).toBe("attach [ARN] to the lambda");
    expect(sent).not.toContain("123456789012");
    expect(sent).not.toContain("assignee-operator");
  });

  it("redacts a bare 12-digit account ID to [ACCOUNT]", async () => {
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    await adapter.generateText(
      "the caller account id is 123456789012 and the target is 987654321098",
    );

    const sent = lastSentPromptContent();
    expect(sent).toBe(
      "the caller account id is [ACCOUNT] and the target is [ACCOUNT]",
    );
    expect(sent).not.toContain("123456789012");
    expect(sent).not.toContain("987654321098");
  });

  it("redacts GovCloud (arn:aws-us-gov:…) ARN — partition-aware", async () => {
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    await adapter.generateText(
      "GovCloud role arn:aws-us-gov:iam::123456789012:role/gov-ops ready",
    );

    const sent = lastSentPromptContent();
    expect(sent).toBe("GovCloud role [ARN] ready");
    expect(sent).not.toContain("123456789012");
  });

  it("redacts China-partition (arn:aws-cn:…) ARN — partition-aware", async () => {
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    await adapter.generateText(
      "notify arn:aws-cn:sns:cn-north-1:123456789012:assignee-alerts on failure",
    );

    const sent = lastSentPromptContent();
    expect(sent).toBe("notify [ARN] on failure");
    expect(sent).not.toContain("123456789012");
    expect(sent).not.toContain("assignee-alerts");
  });

  it("leaves a non-sensitive prompt untouched (pass-through)", async () => {
    const original =
      "Create a t3.micro EC2 instance in us-east-1 with SSH access from 10.0.0.0/8";
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    await adapter.generateText(original);

    expect(lastSentPromptContent()).toBe(original);
  });

  it("still propagates `callsite` to token-usage (feedback_token_cost_visibility)", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 42, outputTokens: 7, totalTokens: 49 },
    } as never);
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    // Redaction happens regardless of callsite — assert the SDK still
    // received maxTokens + role=user message (the callsite itself lands
    // in token-usage which is tested in token-usage.test.ts).
    await adapter.generateText("account 123456789012 request", {
      callsite: "plan_generator",
      runId: "run-abc",
      maxTokens: 2048,
    });

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 2048,
        messages: [{ role: "user", content: "account [ACCOUNT] request" }],
      }),
    );
  });

  it("preserves Bedrock region-error hint wrapping with redacted prompt", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error(
        "AccessDeniedException: You don't have access to the model with the specified model ID.",
      ),
    );
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    const [err] = await adapter.generateText("fail for account 123456789012");

    expect(err).not.toBeNull();
    expect(err?.message).toContain("not available");
    expect(err?.message).toContain("bedrock/amazon.nova-lite-v1:0");
    // The redacted prompt still reached the SDK.
    expect(lastSentPromptContent()).toBe("fail for account [ACCOUNT]");
  });
});

describe("LlmAdapter outbound redaction — generateStructured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateText).mockResolvedValue({
      text: "mock text",
      output: { resourceType: "AWS::S3::Bucket" },
    } as never);
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("redacts a full ARN in the outbound structured-call prompt", async () => {
    const schema = z.object({ resourceType: z.string() });
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    await adapter.generateStructured(
      "classify arn:aws:iam::123456789012:role/assignee-operator",
      schema,
    );

    const sent = lastSentPromptContent();
    expect(sent).toBe("classify [ARN]");
    expect(sent).not.toContain("123456789012");
  });

  it("redacts account IDs in structured-call prompts", async () => {
    const schema = z.object({ resourceType: z.string() });
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    await adapter.generateStructured(
      "classify this resource for account 123456789012",
      schema,
    );

    expect(lastSentPromptContent()).toBe(
      "classify this resource for account [ACCOUNT]",
    );
  });

  it("redacts ISO-partition ARNs (partition-aware)", async () => {
    const schema = z.object({ resourceType: z.string() });
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    await adapter.generateStructured(
      "key arn:aws-iso:kms:us-iso-east-1:123456789012:key/abcd-1234 is stale",
      schema,
    );

    const sent = lastSentPromptContent();
    expect(sent).toBe("key [ARN] is stale");
    expect(sent).not.toContain("123456789012");
  });

  it("leaves clean structured prompt untouched", async () => {
    const schema = z.object({ resourceType: z.string() });
    const original =
      "Classify this AWS infrastructure request into one of these types";
    const adapter = new LlmAdapter({
      modelString: "bedrock/amazon.nova-lite-v1:0",
    });
    await adapter.generateStructured(original, schema);

    expect(lastSentPromptContent()).toBe(original);
  });
});
