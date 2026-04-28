// E2E plan tests for error handling and meta scenarios.
// Extracted from e2e-plan.test.ts during the M-018 cluster-D split (2026-04-28).
// The monolith remains in place until the lead step replaces it with a 5-line redirect.

import { it, expect } from "vitest";
import { describeE2E, tools } from "./e2e-plan-shared.js";
import { createGraph } from "../services/graph.js";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";

describeE2E("E2E: Error handling", () => {
  it("rejects unsupported resource type with clear error", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an AWS Redshift cluster",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // Should indicate unsupported resource or error status
    // Tier C: strengthened — executionStatus must be a real status string
    expect(typeof s.executionStatus).toBe("string");
    expect(
      s.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE ||
        s.executionStatus === ExecutionStatus.FAILED ||
        s.errorMessage !== undefined,
    ).toBe(true);
  }, 60_000);

  it("handles malformed intent gracefully", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "asdfghjkl random noise",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // Should not crash — must return some status
    // Tier C: strengthened — executionStatus must be a real status string
    expect(typeof s.executionStatus).toBe("string");
  }, 60_000);
});
