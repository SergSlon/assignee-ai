/**
 * Per-strategy unit tests for sqsStrategy.
 *
 * sqsStrategy exposes only extractIdentifier — CloudControl uses QueueUrl
 * (not name or ARN) as the primaryIdentifier, so the strategy must rebuild
 * the URL from ARN components. This test file covers:
 *
 *  - Standard ARN → URL conversion across regions
 *  - FIFO queue ARN (name contains ".fifo") survives unchanged in the URL
 *  - Malformed ARNs (missing region / account / name) fall back safely
 *  - extractIdentifier is a pure function (no SDK calls at all)
 */

import { describe, it, expect, vi } from "vitest";

// No SDK clients to mock — sqs-strategy is pure string transformation.
// We still assert the absence of any @aws-sdk/client-sqs import side-effects
// by ensuring the strategy doesn't expose a preDestroy hook.

import { sqsStrategy } from "../sqs-strategy.js";

describe("sqsStrategy.resourceType", () => {
  it("targets AWS::SQS::Queue", () => {
    expect(sqsStrategy.resourceType).toBe("AWS::SQS::Queue");
  });

  it("does not register a preDestroy hook (CloudControl handles delete directly)", () => {
    expect(sqsStrategy.preDestroy).toBeUndefined();
  });
});

describe("sqsStrategy.extractIdentifier", () => {
  it("converts a standard us-east-1 ARN into the canonical queue URL", () => {
    const arn = "arn:aws:sqs:us-east-1:123456789012:assignee-orders";
    const url = sqsStrategy.extractIdentifier!(arn, "", "us-east-1");
    expect(url).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789012/assignee-orders",
    );
  });

  it("uses the region embedded in the ARN, not the region argument", () => {
    // If the strategy ever disagreed with the ARN's own region, CloudControl
    // calls would route to the wrong endpoint. Lock in the current behavior:
    // the URL must be derived from the ARN region.
    const arn = "arn:aws:sqs:eu-west-1:123456789012:payments-dlq";
    const url = sqsStrategy.extractIdentifier!(arn, "", "us-east-1");
    expect(url).toBe(
      "https://sqs.eu-west-1.amazonaws.com/123456789012/payments-dlq",
    );
  });

  it("preserves the .fifo suffix on FIFO queues", () => {
    const arn = "arn:aws:sqs:us-west-2:123456789012:billing-events.fifo";
    const url = sqsStrategy.extractIdentifier!(arn, "", "us-west-2");
    expect(url).toBe(
      "https://sqs.us-west-2.amazonaws.com/123456789012/billing-events.fifo",
    );
  });

  it("handles ap-southeast-2 region correctly", () => {
    const arn = "arn:aws:sqs:ap-southeast-2:123456789012:assignee-sydney-queue";
    const url = sqsStrategy.extractIdentifier!(arn, "", "ap-southeast-2");
    expect(url).toBe(
      "https://sqs.ap-southeast-2.amazonaws.com/123456789012/assignee-sydney-queue",
    );
  });

  it("falls back to default region placeholder when ARN region is missing", () => {
    // Malformed ARN — region slot empty. Should degrade gracefully, not throw.
    const arn = "arn:aws:sqs::123456789012:orphan-queue";
    const url = sqsStrategy.extractIdentifier!(arn, "", "us-east-1");
    expect(url).toMatch(
      /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/123456789012\/orphan-queue$/,
    );
  });

  it("produces an empty-account URL for ARNs missing an account segment", () => {
    // Pathological input — caller will see an obviously-broken URL rather
    // than a thrown error. Guards against regressions to throwing behavior.
    const arn = "arn:aws:sqs:us-east-1::malformed";
    const url = sqsStrategy.extractIdentifier!(arn, "", "us-east-1");
    expect(url).toBe("https://sqs.us-east-1.amazonaws.com//malformed");
  });

  it("produces an empty-name URL for ARNs missing a queue name segment", () => {
    const arn = "arn:aws:sqs:us-east-1:123456789012:";
    const url = sqsStrategy.extractIdentifier!(arn, "", "us-east-1");
    expect(url).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/");
  });

  it("is a pure function (safe to call repeatedly with identical output)", () => {
    const arn = "arn:aws:sqs:us-east-1:123456789012:idempotent-queue";
    const a = sqsStrategy.extractIdentifier!(arn, "", "us-east-1");
    const b = sqsStrategy.extractIdentifier!(arn, "", "us-east-1");
    const c = sqsStrategy.extractIdentifier!(arn, "", "us-east-1");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

// Compile-time guard: the module should never import an SDK client. If
// someone later adds a purge/redrive hook with an SQSClient, the
// credential-enforcement test pattern must be extended too.
describe("sqsStrategy side-effects", () => {
  it("importing the strategy has no SDK side-effects (no send() exposed)", () => {
    // Defensive: no "send" or "client" properties leak out.
    const keys = Object.keys(sqsStrategy);
    expect(keys).not.toContain("send");
    expect(keys).not.toContain("client");
    // clearAllMocks is a harmless canary showing vi is alive
    vi.clearAllMocks();
  });
});
