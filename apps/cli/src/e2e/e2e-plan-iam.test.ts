// E2E plan tests for IAM and KMS resource family.
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

describeE2E("E2E: IAM Role plan", () => {
  it("generates a plan with assume role policy", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create an IAM role named e2e-role-test for Lambda execution",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::IAM::Role");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);
    expect(s.desiredState?.["RoleName"]).toBe("e2e-role-test");
    // Tier C: strengthened — AssumeRolePolicyDocument must be a real
    // policy object (with Statement array), not just defined
    expect(s.desiredState?.["AssumeRolePolicyDocument"]).toBeInstanceOf(Object);

    // P0-2: IAM Roles are always free — headline MUST display "Free",
    // never "N/A". Soft `if` removed: a missing cost is itself a regression.
    expect(s.estimatedMonthlyCost).toBe("Free");
  }, 60_000);
});

describeE2E("E2E: KMS Key plan", () => {
  it("generates a plan with key policy", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a KMS encryption key for application-level data encryption",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::KMS::Key");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    // KeyPolicy is the load-bearing security-critical field — without
    // it CCAPI rejects the create. Reviewers (blind H2 + QA #1 on
    // cf55d7d..c269379) flagged dropping this assertion as weakening
    // on a security-critical field. If the plan-generator regresses
    // to omitting KeyPolicy, the plan the user approves is incomplete
    // and the test must catch it.
    //
    // Wave-3 F7: tightened from `.toBeTruthy()` (which accepts the
    // stringified `"{}"` or any non-empty string) to a shape check on
    // { Version, Statement } — the two mandatory IAM policy fields.
    // CCAPI accepts KeyPolicy as either a JSON object OR a JSON-
    // encoded string, so we parse strings before shape-checking.
    const keyPolicyRaw = s.desiredState?.["KeyPolicy"];
    expect(keyPolicyRaw).toBeDefined();
    const keyPolicy =
      typeof keyPolicyRaw === "string"
        ? JSON.parse(keyPolicyRaw)
        : keyPolicyRaw;
    expect(keyPolicy).toEqual(
      expect.objectContaining({
        Version: expect.any(String),
        Statement: expect.any(Array),
      }),
    );
    expect(
      (keyPolicy as { Statement: unknown[] }).Statement.length,
    ).toBeGreaterThan(0);
    // KeyUsage + KeySpec as enum-bounded sanity checks (the real
    // KMS contract; CCAPI rejects arbitrary strings here).
    expect(s.desiredState?.["KeyUsage"]).toMatch(
      /^(ENCRYPT_DECRYPT|SIGN_VERIFY|GENERATE_VERIFY_MAC|KEY_AGREEMENT)$/,
    );
    expect(s.desiredState?.["KeySpec"]).toMatch(
      /^(SYMMETRIC_DEFAULT|RSA_|ECC_|HMAC_|SM2)/,
    );
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

// Free-tier lifecycle cases for IAM resources
const iamCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: IAM Role apply + destroy",
)!;
describeE2E(iamCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(iamCase);
    },
    iamCase.timeoutMs ?? 240_000,
  );
});

const kmsCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: KMS Key apply + destroy (schedule deletion)",
)!;
describeE2E(kmsCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(kmsCase);
    },
    kmsCase.timeoutMs ?? 240_000,
  );
});
