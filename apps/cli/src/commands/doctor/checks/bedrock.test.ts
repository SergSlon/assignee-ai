/**
 * Tests for the doctor `checkBedrock` function — P018 guardrail-missing
 * finding plus existing LLM reachability behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkBedrock } from "./bedrock.js";

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

  it("does NOT add guardrail-missing sub-check when BEDROCK_GUARDRAIL_DISABLE=true", async () => {
    process.env["BEDROCK_GUARDRAIL_DISABLE"] = "true";

    const result = await checkBedrock({ llmFactory: makeMockLlmFactory() });

    const guardrailSub = result.subs.find((s) => s.label.includes("Guardrail"));
    expect(guardrailSub!.status).toBe("ok");
    expect(guardrailSub!.detail).toContain("operator accepted risk");
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
