// E2E plan tests for EFS storage compound pattern (efs-with-vpc apply+destroy).
// Split from e2e-plan-compounds.test.ts during the M-β-015 split (2026-04-29).

import { it, expect } from "vitest";
import { describeE2E, tools, destroyAndAssert } from "./e2e-plan-shared.js";
import { createGraph } from "../services/graph.js";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";

// ─────────────────────────────────────────────────────────────────────────────
// A10 follow-up (2026-04-09): efs-with-vpc compound apply + destroy e2e.
//
// Before this test, `efs-with-vpc` had unit coverage of the static pattern
// shape (pattern-templates/patterns/efs-with-vpc.test.ts) and an E2E
// plan-mode smoke (see "E2E: EFS FileSystem plan" above), but NO apply +
// destroy exercise against real AWS. That left the compound's runtime
// correctness unverified for:
//   - resourceQueue ordering (VPC → Subnet → SG → EFS FS → MountTargets)
//   - EFS FileSystem + MountTarget provisioning + inter-resource refs
//   - cleanup coverage — EFS MountTargets must be deleted before EFS FS,
//     EFS FS before SG, SG before subnets, subnets before VPC
//
// Mirrors the lambda-with-exec-role compound apply+destroy test
// (`E2E: lambda-with-exec-role compound apply + destroy` above). Gated on
// `RUN_E2E=1` like every other e2e test — no effect on plain `pnpm test`.
// Destroy is exercised via `planBulkDestroy` + `destroySingleResource`
// rather than a hand-rolled SDK cleanup, so the destroy pipeline ships
// with the same regression coverage.
// ─────────────────────────────────────────────────────────────────────────────
describeE2E("E2E: efs-with-vpc compound apply + destroy", () => {
  const efsSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys an EFS file system wired into a fresh VPC", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    // efs-with-vpc produces 7+ provisionable resources inside a VPC —
    // each one runs through the full LangGraph node cycle, so the
    // default recursion limit (25) is not enough. Match the production
    // apply.ts override.
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        // Phrasing that lands on the efs-with-vpc pattern dispatcher —
        // a verified keyword combo from pattern-templates/patterns/
        // efs-with-vpc.ts (both "efs" and "vpc" mentioned together).
        userIntent: `Create an EFS file system inside a new VPC for e2e test ${efsSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    // Drain HITL interrupts until the graph settles.
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("EFS-WITH-VPC COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("efs-with-vpc");

    const completed = finalState.completedResources ?? [];

    // Every first-class resource in the pattern must land with a real
    // physical ID. Minimum viable surface: a VPC, at least one Subnet,
    // a SecurityGroup that the MountTargets hang off, an EFS
    // FileSystem, and at least one MountTarget attached to it.
    const vpc = completed.find((c) => c.resourceType === "AWS::EC2::VPC");
    expect(vpc?.resourceArn).toMatch(/^vpc-[0-9a-f]{8,}$/);

    const subnets = completed.filter(
      (c) => c.resourceType === "AWS::EC2::Subnet",
    );
    expect(subnets.length).toBeGreaterThanOrEqual(1);
    for (const s of subnets) {
      expect(s.resourceArn).toMatch(/^subnet-[0-9a-f]{8,}$/);
    }

    const securityGroup = completed.find(
      (c) => c.resourceType === "AWS::EC2::SecurityGroup",
    );
    expect(securityGroup?.resourceArn).toMatch(/^sg-[0-9a-f]{8,}$/);

    const efsFs = completed.find(
      (c) => c.resourceType === "AWS::EFS::FileSystem",
    );
    expect(efsFs?.resourceArn).toMatch(/^fs-[0-9a-f]{8,}$/);
    expect(efsFs?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const mountTargets = completed.filter(
      (c) => c.resourceType === "AWS::EFS::MountTarget",
    );
    // The pattern provisions at least one MountTarget per subnet — the
    // minimum is 1. Without this, the EFS file system would not be
    // reachable from any workload, which is the whole point of the
    // compound.
    expect(mountTargets.length).toBeGreaterThanOrEqual(1);
    for (const mt of mountTargets) {
      expect(mt.resourceArn).toMatch(/^fsmt-[0-9a-f]{8,}$/);
      expect(mt.executionStatus).toBe(ExecutionStatus.SUCCESS);
    }

    // ── Destroy pipeline exercise ───────────────────────────────────
    // Exercises the real bulk-destroy pipeline instead of a hand-rolled
    // SDK teardown: discovers the resources by tag, orders them by
    // DESTROY_TIER, and runs destroySingleResource() on each. That's
    // exactly what `assignee destroy --all` does in production, so
    // this is the test that catches dependency-order regressions
    // (EFS MountTargets must go before the FileSystem, the FileSystem
    // before the SecurityGroup, the SG before the Subnets, etc.).
    await destroyAndAssert(completed);
    // Destroy assertions are inside destroyAndAssert().
  }, 900_000);
});
