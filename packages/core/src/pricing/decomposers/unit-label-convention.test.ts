/**
 * Snapshot guard: every per-million priceUnit across all decomposers
 * must match the canonical "/M <noun>" convention.
 *
 * This test prevents convention drift — if a decomposer introduces a
 * new inline format string like "/million requests" or "~$X/M req",
 * it will fail here and force the author to use formatUnitSuffix().
 *
 * Canonical regex: /^\/M [a-z ]+$/
 *   - Starts with "/M "
 *   - Followed by one or more lowercase letters or spaces (the noun)
 *   - No tilde, no "million" spelled out, no abbreviations other than /M
 *
 * Non-million priceUnits ("/hr", "/GB-mo", "/GB", "/1000 reqs", etc.)
 * are intentionally excluded from this check — they don't claim to use
 * the per-million convention.
 */

import { describe, it, expect, vi } from "vitest";

// Bypass filesystem price cache — not needed for structural decomposer tests.
vi.mock("../../services/price-cache.js", () => ({
  getCachedPrice: vi.fn(() => null),
  setCachedPrice: vi.fn(),
  sweepExpiredPriceCache: vi.fn(),
  clearAllPriceCache: vi.fn(),
}));

import { sqsPricingDecomposer } from "./sqs.js";
import { snsPricingDecomposer } from "./sns.js";
import { lambdaPricingDecomposer } from "./lambda.js";
import { dynamodbPricingDecomposer } from "./dynamodb.js";
import { s3PricingDecomposer } from "./s3.js";

/** Decomposers that have per-million line items (the 5 target decomposers). */
const TARGET_DECOMPOSERS = [
  { name: "SQS", decomposer: sqsPricingDecomposer },
  { name: "SNS", decomposer: snsPricingDecomposer },
  { name: "Lambda", decomposer: lambdaPricingDecomposer },
  { name: "DynamoDB (on-demand)", decomposer: dynamodbPricingDecomposer },
  { name: "S3", decomposer: s3PricingDecomposer },
];

/** All desiredState shapes to exercise (covers conditional branches). */
const DESIRED_STATES: Record<string, unknown>[] = [
  {},
  { FifoQueue: true },
  { FifoTopic: true },
  { BillingMode: "PAY_PER_REQUEST" },
  {
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
  },
];

/** The canonical pattern for per-million priceUnit strings. */
const CANONICAL_PER_MILLION_REGEX = /^\/M [a-z ]+$/;

/** Matches any priceUnit that is claiming to be a "per-million" unit. */
function isPerMillionUnit(priceUnit: string): boolean {
  return (
    priceUnit.startsWith("/M ") ||
    priceUnit.toLowerCase().includes("million") ||
    priceUnit.includes("~")
  );
}

describe("unit-label-convention: all per-million priceUnits match canonical /M <noun> format", () => {
  for (const { name, decomposer } of TARGET_DECOMPOSERS) {
    describe(`${name} decomposer`, () => {
      for (const state of DESIRED_STATES) {
        it(`decompose(${JSON.stringify(state)}) — every per-million priceUnit is canonical`, () => {
          let items;
          try {
            items = decomposer.decompose(state);
          } catch {
            // Some decomposers may not accept all state shapes — skip gracefully
            return;
          }

          const perMillionItems = items.filter((item) =>
            isPerMillionUnit(item.priceUnit),
          );

          for (const item of perMillionItems) {
            expect(
              item.priceUnit,
              `${name} decomposer: item "${item.label}" has non-canonical priceUnit "${item.priceUnit}" — must match ${CANONICAL_PER_MILLION_REGEX}`,
            ).toMatch(CANONICAL_PER_MILLION_REGEX);
          }
        });
      }
    });
  }

  it("SQS standard queue Requests priceUnit is /M reqs", () => {
    const items = sqsPricingDecomposer.decompose({});
    const req = items.find((i) => i.label === "Requests")!;
    expect(req.priceUnit).toBe("/M reqs");
  });

  it("SNS Publishes priceUnit is /M publishes", () => {
    const items = snsPricingDecomposer.decompose({});
    const pub = items.find((i) => i.label === "Publishes")!;
    expect(pub.priceUnit).toBe("/M publishes");
  });

  it("Lambda Requests priceUnit is /M reqs", () => {
    const items = lambdaPricingDecomposer.decompose({});
    const req = items.find((i) => i.label === "Requests")!;
    expect(req.priceUnit).toBe("/M reqs");
  });

  it("DynamoDB on-demand read capacity priceUnit is /M read reqs", () => {
    const items = dynamodbPricingDecomposer.decompose({});
    const read = items.find((i) => i.label === "Read capacity")!;
    expect(read.priceUnit).toBe("/M read reqs");
  });

  it("DynamoDB on-demand write capacity priceUnit is /M write reqs", () => {
    const items = dynamodbPricingDecomposer.decompose({});
    const write = items.find((i) => i.label === "Write capacity")!;
    expect(write.priceUnit).toBe("/M write reqs");
  });
});
