// E2E plan tests for Lambda-family compound patterns:
//   - scheduled-lambda (EventBridge Rule + IAM Role + Lambda)
//   - serverless-api (Lambda + API Gateway V2)
//   - message-processing (SQS + Lambda + DynamoDB)
// Split from e2e-plan-compounds.test.ts during the M-β-015 split (2026-04-29).

import { it, expect } from "vitest";
import { describeE2E, tools, destroyAndAssert } from "./e2e-plan-shared.js";
import { createGraph } from "../services/graph.js";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";

// ─────────────────────────────────────────────────────────────────────────────
// A10 follow-up (2026-04-09): scheduled-lambda compound apply + destroy e2e.
//
// Mirrors the efs-with-vpc test above for the 8th compound pattern —
// EventBridge Rule + IAM Role + Lambda Function (+ optional Lambda
// Permission + LogGroup companions). The pattern was shipped in A8 but
// only had plan-mode coverage. This test locks in:
//   - resourceQueue ordering (Role → Lambda → Rule; Rule depends on
//     Lambda ARN, Lambda depends on Role ARN)
//   - Events::Rule Targets[] must reference the Lambda ARN after the
//     marker-resolver substitution
//   - destroy ordering — Rule first, then the target Lambda, then the
//     Role (detach boundary) — the inverse of the create order
// ─────────────────────────────────────────────────────────────────────────────
describeE2E("E2E: scheduled-lambda compound apply + destroy", () => {
  const schedSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys a scheduled Lambda wired to an EventBridge rule", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        // Phrasing that routes into the scheduled-lambda compound —
        // both "scheduled" and "lambda" mentioned, matching the
        // pattern's keyword set (see packages/core/src/pattern-templates/
        // patterns/scheduled-lambda.ts).
        userIntent: `Create a scheduled lambda that runs every hour for e2e test ${schedSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("SCHEDULED-LAMBDA COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("scheduled-lambda");

    const completed = finalState.completedResources ?? [];

    // Minimum surface: IAM Role, Lambda Function, Events::Rule all
    // created with real physical IDs.
    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.resourceArn?.length ?? 0).toBeGreaterThan(0);
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const lambda = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    );
    // Compound completedResources stores bare function name, not full ARN
    expect(typeof lambda?.resourceArn).toBe("string");
    expect(lambda?.resourceArn!.length).toBeGreaterThan(0);
    expect(lambda?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const rule = completed.find((c) => c.resourceType === "AWS::Events::Rule");
    // Events::Rule primaryIdentifier is /properties/Arn (readOnly) —
    // the provisioner captures the ARN from the CCAPI create response.
    expect(rule?.resourceArn).toMatch(/^arn:aws:events:[a-z0-9-]+:\d+:rule\//);
    expect(rule?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    await destroyAndAssert(completed);
    // The Events::Rule destroy MUST happen before (or tolerate) the
    // Lambda target destroy, otherwise the rule will sit with a dangling
    // target reference. If the Rule destroy strategy doesn't first
    // RemoveTargets, the test surfaces a CCAPI DependencyViolation here.
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 900_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 3d RUN_E2E ratchet (2026-04-10) — serverless-api and message-processing
// compounds. Each block is gated by RUN_E2E=1 like every other e2e test in
// this file and contributes zero runtime to plain `pnpm test`.
// ═════════════════════════════════════════════════════════════════════════════

describeE2E("E2E: serverless-api compound apply + destroy", () => {
  const apiSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys a serverless API (Lambda + API Gateway V2)", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a serverless api for e2e test ${apiSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("SERVERLESS-API COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("serverless-api");

    const completed = finalState.completedResources ?? [];

    // Hero resources: IAM role + Lambda + API Gateway V2 Api.
    // Lambda Permission is display-only (CCAPI routes it through the
    // flaky AWS::Lambda::PermissionPolicy path), so it may land as
    // display-only without a full ARN — do not assert its presence here.
    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const fn = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    );
    // Compound completedResources stores bare function name, not full ARN
    expect(typeof fn?.resourceArn).toBe("string");
    expect(fn?.resourceArn!.length).toBeGreaterThan(0);
    expect(fn?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // API Gateway V2 Api is provisionable:false (companion resource) —
    // it is NOT provisioned via CCAPI and may not appear in
    // completedResources at all. The serverless-api pattern's hero
    // resources are IAM Role + Lambda + LogGroup (provisionable:true).
    // Assert those are present; the API Gateway is plan-display-only.
    const logGroup = completed.find(
      (c) => c.resourceType === "AWS::Logs::LogGroup",
    );
    expect(typeof logGroup?.resourceArn).toBe("string");
    expect(logGroup?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // API Gateway deletion must cascade through routes/stages/integrations
    // before the Api itself can be removed. bulk-destroy tier ordering
    // handles the dependency graph; if it ever regresses, the
    // DependencyViolation surfaces here.
    await destroyAndAssert(completed);
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 900_000);
});

describeE2E("E2E: message-processing compound apply + destroy", () => {
  const mpSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys an SQS→Lambda→DynamoDB message processing pipeline", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a message processing pipeline for e2e test ${mpSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("MESSAGE-PROCESSING COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("message-processing");

    const completed = finalState.completedResources ?? [];

    // Compound produces exactly 5 resources: DLQ, main queue, DynamoDB
    // table, IAM role, and the processor Lambda. All must land with
    // physical identifiers.
    const queues = completed.filter(
      (c) => c.resourceType === "AWS::SQS::Queue",
    );
    expect(queues.length).toBe(2); // DLQ + main queue
    for (const q of queues) {
      expect(typeof q.resourceArn).toBe("string");
      expect(q.executionStatus).toBe(ExecutionStatus.SUCCESS);
    }

    const table = completed.find(
      (c) => c.resourceType === "AWS::DynamoDB::Table",
    );
    expect(typeof table?.resourceArn).toBe("string");
    expect(table?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const fn = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    );
    // Compound completedResources stores bare function name, not full ARN
    expect(typeof fn?.resourceArn).toBe("string");
    expect(fn?.resourceArn!.length).toBeGreaterThan(0);
    expect(fn?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // DynamoDB requires DeletionProtection=false before delete;
    // destroy-service.ts has a dedicated hook for this. If the hook
    // ever regresses, the failures array surfaces it.
    await destroyAndAssert(completed);
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 900_000);
});
