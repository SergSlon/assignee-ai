/**
 * Epic 94 N8 (C-01) — WebSocket pattern renders ALL 12 resources.
 *
 * Pre-fix: `packages/core/src/graph/nodes/result-formatter/formatters/plan.ts`
 * skipped `provisionable: false` entries when advancing the compound
 * queue. That produced 3 plan boxes (IAM role + Lambda + LogGroup) and
 * dropped the 9 API Gateway v2 companion desiredStates, so users
 * never saw `ProtocolType: WEBSOCKET` or `RouteSelectionExpression:
 * $request.body.action` before apply.
 *
 * Post-fix: the queue-advance helper no longer skips companions. Each
 * of the 12 resources now flows through plan-generator →
 * result-formatter like any other, with `compound-plan.ts`
 * substituting display-only placeholders for marker tokens. This test
 * pins the user-visible proof that ProtocolType / RouteSelectionExpression
 * are reachable for every companion render.
 */

import { describe, it, expect } from "vitest";
import { websocketApiPattern } from "../patterns/websocket-api.js";
import { resolvePlaceholderMarkers } from "../../graph/nodes/plan-generator/marker-resolver.js";
import { WebsocketApiResourceId as R } from "../pattern-resource-ids.js";

/**
 * Build the display-only desiredState that compound-plan.ts would
 * produce for resource `resourceId` in PLAN mode. Mirrors the pipeline
 * in `runCompoundPlan` without the AWS-dependent bits (no lambda
 * role-ARN injection, no AMI SSM lookup, no memory hints) — those
 * branches are either skipped for the WebSocket resources under test
 * or are orthogonal to the display contract.
 */
function buildDisplayState(
  resourceId: string,
  region = "us-east-1",
): Record<string, unknown> {
  const pattern = websocketApiPattern;
  const patternDefaults =
    (pattern.defaultOptions[resourceId] as
      | Record<string, unknown>
      | undefined) ?? {};
  // Deep clone so the per-test desiredState does not mutate the shared
  // pattern constant. The real compound-plan path uses
  // `safeCloneDesiredState`; JSON round-trip suffices here because
  // everything inside defaultOptions is JSON-safe (strings, numbers,
  // booleans, nested objects / arrays).
  const desiredState: Record<string, unknown> = JSON.parse(
    JSON.stringify(patternDefaults),
  ) as Record<string, unknown>;
  resolvePlaceholderMarkers(desiredState, region);
  return desiredState;
}

describe("websocket-api — every resource produces a displayable desiredState", () => {
  it("all 12 resourceIds have a defaultOptions entry", () => {
    for (const resource of websocketApiPattern.resourceList) {
      expect(
        websocketApiPattern.defaultOptions[resource.resourceId],
      ).toBeDefined();
    }
    expect(websocketApiPattern.resourceList).toHaveLength(12);
  });

  it("the WebSocket API's displayable desiredState contains ProtocolType: WEBSOCKET (C-01 proof)", () => {
    const state = buildDisplayState(R.WEBSOCKET_API);
    expect(state["ProtocolType"]).toBe("WEBSOCKET");
  });

  it("the WebSocket API's displayable desiredState contains the canonical RouteSelectionExpression", () => {
    const state = buildDisplayState(R.WEBSOCKET_API);
    expect(state["RouteSelectionExpression"]).toBe("$request.body.action");
  });

  it("each route's RouteKey is preserved in the displayable desiredState", () => {
    const cases = [
      { id: R.CONNECT_ROUTE, key: "$connect" },
      { id: R.DISCONNECT_ROUTE, key: "$disconnect" },
      { id: R.DEFAULT_ROUTE, key: "$default" },
    ];
    for (const { id, key } of cases) {
      const state = buildDisplayState(id);
      expect(state["RouteKey"]).toBe(key);
    }
  });

  it("integrations display with `AWS_PROXY` type after placeholder substitution", () => {
    for (const id of [
      R.CONNECT_INTEGRATION,
      R.DISCONNECT_INTEGRATION,
      R.DEFAULT_INTEGRATION,
    ]) {
      const state = buildDisplayState(id);
      expect(state["IntegrationType"]).toBe("AWS_PROXY");
      // marker ref → display placeholder `(from <resourceId>)`.
      expect(String(state["ApiId"])).toBe("(from websocket-api)");
      expect(String(state["IntegrationUri"])).toBe("(from lambda-fn)");
    }
  });

  it("routes point at their matching integration via substituted Target", () => {
    const cases = [
      { route: R.CONNECT_ROUTE, integration: R.CONNECT_INTEGRATION },
      { route: R.DISCONNECT_ROUTE, integration: R.DISCONNECT_INTEGRATION },
      { route: R.DEFAULT_ROUTE, integration: R.DEFAULT_INTEGRATION },
    ];
    for (const { route, integration } of cases) {
      const state = buildDisplayState(route);
      // After placeholder substitution, Target becomes
      // `integrations/(from <integration-id>)` — still human-readable.
      expect(String(state["Target"])).toBe(
        `integrations/(from ${integration})`,
      );
    }
  });

  it("stage displays `production`, AutoDeploy true, and placeholder AccessLog destination", () => {
    const state = buildDisplayState(R.DEFAULT_STAGE);
    expect(state["StageName"]).toBe("production");
    expect(state["AutoDeploy"]).toBe(true);
    const accessLog = state["AccessLogSettings"] as Record<string, unknown>;
    expect(String(accessLog["DestinationArn"])).toBe("(from access-log-group)");
  });

  it("every one of the 12 resources produces a non-empty display state with no raw marker tokens", () => {
    for (const resource of websocketApiPattern.resourceList) {
      const state = buildDisplayState(resource.resourceId);
      expect(Object.keys(state).length).toBeGreaterThan(0);
      // No raw marker tokens should be visible to the user after
      // placeholder substitution — the user sees "(from lambda-fn)"
      // not "__ASSIGNEE_GETATT_lambda-fn_Arn__".
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain("__ASSIGNEE_");
    }
  });

  it("sum of displayable resources equals the full 12-resource compound (no silent drops)", () => {
    let rendered = 0;
    for (const resource of websocketApiPattern.resourceList) {
      const state = buildDisplayState(resource.resourceId);
      if (Object.keys(state).length > 0) rendered++;
    }
    expect(rendered).toBe(12);
  });
});

describe("websocket-api — provisionable flag surface matches the WebSocket compound contract", () => {
  it("exactly 3 resources are provisionable (IAM role, Lambda, LogGroup)", () => {
    const provisionable = websocketApiPattern.resourceList.filter(
      (r) => r.provisionable !== false,
    );
    expect(provisionable).toHaveLength(3);
    const ids = provisionable.map((r) => r.resourceId);
    expect(ids).toContain(R.IAM_EXECUTION_ROLE);
    expect(ids).toContain(R.LAMBDA_FN);
    expect(ids).toContain(R.ACCESS_LOG_GROUP);
  });

  it("exactly 9 resources are display-only companions", () => {
    const companions = websocketApiPattern.resourceList.filter(
      (r) => r.provisionable === false,
    );
    expect(companions).toHaveLength(9);
  });
});
