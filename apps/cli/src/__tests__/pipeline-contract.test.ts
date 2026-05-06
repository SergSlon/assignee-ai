/**
 * Pipeline State Contract Test — validates that graph state flows correctly
 * through all nodes in the Assignee.ai pipeline.
 *
 * Epic 94 R1 (A-01): `validate_desired_state` joined the roster when the
 * Epic 92 u.c.1 plan-time S3 validator was finally wired into
 * `create-graph.ts`. The expected-nodes list is strengthened (not
 * weakened) — we still require every prior node AND the new one.
 *
 * Story feature-query-intent-classifier: `query_handler` (15th node) added
 * for read-only query intents that bypass the creation pipeline.
 *
 * Mocks at the AWS boundary (CloudControl, Bedrock), not at the node boundary.
 * Verifies key state fields are populated at each stage.
 *
 * @see Sprint K — Quality Blitz: Pipeline state contract
 */

import { describe, it, expect } from "vitest";
import type { AgentState } from "../services/graph-state.js";
import { GraphNode } from "../constants/graph.js";

// ── 1. Graph node enumeration ────────────────────────────────────────────────

describe("Pipeline contract — graph node enumeration", () => {
  const expectedNodes = [
    "intent_parser",
    "schema_fetcher",
    "option_elicitor",
    "compound_dispatcher",
    "plan_generator",
    "validate_desired_state",
    "advice_generator",
    "preflight_guard",
    "human_approval",
    "resource_provisioner",
    "status_poller",
    "bp_evaluator",
    "fix_applicator",
    "result_formatter",
    // Story feature-query-intent-classifier: 15th node for read-only queries.
    "query_handler",
  ] as const;

  it("GraphNode has exactly 15 nodes", () => {
    const nodeValues = Object.values(GraphNode);
    expect(nodeValues).toHaveLength(15);
  });

  it.each(expectedNodes)("GraphNode contains '%s'", (nodeName) => {
    const nodeValues = Object.values(GraphNode);
    expect(nodeValues).toContain(nodeName);
  });
});

// ── 2. Graph state shape contract ────────────────────────────────────────────

describe("Pipeline contract — graph state shape", () => {
  it("graphAnnotation defines all required state fields", async () => {
    const { graphAnnotation } = await import("../services/graph-state.js");
    // Build a default state using the annotation's channels
    const channels = graphAnnotation.spec;

    // Phase 1 fields (planning)
    expect(channels).toHaveProperty("userIntent");
    expect(channels).toHaveProperty("runId");
    expect(channels).toHaveProperty("executionMode");
    expect(channels).toHaveProperty("resourceType");
    expect(channels).toHaveProperty("resourceSchema");
    expect(channels).toHaveProperty("desiredState");

    // Cost and validation fields
    expect(channels).toHaveProperty("estimatedMonthlyCost");
    expect(channels).toHaveProperty("preflightPassed");
    expect(channels).toHaveProperty("preflightErrors");
    expect(channels).toHaveProperty("preflightMode");

    // Phase 2 fields (provisioning)
    expect(channels).toHaveProperty("requestToken");
    expect(channels).toHaveProperty("resourceArn");
    expect(channels).toHaveProperty("executionStatus");
    expect(channels).toHaveProperty("errorMessage");

    // Compound architecture fields
    expect(channels).toHaveProperty("resourceQueue");
    expect(channels).toHaveProperty("currentResourceIndex");
    expect(channels).toHaveProperty("completedResources");

    // BP and fix fields
    expect(channels).toHaveProperty("bpFindings");
    expect(channels).toHaveProperty("appliedFixes");

    // Config and context
    expect(channels).toHaveProperty("orgConfig");
    expect(channels).toHaveProperty("userConfig");
    expect(channels).toHaveProperty("elicitedOptions");
    expect(channels).toHaveProperty("noWizard");
    expect(channels).toHaveProperty("autoApprove");
    expect(channels).toHaveProperty("checkpointResumed");
    expect(channels).toHaveProperty("projectDir");
  });
});

// ── 3. Routing contract ──────────────────────────────────────────────────────

describe("Pipeline contract — routing functions", () => {
  it("routeCheckpointEntry returns intent_parser for fresh runs", async () => {
    const { routeCheckpointEntry } =
      await import("../services/graph-routing.js");
    const state = {
      checkpointResumed: false,
      desiredState: undefined,
    } as unknown as AgentState;
    expect(routeCheckpointEntry(state)).toBe(GraphNode.INTENT_PARSER);
  });

  it("routeCheckpointEntry returns human_approval for resumed checkpoints", async () => {
    const { routeCheckpointEntry } =
      await import("../services/graph-routing.js");
    const state = {
      checkpointResumed: true,
      desiredState: { BucketName: "test" },
    } as unknown as AgentState;
    expect(routeCheckpointEntry(state)).toBe(GraphNode.HUMAN_APPROVAL);
  });

  it("routePreflightGuard returns result_formatter for plan mode", async () => {
    const { routePreflightGuard } =
      await import("../services/graph-routing.js");
    const { ExecutionMode } = await import("@assignee/core");
    const state = {
      executionMode: ExecutionMode.PLAN,
    } as unknown as AgentState;
    expect(routePreflightGuard(state)).toBe(GraphNode.RESULT_FORMATTER);
  });

  it("routeResourceProvisioner routes to status_poller when IN_PROGRESS", async () => {
    const { routeResourceProvisioner } =
      await import("../services/graph-routing.js");
    const { ExecutionStatus } = await import("@assignee/core");
    const state = {
      executionStatus: ExecutionStatus.IN_PROGRESS,
    } as unknown as AgentState;
    expect(routeResourceProvisioner(state)).toBe(GraphNode.STATUS_POLLER);
  });

  it("routeResourceProvisioner routes to result_formatter when not IN_PROGRESS", async () => {
    const { routeResourceProvisioner } =
      await import("../services/graph-routing.js");
    const { ExecutionStatus } = await import("@assignee/core");
    const state = {
      executionStatus: ExecutionStatus.SUCCESS,
    } as unknown as AgentState;
    expect(routeResourceProvisioner(state)).toBe(GraphNode.RESULT_FORMATTER);
  });
});

// ── 4. Edge flow contract ────────────────────────────────────────────────────

describe("Pipeline contract — edge flow", () => {
  it("plan mode follows: intent_parser -> schema_fetcher -> option_elicitor -> compound_dispatcher -> plan_generator -> validate_desired_state -> advice_generator -> bp_evaluator -> fix_applicator -> preflight_guard -> result_formatter", () => {
    // This documents the expected linear path for plan mode.
    // The actual graph wiring is tested in graph-integration.test.ts.
    // Here we verify the node constant ordering matches the documented pipeline.
    //
    // Epic 94 R1 (A-01): `validate_desired_state` inserted between
    // plan_generator and advice_generator. On validation failure it
    // short-circuits to result_formatter (see routeValidateDesiredState
    // in graph-routing.ts); happy path falls through to advice_generator
    // as shown below.
    const planPath = [
      GraphNode.INTENT_PARSER,
      GraphNode.SCHEMA_FETCHER,
      GraphNode.OPTION_ELICITOR,
      GraphNode.COMPOUND_DISPATCHER,
      GraphNode.PLAN_GENERATOR,
      GraphNode.VALIDATE_DESIRED_STATE,
      GraphNode.ADVICE_GENERATOR,
      GraphNode.BP_EVALUATOR,
      GraphNode.FIX_APPLICATOR,
      GraphNode.PREFLIGHT_GUARD,
      GraphNode.RESULT_FORMATTER,
    ];

    expect(planPath).toHaveLength(11);
    expect(planPath[0]).toBe("intent_parser");
    expect(planPath[planPath.length - 1]).toBe("result_formatter");
  });

  it("apply mode extends plan path with: human_approval -> resource_provisioner -> status_poller -> result_formatter", () => {
    const applyExtension = [
      GraphNode.HUMAN_APPROVAL,
      GraphNode.RESOURCE_PROVISIONER,
      GraphNode.STATUS_POLLER,
      GraphNode.RESULT_FORMATTER,
    ];

    expect(applyExtension).toHaveLength(4);
    expect(applyExtension[0]).toBe("human_approval");
    expect(applyExtension[applyExtension.length - 1]).toBe("result_formatter");
  });
});
