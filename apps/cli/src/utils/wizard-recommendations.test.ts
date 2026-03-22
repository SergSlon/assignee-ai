import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@assignee/core";
import {
  evaluateWizardRecommendations,
  RECOMMENDATION_RULES,
} from "./wizard-recommendations.js";

describe("wizard-recommendations — Lambda rules", () => {
  // ── Task 3.2 / AC #4: lambda-low-memory-api ──────────────────────────

  it("triggers lambda-low-memory-api when MemorySize=128 and intent contains api", () => {
    const recs = evaluateWizardRecommendations(
      { MemorySize: "128" },
      "build an api gateway handler",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const rec = recs.find((r) => r.id === "lambda-low-memory-api");
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe("info");
    expect(rec!.message).toContain("256+ MB");
  });

  it("triggers lambda-low-memory-api when MemorySize is undefined and intent contains api", () => {
    const recs = evaluateWizardRecommendations(
      {},
      "api service",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(recs.find((r) => r.id === "lambda-low-memory-api")).toBeDefined();
  });

  it("does not trigger lambda-low-memory-api when MemorySize=512", () => {
    const recs = evaluateWizardRecommendations(
      { MemorySize: "512" },
      "api handler",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(recs.find((r) => r.id === "lambda-low-memory-api")).toBeUndefined();
  });

  it("does not trigger lambda-low-memory-api when intent does not mention api", () => {
    const recs = evaluateWizardRecommendations(
      { MemorySize: "128" },
      "background worker",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(recs.find((r) => r.id === "lambda-low-memory-api")).toBeUndefined();
  });

  // ── Task 3.3 / AC #4: lambda-no-reserved-concurrency ─────────────────

  it("triggers lambda-no-reserved-concurrency when ReservedConcurrentExecutions is unset", () => {
    const recs = evaluateWizardRecommendations(
      {},
      "any intent",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const rec = recs.find((r) => r.id === "lambda-no-reserved-concurrency");
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe("info");
    expect(rec!.message).toContain("reserved concurrency");
  });

  it("triggers lambda-no-reserved-concurrency when ReservedConcurrentExecutions is empty string", () => {
    const recs = evaluateWizardRecommendations(
      { ReservedConcurrentExecutions: "" },
      "worker",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(
      recs.find((r) => r.id === "lambda-no-reserved-concurrency"),
    ).toBeDefined();
  });

  it("does not trigger lambda-no-reserved-concurrency when value is set", () => {
    const recs = evaluateWizardRecommendations(
      { ReservedConcurrentExecutions: "100" },
      "worker",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(
      recs.find((r) => r.id === "lambda-no-reserved-concurrency"),
    ).toBeUndefined();
  });

  // ── Rule existence checks ─────────────────────────────────────────────

  it("has lambda-low-memory-api rule in RECOMMENDATION_RULES", () => {
    expect(
      RECOMMENDATION_RULES.find((r) => r.id === "lambda-low-memory-api"),
    ).toBeDefined();
  });

  it("has lambda-no-reserved-concurrency rule in RECOMMENDATION_RULES", () => {
    expect(
      RECOMMENDATION_RULES.find(
        (r) => r.id === "lambda-no-reserved-concurrency",
      ),
    ).toBeDefined();
  });
});
