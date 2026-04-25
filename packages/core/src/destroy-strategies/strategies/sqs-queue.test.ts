/**
 * Unit tests for the SQS Queue destroy strategy.
 *
 * Covers:
 *   1. extractIdentifier — standard ARN → correct QueueUrl
 *   2. extractIdentifier — FIFO queue ARN
 *   3. extractIdentifier — missing account/queue segments → graceful fallback
 *   4. Strategy metadata — no behavioural hooks (pure extractIdentifier)
 */

import { describe, it, expect } from "vitest";
import { sqsQueueStrategy } from "./sqs-queue.js";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";

// ── 1. Standard ARN → QueueUrl ────────────────────────────────────────

describe("sqsQueueStrategy.extractIdentifier — standard queue", () => {
  it("synthesizes the correct QueueUrl from a standard SQS ARN", () => {
    const arn = "arn:aws:sqs:us-east-1:210987654321:assignee-jobs";
    const url = sqsQueueStrategy.extractIdentifier!(arn, "", "us-east-1");
    expect(url).toBe(
      "https://sqs.us-east-1.amazonaws.com/210987654321/assignee-jobs",
    );
  });

  it("uses the ARN's own region (not the passed region) for the URL", () => {
    const arn = "arn:aws:sqs:eu-west-1:210987654321:assignee-jobs-eu";
    const url = sqsQueueStrategy.extractIdentifier!(
      arn,
      "ignored",
      "us-east-1",
    );
    // Region in URL comes from the ARN, not the passed-in region argument
    expect(url).toContain("eu-west-1.amazonaws.com");
  });
});

// ── 2. FIFO queue ARN ─────────────────────────────────────────────────

describe("sqsQueueStrategy.extractIdentifier — FIFO queue", () => {
  it("preserves .fifo suffix in the QueueUrl", () => {
    const arn = "arn:aws:sqs:us-west-2:210987654321:assignee-ordered.fifo";
    const url = sqsQueueStrategy.extractIdentifier!(arn, "", "us-west-2");
    expect(url).toBe(
      "https://sqs.us-west-2.amazonaws.com/210987654321/assignee-ordered.fifo",
    );
  });
});

// ── 3. Malformed ARN — missing segments graceful fallback ─────────────

describe("sqsQueueStrategy.extractIdentifier — malformed ARN", () => {
  it("returns an empty-segment URL rather than throwing on short ARN", () => {
    const shortArn = "arn:aws:sqs";
    // Should not throw
    const url = sqsQueueStrategy.extractIdentifier!(shortArn, "", "us-east-1");
    expect(url).toMatch(/^https:\/\/sqs\./);
  });
});

// ── 4. Strategy metadata ──────────────────────────────────────────────

describe("sqsQueueStrategy metadata", () => {
  it("has the correct resourceType", () => {
    expect(sqsQueueStrategy.resourceType).toBe(RESOURCE_TYPES.SQS_QUEUE);
  });

  it("has no behavioural hooks — only extractIdentifier", () => {
    expect(typeof sqsQueueStrategy.extractIdentifier).toBe("function");
    expect(sqsQueueStrategy.preDestroy).toBeUndefined();
    expect(sqsQueueStrategy.destroy).toBeUndefined();
    expect(sqsQueueStrategy.postDestroy).toBeUndefined();
  });

  it("does not set usesArnIdentifier", () => {
    expect(sqsQueueStrategy.usesArnIdentifier).toBeUndefined();
  });
});
