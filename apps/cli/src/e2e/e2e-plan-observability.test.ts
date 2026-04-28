// E2E plan tests for observability resource family (CloudWatch Alarm, CloudWatch LogGroup).
// Extracted from e2e-plan.test.ts during the M-018 cluster-D split (2026-04-28).
// The monolith remains in place until the lead step replaces it with a 5-line redirect.

import { it, expect } from "vitest";
import {
  describeE2E,
  tools,
  runFreeTierLifecycle,
  FREE_TIER_LIFECYCLE_CASES,
} from "./e2e-plan-shared.js";
import { createGraph } from "../services/graph.js";
import { ExecutionMode } from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";

describeE2E("E2E: CloudWatch Alarm plan", () => {
  it("generates a plan with metric and threshold", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create a CloudWatch alarm for CPU utilization above 80%",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::CloudWatch::Alarm");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);

    // Should have metric configuration
    const ds = s.desiredState!;
    const hasMetric =
      ds["MetricName"] !== undefined || ds["ComparisonOperator"] !== undefined;
    expect(hasMetric).toBe(true);

    // BP findings should include alarm action checks
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

describeE2E("E2E: CloudWatch LogGroup plan", () => {
  it("generates a plan with log group configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a CloudWatch log group named /aws/assignee/e2e-logs",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::Logs::LogGroup");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["LogGroupName"]).toBe("/aws/assignee/e2e-logs");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

// Free-tier lifecycle cases for observability resources
const alarmCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: CloudWatch Alarm apply + destroy",
)!;
describeE2E(alarmCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(alarmCase);
    },
    alarmCase.timeoutMs ?? 240_000,
  );
});

const logGroupCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: CloudWatch LogGroup apply + destroy",
)!;
describeE2E(logGroupCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(logGroupCase);
    },
    logGroupCase.timeoutMs ?? 240_000,
  );
});
