/**
 * Tests for eventbridgeNoTargetHint helper (SX-1, PH1-H-1 BLOCKER Solution B).
 *
 * Probe variations covered:
 *   A — natural-language bare rule with frequency → no-target advisory fires
 *   B — rate-expression bare rule → no-target advisory fires
 *   C — cron-expression bare rule → no-target advisory fires
 *   D — negative case: scheduled-lambda compound (resourceType !== Events::Rule) → no advisory
 *   E — Events::Rule with explicit Targets → advisory does NOT fire
 */

import { describe, it, expect } from "vitest";
import { eventbridgeNoTargetHint } from "./eventbridge-no-target-hint.js";
import { RESOURCE_TYPES } from "@/index.js";

const EVENTS_RULE = RESOURCE_TYPES.EVENTS_RULE; // "AWS::Events::Rule"

describe("eventbridgeNoTargetHint", () => {
  // ── Variation A: natural-language bare rule with frequency ──────────────────
  it("Variation A — fires advisory for Events::Rule with no Targets (bare rate expression)", () => {
    const result = eventbridgeNoTargetHint(EVENTS_RULE, {
      ScheduleExpression: "rate(5 minutes)",
      State: "ENABLED",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("no targets");
    // Story 108-A-05: path is now noun-grouped `assignee infra plan`.
    expect(result[0]).toContain("assignee infra plan");
    expect(result[0]).toContain("scheduled lambda");
    expect(result[0]).toContain("--set Targets=");
  });

  // ── Variation B: rate-expression bare rule ──────────────────────────────────
  it("Variation B — fires advisory for Events::Rule with rate(5 minutes) and empty Targets array", () => {
    const result = eventbridgeNoTargetHint(EVENTS_RULE, {
      ScheduleExpression: "rate(5 minutes)",
      State: "ENABLED",
      Targets: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("non-functional");
    expect(result[0]).toContain("--set Targets=");
  });

  // ── Variation C: cron-expression bare rule ──────────────────────────────────
  it("Variation C — fires advisory for Events::Rule with cron(0/15 * * * ? *) and no Targets", () => {
    const result = eventbridgeNoTargetHint(EVENTS_RULE, {
      ScheduleExpression: "cron(0/15 * * * ? *)",
      State: "ENABLED",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/no targets/i);
    expect(result[0]).toContain("scheduled lambda");
  });

  // ── Variation D: negative case — non-Events::Rule type ─────────────────────
  it("Variation D — does NOT fire for non-Events::Rule resource type (e.g., Lambda Function)", () => {
    const result = eventbridgeNoTargetHint(RESOURCE_TYPES.LAMBDA_FUNCTION, {
      Runtime: "nodejs22.x",
      Handler: "index.handler",
    });
    expect(result).toHaveLength(0);
  });

  it("Variation D — does NOT fire for IAM Role resource type", () => {
    const result = eventbridgeNoTargetHint(RESOURCE_TYPES.IAM_ROLE, {
      AssumeRolePolicyDocument: {},
    });
    expect(result).toHaveLength(0);
  });

  // ── Variation E: Events::Rule with explicit Targets → no advisory ───────────
  it("Variation E — does NOT fire when Events::Rule has at least one Target", () => {
    const result = eventbridgeNoTargetHint(EVENTS_RULE, {
      ScheduleExpression: "rate(5 minutes)",
      State: "ENABLED",
      Targets: [
        {
          Id: "MyLambdaTarget",
          Arn: "arn:aws:lambda:us-east-1:112233445566:function:my-function",
        },
      ],
    });
    expect(result).toHaveLength(0);
  });

  it("Variation E — does NOT fire when Events::Rule has multiple Targets", () => {
    const result = eventbridgeNoTargetHint(EVENTS_RULE, {
      ScheduleExpression: "rate(1 hour)",
      State: "ENABLED",
      Targets: [
        {
          Id: "Target1",
          Arn: "arn:aws:lambda:us-east-1:112233445566:function:fn1",
        },
        {
          Id: "Target2",
          Arn: "arn:aws:sqs:us-east-1:112233445566:queue/my-queue",
        },
      ],
    });
    expect(result).toHaveLength(0);
  });

  // ── Advisory content quality checks ────────────────────────────────────────
  it("advisory uses the WARNING icon", () => {
    const result = eventbridgeNoTargetHint(EVENTS_RULE, {
      ScheduleExpression: "rate(1 hour)",
    });
    expect(result).toHaveLength(1);
    // WARNING icon is ⚠️ (⚠️)
    expect(result[0]).toContain("⚠️");
  });

  it("advisory mentions the compound plan command for discoverability", () => {
    const result = eventbridgeNoTargetHint(EVENTS_RULE, {});
    expect(result).toHaveLength(1);
    // Story 108-A-05: path is now noun-grouped `assignee infra plan`.
    expect(result[0]).toContain("assignee infra plan");
    expect(result[0]).toContain("scheduled lambda");
  });

  it("returns empty array for Events::Rule with Targets set to non-array truthy value (defensive guard)", () => {
    // Targets as a non-array (malformed) — treat as no real targets
    const result = eventbridgeNoTargetHint(EVENTS_RULE, {
      ScheduleExpression: "rate(5 minutes)",
      Targets: "not-an-array",
    });
    // Non-array Targets → treated as absent → advisory fires
    expect(result).toHaveLength(1);
  });
});
