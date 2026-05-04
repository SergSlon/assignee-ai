/**
 * Tests for the doctor `checkBedrock` function — P018 guardrail-missing
 * finding plus existing LLM reachability behaviour, and PR-007 model
 * lifecycle pre-flight (W24b-S2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkBedrock } from "./bedrock.js";
import type { BedrockLifecycleClient } from "@assignee/core/llm";

const savedEnv = { ...process.env };

// ── helpers ──────────────────────────────────────────────────────────────────

/** A factory that returns a mock adapter whose generateText resolves OK. */
function makeMockLlmFactory(
  result: readonly [Error | null, string | null] = [null, "hello there"],
) {
  return () => ({
    generateText: vi.fn().mockResolvedValue(result),
  });
}

/** Build a mock lifecycle client that resolves to the given payload. */
function makeLifecycleClient(
  lifecycle:
    | { status?: string; endOfLifeTime?: Date; legacyTime?: Date }
    | undefined,
): BedrockLifecycleClient {
  return {
    send: vi.fn().mockResolvedValue({
      modelDetails:
        lifecycle !== undefined ? { modelLifecycle: lifecycle } : {},
    }),
  };
}

/** Build a mock lifecycle client that throws. */
function makeThrowingLifecycleClient(err: Error): BedrockLifecycleClient {
  return {
    send: vi.fn().mockRejectedValue(err),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("checkBedrock — P018 guardrail-missing finding", () => {
  beforeEach(() => {
    // Use a bedrock model so guardrail checks are active
    process.env["ASSIGNEE_LLM_DEFAULT"] = "bedrock/amazon.nova-lite-v1:0";
    delete process.env["BEDROCK_GUARDRAIL_ID"];
    delete process.env["BEDROCK_GUARDRAIL_VERSION"];
    delete process.env["BEDROCK_GUARDRAIL_DISABLE"];
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("adds a HIGH-severity warn sub-check when Bedrock active + no guardrail", async () => {
    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailSub = result.subs.find((s) => s.label.includes("Guardrail"));
    expect(guardrailSub).toBeDefined();
    expect(guardrailSub!.status).toBe("warn");
    expect(guardrailSub!.label).toContain("[HIGH]");
  });

  it("guardrail warn sub-check detail mentions PII, harmful topics, and jailbreak", async () => {
    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailSub = result.subs.find((s) => s.label.includes("Guardrail"));
    expect(guardrailSub!.detail).toContain("PII");
    expect(guardrailSub!.detail).toContain("harmful topics");
    expect(guardrailSub!.detail).toContain("jailbreak");
  });

  it("guardrail warn sub-check detail includes BEDROCK_GUARDRAIL_ID hint", async () => {
    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailSub = result.subs.find((s) => s.label.includes("Guardrail"));
    expect(guardrailSub!.detail).toContain("BEDROCK_GUARDRAIL_ID");
    expect(guardrailSub!.detail).toContain("BEDROCK_GUARDRAIL_VERSION");
  });

  it("guardrail warn sub-check detail includes aws bedrock create-guardrail reference", async () => {
    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailSub = result.subs.find((s) => s.label.includes("Guardrail"));
    expect(guardrailSub!.detail).toContain("aws bedrock create-guardrail");
  });

  it("guardrail warn sub-check detail includes BEDROCK_GUARDRAIL_DISABLE suppress hint", async () => {
    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailSub = result.subs.find((s) => s.label.includes("Guardrail"));
    expect(guardrailSub!.detail).toContain("BEDROCK_GUARDRAIL_DISABLE=1");
  });

  it("rolls up to warn when guardrail missing (LLM ok, guardrail missing)", async () => {
    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    expect(result.status).toBe("warn");
  });

  it("does NOT add guardrail-missing sub-check when BEDROCK_GUARDRAIL_ID is set", async () => {
    process.env["BEDROCK_GUARDRAIL_ID"] = "abcd1234efgh";
    process.env["BEDROCK_GUARDRAIL_VERSION"] = "1";

    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailSub = result.subs.find((s) => s.label.includes("Guardrail"));
    expect(guardrailSub).toBeDefined();
    expect(guardrailSub!.status).toBe("ok");
    expect(guardrailSub!.label).not.toContain("[HIGH]");
    expect(guardrailSub!.detail).toContain("(configured)");
  });

  it("does NOT add guardrail-missing sub-check when BEDROCK_GUARDRAIL_DISABLE=1", async () => {
    process.env["BEDROCK_GUARDRAIL_DISABLE"] = "1";

    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailSub = result.subs.find((s) => s.label.includes("Guardrail"));
    expect(guardrailSub).toBeDefined();
    expect(guardrailSub!.status).toBe("ok");
    expect(guardrailSub!.label).not.toContain("[HIGH]");
    expect(guardrailSub!.detail).toContain("operator accepted risk");
  });

  it('F005: BEDROCK_GUARDRAIL_DISABLE="true" is REJECTED by the strict parser (parity with LlmAdapter)', async () => {
    // Wave A F005 — pre-fix: doctor accepted "true" as truthy and showed
    // green "operator accepted risk" while LlmAdapter (post-SEC-036)
    // accepted ONLY "1". Operator thought setup was correct, then every
    // plan/apply threw GuardrailRequiredError. parseBoolEnv now matches
    // the adapter; "true" produces the warn surface.
    process.env["BEDROCK_GUARDRAIL_DISABLE"] = "true";

    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailSub = result.subs.find((s) => s.label.includes("Guardrail"));
    expect(guardrailSub).toBeDefined();
    // Doctor + adapter agree: "true" is NOT a valid disable token.
    expect(guardrailSub!.status).not.toBe("ok");
    expect(guardrailSub!.detail).not.toContain("operator accepted risk");
  });

  it("does NOT add guardrail-missing sub-check for non-bedrock provider", async () => {
    process.env["ASSIGNEE_LLM_DEFAULT"] = "anthropic/claude-sonnet-4-5";

    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailHighSub = result.subs.find(
      (s) => s.label.includes("Guardrail") && s.label.includes("[HIGH]"),
    );
    expect(guardrailHighSub).toBeUndefined();
  });

  it("LLM sub-check is ok when adapter returns text", async () => {
    const result = await checkBedrock({
      llmFactory: makeMockLlmFactory([null, "some response text"]),
    });

    const llmSub = result.subs.find((s) => s.label.includes("LLM"));
    expect(llmSub).toBeDefined();
    expect(llmSub!.status).toBe("ok");
  });

  it("LLM sub-check is fail when adapter returns an error", async () => {
    const result = await checkBedrock({
      llmFactory: makeMockLlmFactory([new Error("model not found"), null]),
    });

    const llmSub = result.subs.find((s) => s.label.includes("LLM"));
    expect(llmSub).toBeDefined();
    expect(llmSub!.status).toBe("fail");
    expect(llmSub!.detail).toContain("model not found");
  });

  it("section name includes guardrail id when configured", async () => {
    process.env["BEDROCK_GUARDRAIL_ID"] = "xyz9876";
    process.env["BEDROCK_GUARDRAIL_VERSION"] = "2";

    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    expect(result.name).toContain("xyz9876:2");
  });

  it("section name omits guardrail when not configured", async () => {
    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    expect(result.name).not.toContain("guardrail");
  });
});

// ── PR-007 / W24b-S2: model lifecycle pre-flight tests ───────────────────────

describe("checkBedrock — PR-007 model lifecycle pre-flight", () => {
  beforeEach(() => {
    process.env["ASSIGNEE_LLM_DEFAULT"] = "bedrock/amazon.nova-lite-v1:0";
    delete process.env["BEDROCK_GUARDRAIL_ID"];
    delete process.env["BEDROCK_GUARDRAIL_DISABLE"];
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("adds an ok 'Model lifecycle' sub-check when model is ACTIVE", async () => {
    const result = await checkBedrock({
      llmFactory: makeMockLlmFactory(),
      lifecycleClient: makeLifecycleClient({ status: "ACTIVE" }),
    });

    const lifecycleSub = result.subs.find((s) =>
      s.label.includes("Model lifecycle"),
    );
    expect(lifecycleSub).toBeDefined();
    expect(lifecycleSub!.status).toBe("ok");
    expect(lifecycleSub!.detail).toContain("ACTIVE");
  });

  it("adds a warn 'Model lifecycle [!]' sub-check when model is LEGACY", async () => {
    const result = await checkBedrock({
      llmFactory: makeMockLlmFactory(),
      lifecycleClient: makeLifecycleClient({ status: "LEGACY" }),
    });

    const lifecycleSub = result.subs.find((s) =>
      s.label.includes("Model lifecycle"),
    );
    expect(lifecycleSub).toBeDefined();
    expect(lifecycleSub!.status).toBe("warn");
    expect(lifecycleSub!.label).toContain("[!]");
  });

  it("LEGACY warn includes EOL date and ASSIGNEE_LLM_DEFAULT hint in detail", async () => {
    const eolDate = new Date("2025-09-30T00:00:00.000Z");
    const legacyDate = new Date("2025-03-01T00:00:00.000Z");
    const result = await checkBedrock({
      llmFactory: makeMockLlmFactory(),
      lifecycleClient: makeLifecycleClient({
        status: "LEGACY",
        endOfLifeTime: eolDate,
        legacyTime: legacyDate,
      }),
    });

    const lifecycleSub = result.subs.find((s) =>
      s.label.includes("Model lifecycle"),
    );
    expect(lifecycleSub!.detail).toContain("2025-09-30");
    expect(lifecycleSub!.detail).toContain("2025-03-01");
    expect(lifecycleSub!.detail).toContain("ASSIGNEE_LLM_DEFAULT");
  });

  it("section status rolls up to warn when model is LEGACY (and LLM ok)", async () => {
    const result = await checkBedrock({
      llmFactory: makeMockLlmFactory(),
      lifecycleClient: makeLifecycleClient({ status: "LEGACY" }),
    });

    expect(result.status).toBe("warn");
  });

  it("silently skips lifecycle sub-check when SDK throws (no crash)", async () => {
    const err = new Error(
      "ResourceNotFoundException: model amazon.nova-lite-v1:0 not found",
    );
    const result = await checkBedrock({
      llmFactory: makeMockLlmFactory(),
      lifecycleClient: makeThrowingLifecycleClient(err),
    });

    const lifecycleSub = result.subs.find((s) =>
      s.label.includes("Model lifecycle"),
    );
    expect(lifecycleSub).toBeUndefined();
    // Section should still be ok/warn from guardrail (not fail from lifecycle crash).
    expect(result.status).not.toBe("fail");
  });

  it("skips lifecycle sub-check entirely when lifecycleClient is null", async () => {
    const result = await checkBedrock({
      llmFactory: makeMockLlmFactory(),
      lifecycleClient: null,
    });

    const lifecycleSub = result.subs.find((s) =>
      s.label.includes("Model lifecycle"),
    );
    expect(lifecycleSub).toBeUndefined();
  });

  it("skips lifecycle sub-check for non-bedrock providers", async () => {
    process.env["ASSIGNEE_LLM_DEFAULT"] = "anthropic/claude-sonnet-4-5";

    const result = await checkBedrock({
      llmFactory: makeMockLlmFactory(),
      lifecycleClient: makeLifecycleClient({ status: "LEGACY" }),
    });

    // Even though a lifecycle client was injected, it should NOT be consulted
    // because the provider is not bedrock/.
    const lifecycleSub = result.subs.find((s) =>
      s.label.includes("Model lifecycle"),
    );
    expect(lifecycleSub).toBeUndefined();
  });
});
