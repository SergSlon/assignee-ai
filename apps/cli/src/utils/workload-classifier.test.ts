import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  classifyWorkload,
  _clearClassificationCache,
  type WorkloadProfile,
} from "./workload-classifier.js";
import { MockLlmAdapter } from "@assignee/core/testing";

describe("classifyWorkload", () => {
  beforeEach(() => {
    _clearClassificationCache();
  });

  it('classifies "ML training" as gpu-accelerated', async () => {
    const llm = new MockLlmAdapter({
      profile: "gpu-accelerated",
      confidence: 0.92,
    });
    const result = await classifyWorkload("ML training on GPU instances", llm);
    expect(result).toBe("gpu-accelerated");
  });

  it('classifies "small API" as burstable or general-purpose', async () => {
    const llm = new MockLlmAdapter({
      profile: "burstable",
      confidence: 0.78,
    });
    const result = await classifyWorkload("small API for my side project", llm);
    expect(["burstable", "general-purpose"]).toContain(result);
  });

  it('returns "unknown" when LLM fails', async () => {
    const llm = new MockLlmAdapter(undefined, "", true, "LLM is down");
    const result = await classifyWorkload("some workload", llm);
    expect(result).toBe("unknown");
  });

  it('returns "unknown" when confidence is below 0.5', async () => {
    const llm = new MockLlmAdapter({
      profile: "compute-heavy",
      confidence: 0.3,
    });
    const result = await classifyWorkload("do something with servers", llm);
    expect(result).toBe("unknown");
  });

  it('returns "unknown" for empty intent', async () => {
    const llm = new MockLlmAdapter({
      profile: "general-purpose",
      confidence: 0.9,
    });
    const result = await classifyWorkload("", llm);
    expect(result).toBe("unknown");
  });

  it("caches result — LLM called only once for the same intent", async () => {
    const structuredResponse = {
      profile: "memory-intensive" as WorkloadProfile,
      confidence: 0.85,
    };
    const generateStructuredSpy = vi
      .fn()
      .mockResolvedValue([null, structuredResponse] as const);

    const llm = {
      generateStructured: generateStructuredSpy,
      generateText: vi.fn(),
    };

    const result1 = await classifyWorkload("Redis cache cluster", llm);
    const result2 = await classifyWorkload("Redis cache cluster", llm);

    expect(result1).toBe("memory-intensive");
    expect(result2).toBe("memory-intensive");
    expect(generateStructuredSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache across different intents", async () => {
    const generateStructuredSpy = vi
      .fn()
      .mockResolvedValueOnce([
        null,
        { profile: "gpu-accelerated", confidence: 0.9 },
      ] as const)
      .mockResolvedValueOnce([
        null,
        { profile: "storage-heavy", confidence: 0.88 },
      ] as const);

    const llm = {
      generateStructured: generateStructuredSpy,
      generateText: vi.fn(),
    };

    const r1 = await classifyWorkload("ML training pipeline", llm);
    const r2 = await classifyWorkload("data lake for backups", llm);

    expect(r1).toBe("gpu-accelerated");
    expect(r2).toBe("storage-heavy");
    expect(generateStructuredSpy).toHaveBeenCalledTimes(2);
  });

  // Story 44.1: verify callsite tag is passed to LLM
  it("passes callsite 'workload_classifier' to generateStructured", async () => {
    const generateStructuredSpy = vi
      .fn()
      .mockResolvedValueOnce([
        null,
        { profile: "general-purpose", confidence: 0.9 },
      ] as const);

    const llm = {
      generateStructured: generateStructuredSpy,
      generateText: vi.fn(),
    };

    await classifyWorkload("web application", llm);
    expect(generateStructuredSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ callsite: "workload_classifier" }),
    );
  });
});
