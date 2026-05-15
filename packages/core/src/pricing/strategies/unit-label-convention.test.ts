/**
 * Snapshot guard: every per-million unit string emitted by pricing strategies
 * must match the canonical "/M <noun>" convention.
 *
 * Mirrors the decomposer guard at
 * `packages/core/src/pricing/decomposers/unit-label-convention.test.ts`.
 *
 * Canonical regex: /^\/M [a-z ]+$/
 *   - Starts with "/M "
 *   - Followed by one or more lowercase letters or spaces (the noun)
 *   - No tilde, no "million" spelled out, no abbreviations like "/M req"
 *
 * Non-million units ("/hr", "/GB-mo", "/WCU-hr", etc.) are intentionally
 * excluded — they don't claim to use the per-million convention.
 */

import { describe, it, expect } from "vitest";
import { dynamodbPricingStrategy } from "./dynamodb.js";
import { snsPricingStrategy } from "./sns.js";
import { apiGatewayV2PricingStrategy } from "./apigatewayv2.js";
import { lambdaPricingStrategy } from "./lambda.js";
import { sqsPricingStrategy } from "./sqs.js";

/** The canonical pattern for per-million unit strings. */
const CANONICAL_PER_MILLION_REGEX = /^\/M [a-z ]+$/;

/**
 * Matches any unit string that is claiming to be a "per-million" unit
 * (either canonical or drifted).
 */
function isPerMillionUnit(unit: string): boolean {
  return (
    unit.startsWith("/M ") ||
    unit.toLowerCase().includes("million") ||
    unit.includes("~")
  );
}

/** All desiredState shapes to exercise (covers protocol/billing branches). */
const DESIRED_STATES: Record<string, unknown>[] = [
  {},
  { ProtocolType: "HTTP" },
  { ProtocolType: "WEBSOCKET" },
  { BillingMode: "PAY_PER_REQUEST" },
  {
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
  },
  { MemorySize: 128 },
  { MemorySize: 512 },
  { FifoQueue: false },
  { FifoQueue: true },
];

const TARGET_STRATEGIES = [
  { name: "DynamoDB", strategy: dynamodbPricingStrategy },
  { name: "SNS", strategy: snsPricingStrategy },
  { name: "ApiGatewayV2", strategy: apiGatewayV2PricingStrategy },
  { name: "Lambda", strategy: lambdaPricingStrategy },
  { name: "SQS", strategy: sqsPricingStrategy },
];

describe("unit-label-convention (strategies): all per-million unit strings match canonical /M <noun> format", () => {
  for (const { name, strategy } of TARGET_STRATEGIES) {
    describe(`${name} strategy`, () => {
      for (const state of DESIRED_STATES) {
        it(`mcpConfig(${JSON.stringify(state)}) — unit is canonical if per-million`, () => {
          if (!strategy.mcpConfig) return;
          let config;
          try {
            config = strategy.mcpConfig(state);
          } catch {
            return;
          }
          if (!config) return;
          const { unit } = config;
          if (unit && isPerMillionUnit(unit)) {
            expect(
              unit,
              `${name} strategy: mcpConfig(${JSON.stringify(state)}) unit "${unit}" must match ${CANONICAL_PER_MILLION_REGEX}`,
            ).toMatch(CANONICAL_PER_MILLION_REGEX);
          }
        });

        it(`estimateLocal(${JSON.stringify(state)}) — label has no drifted per-million string`, () => {
          if (!strategy.estimateLocal) return;
          let estimate;
          try {
            estimate = strategy.estimateLocal(state);
          } catch {
            return;
          }
          if (!estimate) return;
          const { label } = estimate;
          // estimateLocal labels that contain a per-million rate (e.g. Lambda fallback)
          // must also use the canonical /M convention — no "million req" literals.
          if (label && label.toLowerCase().includes("million req")) {
            // This line will fail if any drift is re-introduced
            expect(
              label,
              `${name} strategy: estimateLocal(${JSON.stringify(state)}) label "${label}" contains drifted "million req" — use formatUnitSuffix("request") instead`,
            ).not.toMatch(/million req/);
          }
        });
      }
    });
  }

  // Spot checks: assert the exact canonical values
  it("DynamoDB on-demand mcpConfig unit is /M write reqs", () => {
    const config = dynamodbPricingStrategy.mcpConfig!({});
    expect(config?.unit).toBe("/M write reqs");
  });

  it("SNS mcpConfig unit is /M publishes", () => {
    const config = snsPricingStrategy.mcpConfig!({});
    expect(config?.unit).toBe("/M publishes");
  });

  it("ApiGatewayV2 WebSocket mcpConfig unit is /M messages", () => {
    const config = apiGatewayV2PricingStrategy.mcpConfig!({
      ProtocolType: "WEBSOCKET",
    });
    expect(config?.unit).toBe("/M messages");
  });

  it("Lambda estimateLocal label contains /M requests (not /million req)", () => {
    const estimate = lambdaPricingStrategy.estimateLocal!({ MemorySize: 128 });
    expect(estimate.label).toMatch(/\/M requests/);
    expect(estimate.label).not.toMatch(/million req/);
  });

  it("SQS mcpConfig unit is /M requests", () => {
    const config = sqsPricingStrategy.mcpConfig!({});
    expect(config?.unit).toBe("/M requests");
  });

  it("SQS mcpConfig unit is /M requests (FIFO queue)", () => {
    const config = sqsPricingStrategy.mcpConfig!({ FifoQueue: true });
    expect(config?.unit).toBe("/M requests");
  });
});
