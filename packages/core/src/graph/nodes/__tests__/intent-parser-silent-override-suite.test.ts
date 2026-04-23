/**
 * Epic 98 Wave 5 fixer e98.W5.N2 — intent silent-override suite.
 *
 * Closes Epic 97 D-13 + D-17 + C-P4:
 *
 *   - D-13 (HIGH, SNS Subscription): Protocol auto-inference was broken.
 *     `+15551234567` (E.164 phone) fell through to the plugin's
 *     `defaults.Protocol="sqs"`, silently producing a plan that
 *     subscribed an SQS queue instead of an SMS endpoint. Lambda ARNs
 *     similarly fell through when the URL / email / existing-ARN
 *     matches all missed. Fix: intent-parser now infers `sms` from
 *     E.164 phone shape and `firehose` from firehose ARN; the unsafe
 *     `sqs` plugin default was removed.
 *
 *   - D-17 (HIGH, CloudWatch Alarm): `alarm on S3 bucket size` plans
 *     shipped with `Namespace=AWS/EC2, MetricName=CPUUtilization` from
 *     the plugin `initialValue` defaults. Fix: intent-parser now maps
 *     service keywords ("s3 bucket-size", "sqs dlq", "lambda error",
 *     etc.) to `(Namespace, MetricName)` pairs via a conservative
 *     narrow table. Partial inference falls back to elicitation so
 *     users see the gap rather than a silent wrong default.
 *
 *   - C-P4 (LOW, RDS DBSubnetGroupName phrasing-dependent) — closed
 *     implicitly by W3.A1 (RDS is now on the backfill allowlist; the
 *     plugin's defaults land on every bare intent regardless of
 *     phrasing). No additional changes in this suite.
 *
 * Locked invariants (5 variations per the dispatch brief):
 *
 *   1. E.164 phone → Protocol=sms, Endpoint normalised to `+\d{8,15}`.
 *   2. Lambda ARN → Protocol=lambda (retrofit lock — already worked,
 *      pinned so the W3.A1 allowlist expansion doesn't re-introduce
 *      the sqs fallback).
 *   3. Ambiguous intent (no endpoint shape) → no Protocol / Endpoint
 *      written by intent-parser; elicitation will fire downstream.
 *   4. `alarm on S3 bucket size` → Namespace=AWS/S3,
 *      MetricName=BucketSizeBytes.
 *   5. `alarm on SQS DLQ depth` → Namespace=AWS/SQS,
 *      MetricName=ApproximateNumberOfMessagesVisible.
 */

import { describe, it, expect, vi } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import { extractAssertedValues } from "../intent-parser.js";

// Keep logger mocked so the region-extraction log from intent-parser
// (emitted on every extraction since e98.W2.R1) doesn't pollute test
// output.
vi.mock("../../../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    INTENT_PARSED: "intent_parsed",
    REGION_EXTRACTION: "region_extraction",
  },
}));

describe("SNS::Subscription Protocol inference (e98.W5.N2 D-13)", () => {
  // Variation 1 — E.164 phone number → sms.
  it("classifies `+15551234567` as Protocol=sms, Endpoint normalised", () => {
    const out = extractAssertedValues(
      "Create an SNS subscription to +15551234567 for alerts",
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
    expect(out.elicited["Protocol"]).toBe("sms");
    expect(out.elicited["Endpoint"]).toBe("+15551234567");
  });

  it("classifies `+1 (555) 123-4567` (punctuated E.164) as sms + compacts endpoint", () => {
    const out = extractAssertedValues(
      "SNS subscription for pager duty: +1 (555) 123-4567",
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
    expect(out.elicited["Protocol"]).toBe("sms");
    expect(out.elicited["Endpoint"]).toBe("+15551234567");
  });

  it("classifies `+44 20 7946 0958` (UK number) as sms", () => {
    const out = extractAssertedValues(
      "SNS subscription for UK oncall: +44 20 7946 0958",
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
    expect(out.elicited["Protocol"]).toBe("sms");
    expect(out.elicited["Endpoint"]).toBe("+442079460958");
  });

  it("does NOT classify a plain US 10-digit number (no `+` prefix) as sms — avoids false positives", () => {
    // A bare `5551234567` could be a ZIP-adjacent digit string, an
    // account id substring, a phone number, etc. Only the explicit
    // E.164 `+` signals we should infer sms.
    const out = extractAssertedValues(
      "SNS subscription to 5551234567",
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
    expect(out.elicited["Protocol"]).toBeUndefined();
    expect(out.elicited["Endpoint"]).toBeUndefined();
  });

  // Variation 2 — Lambda ARN still routes to lambda.
  it("classifies a Lambda ARN as Protocol=lambda", () => {
    const out = extractAssertedValues(
      "SNS subscription to arn:aws:lambda:us-east-1:210987654321:function:my-fn",
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
    expect(out.elicited["Protocol"]).toBe("lambda");
    expect(out.elicited["Endpoint"]).toBe(
      "arn:aws:lambda:us-east-1:210987654321:function:my-fn",
    );
  });

  it("classifies a GovCloud Lambda ARN as Protocol=lambda (partition-aware)", () => {
    const out = extractAssertedValues(
      "SNS subscription to arn:aws-us-gov:lambda:us-gov-west-1:210987654321:function:my-fn",
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
    expect(out.elicited["Protocol"]).toBe("lambda");
  });

  it("classifies a Firehose ARN as Protocol=firehose", () => {
    const out = extractAssertedValues(
      "SNS subscription to arn:aws:firehose:us-east-1:210987654321:deliverystream/my-stream",
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
    expect(out.elicited["Protocol"]).toBe("firehose");
  });

  // Variation 3 — ambiguous intent: no inference, elicitation fires.
  it("leaves Protocol/Endpoint unset when the intent has no endpoint shape", () => {
    const out = extractAssertedValues(
      "Create an SNS subscription",
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
    expect(out.elicited["Protocol"]).toBeUndefined();
    expect(out.elicited["Endpoint"]).toBeUndefined();
  });

  it("leaves Protocol unset when the intent has an SQS ARN (SQS still works)", () => {
    // Sanity check — the existing sqs-ARN inference still lands.
    const out = extractAssertedValues(
      "SNS subscription to arn:aws:sqs:us-east-1:210987654321:my-queue",
      RESOURCE_TYPES.SNS_SUBSCRIPTION,
    );
    expect(out.elicited["Protocol"]).toBe("sqs");
  });
});

describe("CloudWatch Alarm metric inference (e98.W5.N2 D-17)", () => {
  // Variation 4 — S3 bucket-size alarm.
  it("maps `alarm on S3 bucket size` → AWS/S3 + BucketSizeBytes", () => {
    const out = extractAssertedValues(
      "Create an alarm on S3 bucket size over 10GB",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(out.elicited["Namespace"]).toBe("AWS/S3");
    expect(out.elicited["MetricName"]).toBe("BucketSizeBytes");
  });

  it("maps `S3 bucket-size` (hyphenated phrasing) → AWS/S3", () => {
    const out = extractAssertedValues(
      "Alarm when S3 bucket-size exceeds threshold",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(out.elicited["Namespace"]).toBe("AWS/S3");
    expect(out.elicited["MetricName"]).toBe("BucketSizeBytes");
  });

  // Variation 5 — SQS DLQ depth alarm.
  it("maps `alarm on SQS DLQ depth` → AWS/SQS + ApproximateNumberOfMessagesVisible", () => {
    const out = extractAssertedValues(
      "Create an alarm on SQS DLQ depth greater than 0",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(out.elicited["Namespace"]).toBe("AWS/SQS");
    expect(out.elicited["MetricName"]).toBe(
      "ApproximateNumberOfMessagesVisible",
    );
  });

  // -------------------------------------------------------------------
  // Additional service-keyword coverage
  // -------------------------------------------------------------------
  it("maps `alarm on Lambda errors` → AWS/Lambda + Errors", () => {
    const out = extractAssertedValues(
      "Create an alarm on Lambda errors greater than 5",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(out.elicited["Namespace"]).toBe("AWS/Lambda");
    expect(out.elicited["MetricName"]).toBe("Errors");
  });

  it("maps `RDS CPU` → AWS/RDS + CPUUtilization", () => {
    const out = extractAssertedValues(
      "Alarm on RDS CPU over 80%",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(out.elicited["Namespace"]).toBe("AWS/RDS");
    expect(out.elicited["MetricName"]).toBe("CPUUtilization");
  });

  it("maps `ALB 5xx` → AWS/ApplicationELB + HTTPCode_Target_5XX_Count", () => {
    const out = extractAssertedValues(
      "Alarm on ALB 5xx over 10",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(out.elicited["Namespace"]).toBe("AWS/ApplicationELB");
    expect(out.elicited["MetricName"]).toBe("HTTPCode_Target_5XX_Count");
  });

  it("maps `DynamoDB throttle` → AWS/DynamoDB + ThrottledRequests", () => {
    const out = extractAssertedValues(
      "Alarm on DynamoDB throttle count",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(out.elicited["Namespace"]).toBe("AWS/DynamoDB");
    expect(out.elicited["MetricName"]).toBe("ThrottledRequests");
  });

  it("maps `EC2 CPU` → AWS/EC2 + CPUUtilization (the long-standing default)", () => {
    const out = extractAssertedValues(
      "Create an alarm on EC2 CPU over 90",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(out.elicited["Namespace"]).toBe("AWS/EC2");
    expect(out.elicited["MetricName"]).toBe("CPUUtilization");
  });

  // Negative — bare intent with no service keyword leaves Namespace /
  // MetricName unset so the wizard / LLM / plugin initialValue path
  // handles fallback.
  it("leaves Namespace/MetricName unset when the intent has no service keyword", () => {
    const out = extractAssertedValues(
      "Create a CloudWatch alarm",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(out.elicited["Namespace"]).toBeUndefined();
    expect(out.elicited["MetricName"]).toBeUndefined();
  });

  // Resource-type gate — the CW extractor must NOT fire on unrelated
  // resource types that happen to mention "s3 bucket" in the intent
  // (e.g. a plain S3 bucket create).
  it("does NOT write Namespace on an S3 bucket intent (wrong resourceType)", () => {
    const out = extractAssertedValues(
      "Create an S3 bucket named logs-archive",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.elicited["Namespace"]).toBeUndefined();
    expect(out.elicited["MetricName"]).toBeUndefined();
  });
});
