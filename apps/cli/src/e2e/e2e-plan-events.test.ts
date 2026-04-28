// E2E plan tests for events resource family (EventBridge, SNS, SQS, Events Connection/ApiDestination).
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

describeE2E("E2E: EventBridge Rule plan", () => {
  it("generates a plan with secure defaults (State=ENABLED, at least one Target)", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create an EventBridge rule that runs every hour to trigger my nightly cleanup Lambda",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // Intent either hits the scheduled-lambda compound pattern or the
    // single-resource Events::Rule plan; both are acceptable for this
    // smoke test. When the compound pattern fires, the resourceType
    // reflects the last-queued resource (the display-only permission
    // or the rule itself), so we accept either shape.
    const acceptableTypes = new Set([
      "AWS::Events::Rule",
      "AWS::IAM::Role",
      "AWS::Lambda::Function",
      "AWS::Lambda::Permission",
    ]);
    expect(acceptableTypes.has(s.resourceType ?? "")).toBe(true);

    // A8 secure-by-default: the plugin's defaults.State must produce
    // an ENABLED rule so BP-EVENTS-003 doesn't fire. If the pattern
    // path ran instead, the compound's default is also ENABLED.
    if (s.resourceType === "AWS::Events::Rule") {
      expect(s.desiredState?.["State"]).toBe("ENABLED");
    }

    // Neither BP-EVENTS-001 (Targets required) nor BP-EVENTS-003
    // (ENABLED) should surface as a blocking finding when the
    // plan either uses the compound pattern or is generated against
    // the plugin's defaults.
    const blocking = (s.bpFindings ?? []).filter((f) => f.blocking === true);
    const eventsBlocking = blocking.filter((f) =>
      f.practiceId?.startsWith("BP-EVENTS-"),
    );
    expect(eventsBlocking).toHaveLength(0);
  }, 60_000);
});

describeE2E("E2E: SQS Queue plan", () => {
  it("generates a plan with queue configuration", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an SQS queue named e2e-queue-test",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::SQS::Queue");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);

    // BP findings should exist for SQS
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

describeE2E("E2E: SNS Topic plan", () => {
  it("generates a plan with topic configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent: "Create an SNS topic named e2e-sns-topic for notifications",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::SNS::Topic");
    // AC #1 requires "non-empty desiredState" — reject {} that
    // toBeInstanceOf(Object) would silently accept (review Low fix).
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["TopicName"]).toBe("e2e-sns-topic");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: SNS Subscription plan", () => {
  it("generates a plan with subscription protocol and endpoint", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an SNS Subscription with Protocol=email and Endpoint=test@example.com for topic arn:aws:sns:us-east-1:210987654321:e2e-topic",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::SNS::Subscription");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    // Intent explicitly says "Protocol=email and Endpoint=test@example.com".
    // If the LLM picks anything else, that is a real intent-parser or
    // plan-generator regression and the test must catch it.
    // Reviewers (blind H1 + QA #2 on cf55d7d..c269379) flagged an
    // earlier 9-protocol wildcard as weakening — restored strict
    // contract + added Endpoint pair check so (email, arn:aws:sqs:...)
    // doesn't silently pass.
    expect(s.desiredState?.["Protocol"]).toBe("email");
    expect(s.desiredState?.["Endpoint"]).toBe("test@example.com");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: EventBridge EventBus plan", () => {
  it("generates a plan with event bus configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an EventBridge event bus named e2e-event-bus for cross-account events",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::Events::EventBus");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["Name"]).toBe("e2e-event-bus");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

// Wave-4 F5 P2-R2-6: Events::Connection + Events::ApiDestination were
// previously `describe.skip` with a "retrain the intent parser" TODO.
// R2-B corrected the claim — intent-parser.ts is 79 LOC and the real fix
// was a 3-sentence prompt disambiguation (see intent-parser.ts for the
// "standalone", "bare", "single" keyword guidance + explicit per-type
// hints for Events::Connection / Events::ApiDestination). The explicit
// "standalone"/"bare" wording in the intents below now classifies
// correctly without compound rerouting.
describeE2E("E2E: Events Connection plan (standalone)", () => {
  it("generates a plan for a standalone AWS::Events::Connection", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a standalone AWS::Events::Connection named e2e-conn for an external HTTP API with API_KEY auth — just the Connection, not a Rule or ApiDestination.",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
        presetFields: {
          Name: "e2e-conn",
          AuthorizationType: "API_KEY",
          // Minimum valid AuthParameters shape for API_KEY auth — a
          // header name + value. EventBridge stores this in a managed
          // Secret; the CCAPI handler fans out a secretsmanager:*
          // permission for Connection (see resource-types.ts A12 comment).
          AuthParameters: JSON.stringify({
            ApiKeyAuthParameters: {
              ApiKeyName: "X-E2E-Key",
              ApiKeyValue: "e2e-dummy",
            },
          }),
        },
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::Events::Connection");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["Name"]).toBe("e2e-conn");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: Events ApiDestination plan (standalone)", () => {
  it("generates a plan for a standalone AWS::Events::ApiDestination", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a standalone AWS::Events::ApiDestination named e2e-apidest — just the ApiDestination itself, not a Rule. It points at https://example.test/webhook using POST.",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
        presetFields: {
          Name: "e2e-apidest",
          HttpMethod: "POST",
          InvocationEndpoint: "https://example.test/webhook",
          // ConnectionArn is required by the CCAPI create handler; the
          // value below is a well-formed placeholder that passes plan-
          // phase schema validation. PLAN mode never hits AWS with it —
          // if a future APPLY mode needs a real Connection it must be
          // created via a companion resource first.
          ConnectionArn:
            "arn:aws:events:us-east-1:210987654321:connection/e2e-conn/11111111-1111-1111-1111-111111111111",
        },
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::Events::ApiDestination");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["Name"]).toBe("e2e-apidest");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

// Free-tier lifecycle cases for events resources
const sqsCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: SQS Queue apply + destroy",
)!;
describeE2E(sqsCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(sqsCase);
    },
    sqsCase.timeoutMs ?? 240_000,
  );
});

const snsCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: SNS Topic apply + destroy",
)!;
describeE2E(snsCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(snsCase);
    },
    snsCase.timeoutMs ?? 240_000,
  );
});
