/**
 * Tests for `extractInlineName` (SX-2 / PH1-C-1).
 *
 * Closes the inline-name extraction gap: intents like `"SNS topic
 * genai-events"` that omit the explicit `"named"` / `"called"` keyword
 * used to fall through to the auto-name generator. After SX-2 the
 * inline phrasing routes the candidate to the resource's name field
 * (when it passes the AWS naming constraint) and emits an INFO advisory
 * documenting how to suppress the hint.
 *
 * Probe variations A–F per story spec.
 */

import { describe, it, expect } from "vitest";
import { extractInlineName } from "./name-extractor.js";
import { RESOURCE_TYPES } from "@/index.js";
import type { Advisory } from "../intent-types.js";

describe("extractInlineName — inline-name SX-2", () => {
  // ── Variation A — happy path, single-word name on SNS ──────────────────────
  it("Variation A — extracts inline name for SNS topic + emits INFO advisory", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    extractInlineName(
      "Create an SNS topic genai-events",
      RESOURCE_TYPES.SNS_TOPIC,
      elicited,
      advisories,
    );
    expect(elicited["TopicName"]).toBe("genai-events");
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.code).toBe("INLINE_NAME_DETECTED");
    expect(advisories[0]?.message).toContain("genai-events");
    expect(advisories[0]?.message).toContain("TopicName");
  });

  // ── Variation B — kebab-case multi-segment name on Lambda ──────────────────
  it("Variation B — extracts kebab-case multi-segment Lambda name", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    extractInlineName(
      "Create a Lambda function genai-next-hello-world",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
      elicited,
      advisories,
    );
    expect(elicited["FunctionName"]).toBe("genai-next-hello-world");
  });

  // ── Variation C — name followed by additional clause on SQS ────────────────
  it("Variation C — extracts SQS QueueName from intent with trailing 'with DLQ' clause", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    extractInlineName(
      "Create an SQS queue genai-jobs with DLQ",
      RESOURCE_TYPES.SQS_QUEUE,
      elicited,
      advisories,
    );
    expect(elicited["QueueName"]).toBe("genai-jobs");
  });

  // ── Variation D — invalid 'with' boundary keyword falls through ────────────
  it("Variation D — does NOT extract when token after keyword is a boundary keyword", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    extractInlineName(
      "Create an SNS topic with high throughput",
      RESOURCE_TYPES.SNS_TOPIC,
      elicited,
      advisories,
    );
    expect(elicited["TopicName"]).toBeUndefined();
    expect(advisories).toHaveLength(0);
  });

  // ── Variation E — explicit keyword path already set name, inline must not override ─
  it("Variation E — does NOT override a name already set by the keyword path", () => {
    const elicited: Record<string, unknown> = { TopicName: "bar" };
    const advisories: Advisory[] = [];
    extractInlineName(
      "Create an SNS topic foo called bar",
      RESOURCE_TYPES.SNS_TOPIC,
      elicited,
      advisories,
    );
    expect(elicited["TopicName"]).toBe("bar");
    expect(advisories).toHaveLength(0);
  });

  // ── Variation F — S3 AWS-naming constraint violation falls through ────────
  it("Variation F — does NOT extract S3 bucket name when candidate violates lowercase constraint", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    extractInlineName(
      "Create an S3 bucket FOO_BAR_BAZ",
      RESOURCE_TYPES.S3_BUCKET,
      elicited,
      advisories,
    );
    expect(elicited["BucketName"]).toBeUndefined();
    expect(advisories).toHaveLength(0);
  });

  // ── Variation G — DynamoDB table name extraction ──────────────────────────
  it("Variation G — extracts DynamoDB TableName from inline phrasing", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    extractInlineName(
      "Create a DynamoDB table sessions",
      RESOURCE_TYPES.DYNAMODB_TABLE,
      elicited,
      advisories,
    );
    expect(elicited["TableName"]).toBe("sessions");
  });

  // ── Variation H — S3 bucket valid lowercase name extracts cleanly ──────────
  it("Variation H — extracts S3 BucketName when candidate passes lowercase constraint", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    extractInlineName(
      "Create an S3 bucket genai-next-uploads",
      RESOURCE_TYPES.S3_BUCKET,
      elicited,
      advisories,
    );
    expect(elicited["BucketName"]).toBe("genai-next-uploads");
  });

  // ── Resource without a name field — silently skipped ───────────────────────
  it("does not crash for resource types without a name field", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    extractInlineName(
      "Create an EC2 instance webhost",
      RESOURCE_TYPES.EC2_INSTANCE,
      elicited,
      advisories,
    );
    // EC2 has no top-level Name property; nothing extracted, no crash.
    expect(advisories).toHaveLength(0);
  });
});
