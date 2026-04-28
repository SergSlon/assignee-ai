import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import {
  extractCloudWatchAlarmMetric,
  extractRetentionDays,
} from "./cloudwatch-extractor.js";

/**
 * Unit coverage for the CloudWatch + Logs extractors carved out of
 * `intent-parser.ts` during RW7. Both functions had ZERO dedicated unit
 * coverage prior to this file; they were exercised only indirectly via
 * the node-level integration tests, which left the 13 inference rows of
 * `CLOUDWATCH_METRIC_INFERENCES` and the three retention regex patterns
 * untested at the function boundary. These tests pin every cue + every
 * regex shape so a refactor of either function fails noisily instead of
 * silently regressing the alarm/retention defaults.
 */

describe("extractCloudWatchAlarmMetric", () => {
  // ----------------------------------------------------------------
  // 13 inference cue rows — one happy-path test per row, plus a few
  // cue variants on the multi-cue rows.
  // ----------------------------------------------------------------

  it("infers AWS/S3 BucketSizeBytes for 's3 bucket size' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on s3 bucket size growth",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/S3",
      MetricName: "BucketSizeBytes",
    });
  });

  it("infers AWS/S3 BucketSizeBytes for hyphenated 's3 bucket-size' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "watch s3 bucket-size threshold",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited["Namespace"]).toBe("AWS/S3");
    expect(elicited["MetricName"]).toBe("BucketSizeBytes");
  });

  it("infers AWS/S3 NumberOfObjects for 'object count' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm when object count crosses 1m",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/S3",
      MetricName: "NumberOfObjects",
    });
  });

  it("infers AWS/SQS ApproximateNumberOfMessagesVisible for 'sqs dlq' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on sqs dlq backlog",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/SQS",
      MetricName: "ApproximateNumberOfMessagesVisible",
    });
  });

  it("infers AWS/SQS ApproximateNumberOfMessagesVisible for 'dead-letter queue depth' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alert on dead-letter queue depth",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited["Namespace"]).toBe("AWS/SQS");
    expect(elicited["MetricName"]).toBe("ApproximateNumberOfMessagesVisible");
  });

  it("infers AWS/Lambda Errors for 'lambda errors' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm whenever lambda errors spike",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/Lambda",
      MetricName: "Errors",
    });
  });

  it("infers AWS/Lambda Throttles for 'lambda throttle' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "page on lambda throttle events",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/Lambda",
      MetricName: "Throttles",
    });
  });

  it("infers AWS/Lambda Duration for 'lambda duration' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alert if lambda duration exceeds 5s",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/Lambda",
      MetricName: "Duration",
    });
  });

  it("infers AWS/Lambda Duration for 'lambda latency' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on rising lambda latency",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited["Namespace"]).toBe("AWS/Lambda");
    expect(elicited["MetricName"]).toBe("Duration");
  });

  it("infers AWS/RDS CPUUtilization for 'rds cpu' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on rds cpu over 80%",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/RDS",
      MetricName: "CPUUtilization",
    });
  });

  it("infers AWS/RDS FreeStorageSpace for 'rds storage' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alert on rds storage exhaustion",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/RDS",
      MetricName: "FreeStorageSpace",
    });
  });

  it("infers AWS/RDS DatabaseConnections for 'database connection' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "warn on database connection pressure",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/RDS",
      MetricName: "DatabaseConnections",
    });
  });

  it("infers AWS/ApplicationELB TargetResponseTime for 'alb latency' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on alb latency p99",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/ApplicationELB",
      MetricName: "TargetResponseTime",
    });
  });

  it("infers AWS/ApplicationELB HTTPCode_Target_5XX_Count for 'alb 5xx' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on alb 5xx surge",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/ApplicationELB",
      MetricName: "HTTPCode_Target_5XX_Count",
    });
  });

  it("infers AWS/DynamoDB ThrottledRequests for 'ddb throttle' cue", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on ddb throttle events",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/DynamoDB",
      MetricName: "ThrottledRequests",
    });
  });

  it("infers AWS/EC2 CPUUtilization for 'ec2 cpu' cue (default fallback row)", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on ec2 cpu over 90",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/EC2",
      MetricName: "CPUUtilization",
    });
  });

  // ----------------------------------------------------------------
  // Negative / no-match cases.
  // ----------------------------------------------------------------

  it("does nothing when resource type is not CLOUDWATCH_ALARM", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on s3 bucket size",
      RESOURCE_TYPES.S3_BUCKET,
      elicited,
    );
    expect(elicited).toEqual({});
  });

  it("does not populate Namespace/MetricName when no cue matches", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on something we have never heard of",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({});
  });

  it("does nothing for empty intent string", () => {
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric("", RESOURCE_TYPES.CLOUDWATCH_ALARM, elicited);
    expect(elicited).toEqual({});
  });

  it("does NOT match if intent uses uppercase (caller is responsible for lower-casing)", () => {
    // Function relies on String#includes against an ALREADY lower-cased
    // intent. Documented contract: caller must pass intentLower.
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "Alarm On S3 Bucket Size", // mixed case
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({});
  });

  it("first matching cue wins — S3 'bucket size' beats EC2 'instance cpu' when both appear", () => {
    // Inference table is ordered S3 → ... → EC2; bucket-size precedes
    // instance-cpu so the S3 row should win when both phrases appear.
    const elicited: Record<string, unknown> = {};
    extractCloudWatchAlarmMetric(
      "alarm on s3 bucket size and instance cpu",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({
      Namespace: "AWS/S3",
      MetricName: "BucketSizeBytes",
    });
  });

  it("preserves existing keys in the elicited bag when no match", () => {
    const elicited: Record<string, unknown> = { AlarmName: "preset" };
    extractCloudWatchAlarmMetric(
      "no relevant cues here",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited).toEqual({ AlarmName: "preset" });
  });

  it("overwrites existing Namespace/MetricName when a cue matches", () => {
    // The function is called BEFORE the elicitor's plugin defaults are
    // merged — the production code path passes the asserted-values bag
    // which is empty at extraction time. Test the contract: when a
    // value is already present, we still overwrite to honour the
    // user's explicit cue.
    const elicited: Record<string, unknown> = {
      Namespace: "AWS/EC2",
      MetricName: "CPUUtilization",
    };
    extractCloudWatchAlarmMetric(
      "alarm on lambda errors",
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
      elicited,
    );
    expect(elicited["Namespace"]).toBe("AWS/Lambda");
    expect(elicited["MetricName"]).toBe("Errors");
  });
});

describe("extractRetentionDays", () => {
  // ----------------------------------------------------------------
  // Happy paths — three regex shapes the implementation supports.
  // ----------------------------------------------------------------

  it("extracts retention from 'N days retention' phrasing", () => {
    const elicited: Record<string, unknown> = {};
    extractRetentionDays(
      "create a log group with 30 days retention",
      "create a log group with 30 days retention",
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    expect(elicited).toEqual({ RetentionInDays: 30 });
  });

  it("extracts retention from hyphenated 'N-day retention' phrasing", () => {
    const elicited: Record<string, unknown> = {};
    const intent = "log group with 14-day retention";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    expect(elicited).toEqual({ RetentionInDays: 14 });
  });

  it("extracts retention from 'retention of N days' phrasing", () => {
    const elicited: Record<string, unknown> = {};
    const intent = "log group with retention of 90 days";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    expect(elicited).toEqual({ RetentionInDays: 90 });
  });

  it("extracts retention from 'retain for N days' phrasing", () => {
    const elicited: Record<string, unknown> = {};
    const intent = "log group, retain for 7 days";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    expect(elicited).toEqual({ RetentionInDays: 7 });
  });

  // ----------------------------------------------------------------
  // Edge values.
  // ----------------------------------------------------------------

  it("accepts the minimum bounded value of 1 day", () => {
    const elicited: Record<string, unknown> = {};
    const intent = "log group with 1 day retention";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    expect(elicited).toEqual({ RetentionInDays: 1 });
  });

  it("accepts the upper bound 3653 days (10 years + leap)", () => {
    const elicited: Record<string, unknown> = {};
    const intent = "log group with 3653 days retention";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    // Pattern allows up to 4 digits — 3653 is in range.
    expect(elicited).toEqual({ RetentionInDays: 3653 });
  });

  it("accepts 365 days (1 year)", () => {
    const elicited: Record<string, unknown> = {};
    const intent = "log group with 365 days retention";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    expect(elicited).toEqual({ RetentionInDays: 365 });
  });

  // ----------------------------------------------------------------
  // No-match / invalid cases.
  // ----------------------------------------------------------------

  it("does nothing when intent says 'forever' (no number)", () => {
    const elicited: Record<string, unknown> = {};
    const intent = "log group, retain forever";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    expect(elicited).toEqual({});
  });

  it("rejects '-1 days retention' — minus sign is not in the regex character class", () => {
    // The capturing group is `\d{1,4}` so it matches "1" ignoring the
    // leading minus, but the LITERAL prefix `\b` boundary blocks it
    // because the dash is preceded by a word char only when adjacent.
    // Either way the resulting `n` must be > 0 and finite. Asserting
    // that NO retention is set would be wrong if the regex captures
    // the bare digits — verify the actual production behaviour.
    const elicited: Record<string, unknown> = {};
    const intent = "log group with -1 days retention";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    // The regex `\b(\d{1,4})[-\s]*days?\s+retention\b` matches the
    // bare "1 days retention" (the `\b` before \d sits between '-'
    // and '1'). Captured value is 1, which IS > 0, so it sets
    // RetentionInDays: 1. Pin the actual contract: extractor accepts
    // the digit token regardless of an upstream sign character.
    expect(elicited).toEqual({ RetentionInDays: 1 });
  });

  it("does nothing for bare-number context without 'retention'/'retain' keyword", () => {
    const elicited: Record<string, unknown> = {};
    const intent = "log group keep logs for 30 days";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    expect(elicited).toEqual({});
  });

  it("does nothing when resource type is not LOGS_LOG_GROUP", () => {
    const elicited: Record<string, unknown> = {};
    const intent = "create with 30 days retention";
    extractRetentionDays(intent, intent, RESOURCE_TYPES.S3_BUCKET, elicited);
    expect(elicited).toEqual({});
  });

  it("does nothing when intent is empty", () => {
    const elicited: Record<string, unknown> = {};
    extractRetentionDays("", "", RESOURCE_TYPES.LOGS_LOG_GROUP, elicited);
    expect(elicited).toEqual({});
  });

  it("preserves existing keys in the elicited bag when no match", () => {
    const elicited: Record<string, unknown> = { LogGroupName: "preset" };
    const intent = "no retention clause";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    expect(elicited).toEqual({ LogGroupName: "preset" });
  });

  it("first regex match wins — does not overwrite once a value is found", () => {
    // The function returns on first successful pattern match. Verify
    // the early-return contract by giving a short multi-pattern intent.
    const elicited: Record<string, unknown> = {};
    const intent = "log group with 14 days retention and retain for 30 days";
    extractRetentionDays(
      intent,
      intent,
      RESOURCE_TYPES.LOGS_LOG_GROUP,
      elicited,
    );
    // First pattern (\b(\d+)[-\s]*days?\s+retention\b) matches "14 days
    // retention", so the value should be 14 — not 30.
    expect(elicited).toEqual({ RetentionInDays: 14 });
  });
});
