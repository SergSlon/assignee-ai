import { describe, it, expect } from "vitest";
import { ExecutionStatus } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { skipIfCompanionResource } from "./companion-skip.js";

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: "run-companion-skip-001",
    resourceType: "AWS::S3::Bucket",
    ...overrides,
  } as unknown as AgentState;
}

describe("skipIfCompanionResource", () => {
  it("returns SUCCESS partial when current resource is marked provisionable:false", () => {
    const result = skipIfCompanionResource(baseState(), {
      provisionable: false,
      displayName: "S3 bucket notification",
    });

    expect(result).not.toBeNull();
    expect(result?.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // Companion resources never produce an ARN — clears any leftover from a
    // prior iteration's reducer state so the display layer shows "(companion)".
    expect(result?.resourceArn).toBeUndefined();
  });

  it("returns null when current resource is provisionable:true (normal CCAPI path)", () => {
    const result = skipIfCompanionResource(baseState(), {
      provisionable: true,
      displayName: "my-bucket",
    });
    expect(result).toBeNull();
  });

  it("returns null when `provisionable` is undefined (default is: provisionable)", () => {
    // Real plans that predate the companion-flag feature do not set the field
    // at all; the helper MUST treat missing as true so legacy plans don't
    // regress into SUCCESS-without-create.
    const result = skipIfCompanionResource(baseState(), {
      displayName: "legacy-entry",
    });
    expect(result).toBeNull();
  });

  it("returns null when currentResource is undefined", () => {
    // Edge case: empty resource queue. Callers pass
    // `state.resourceQueue?.[state.currentResourceIndex ?? 0]` which can be
    // undefined; helper must not throw.
    const result = skipIfCompanionResource(baseState(), undefined);
    expect(result).toBeNull();
  });
});
