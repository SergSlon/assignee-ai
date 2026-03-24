import { describe, it, expect } from "vitest";
import { cloudWatchAlarmPlugin } from "./cloudwatch-alarm.js";

describe("cloudWatchAlarmPlugin", () => {
  it("has the correct resourceType", () => {
    expect(cloudWatchAlarmPlugin.resourceType).toBe("AWS::CloudWatch::Alarm");
  });

  it("commonFields count is ≤10", () => {
    expect(cloudWatchAlarmPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 6", () => {
    expect(cloudWatchAlarmPlugin.commonFields.length).toBe(6);
  });

  it("commonFields have expected names", () => {
    const names = cloudWatchAlarmPlugin.commonFields.map((f) => f.name);
    expect(names).toEqual([
      "AlarmName",
      "MetricName",
      "Namespace",
      "Threshold",
      "ComparisonOperator",
      "AlarmActions",
    ]);
  });

  it("advancedFields count is 8", () => {
    expect(cloudWatchAlarmPlugin.advancedFields.length).toBe(8);
  });

  it("advancedFields have expected names", () => {
    const names = cloudWatchAlarmPlugin.advancedFields.map((f) => f.name);
    expect(names).toEqual([
      "Statistic",
      "Period",
      "EvaluationPeriods",
      "OKActions",
      "InsufficientDataActions",
      "Dimensions",
      "TreatMissingData",
      "DatapointsToAlarm",
    ]);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of cloudWatchAlarmPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  // ── Namespace enum ──
  describe("Namespace enum", () => {
    const field = cloudWatchAlarmPlugin.commonFields.find(
      (f) => f.name === "Namespace",
    )!;

    it("has 6 options including common AWS namespaces and Custom", () => {
      expect(field.question.options).toHaveLength(6);
    });

    it("includes AWS/EC2, AWS/RDS, AWS/Lambda, AWS/SQS, AWS/ApplicationELB", () => {
      const values = field.question.options!.map((o) => o.value);
      expect(values).toContain("AWS/EC2");
      expect(values).toContain("AWS/RDS");
      expect(values).toContain("AWS/Lambda");
      expect(values).toContain("AWS/SQS");
      expect(values).toContain("AWS/ApplicationELB");
      expect(values).toContain("Custom");
    });
  });

  // ── Statistic enum ──
  describe("Statistic enum", () => {
    const field = cloudWatchAlarmPlugin.advancedFields.find(
      (f) => f.name === "Statistic",
    )!;

    it("has 5 options", () => {
      expect(field.question.options).toHaveLength(5);
    });

    it("includes Average, Sum, Minimum, Maximum, SampleCount", () => {
      const values = field.question.options!.map((o) => o.value);
      expect(values).toEqual([
        "Average",
        "Sum",
        "Minimum",
        "Maximum",
        "SampleCount",
      ]);
    });

    it("defaults to Average", () => {
      expect(field.question.initialValue).toBe("Average");
    });
  });

  // ── ComparisonOperator enum ──
  describe("ComparisonOperator enum", () => {
    const field = cloudWatchAlarmPlugin.commonFields.find(
      (f) => f.name === "ComparisonOperator",
    )!;

    it("has 4 options", () => {
      expect(field.question.options).toHaveLength(4);
    });

    it("includes all four operators", () => {
      const values = field.question.options!.map((o) => o.value);
      expect(values).toEqual([
        "GreaterThanThreshold",
        "GreaterThanOrEqualToThreshold",
        "LessThanThreshold",
        "LessThanOrEqualToThreshold",
      ]);
    });

    it("defaults to GreaterThanThreshold", () => {
      expect(field.question.initialValue).toBe("GreaterThanThreshold");
    });
  });

  // ── TreatMissingData enum ──
  describe("TreatMissingData enum", () => {
    const field = cloudWatchAlarmPlugin.advancedFields.find(
      (f) => f.name === "TreatMissingData",
    )!;

    it("has 4 options", () => {
      expect(field.question.options).toHaveLength(4);
    });

    it("includes missing, breaching, notBreaching, ignore", () => {
      const values = field.question.options!.map((o) => o.value);
      expect(values).toEqual([
        "missing",
        "breaching",
        "notBreaching",
        "ignore",
      ]);
    });

    it("defaults to missing", () => {
      expect(field.question.initialValue).toBe("missing");
    });
  });

  // ── Defaults ──
  describe("defaults", () => {
    it("sets Statistic to Average", () => {
      expect(cloudWatchAlarmPlugin.defaults["Statistic"]).toBe("Average");
    });

    it("sets Period to 300", () => {
      expect(cloudWatchAlarmPlugin.defaults["Period"]).toBe("300");
    });

    it("sets EvaluationPeriods to 3", () => {
      expect(cloudWatchAlarmPlugin.defaults["EvaluationPeriods"]).toBe("3");
    });

    it("sets TreatMissingData to missing", () => {
      expect(cloudWatchAlarmPlugin.defaults["TreatMissingData"]).toBe(
        "missing",
      );
    });
  });

  // ── AlarmName validation ──
  describe("AlarmName validation", () => {
    const field = cloudWatchAlarmPlugin.commonFields.find(
      (f) => f.name === "AlarmName",
    )!;

    it("is required", () => {
      expect(field.required).toBe(true);
    });

    it("rejects empty value", () => {
      expect(field.question.validate?.("")).toBeDefined();
    });

    it("accepts valid alarm name", () => {
      expect(field.question.validate?.("my-cpu-alarm")).toBeUndefined();
    });

    it("rejects names longer than 255 chars", () => {
      expect(field.question.validate?.("a".repeat(256))).toBeDefined();
    });
  });

  // ── MetricName validation ──
  describe("MetricName validation", () => {
    const field = cloudWatchAlarmPlugin.commonFields.find(
      (f) => f.name === "MetricName",
    )!;

    it("is required", () => {
      expect(field.required).toBe(true);
    });

    it("rejects empty value", () => {
      expect(field.question.validate?.("")).toBeDefined();
    });

    it("accepts valid metric name", () => {
      expect(field.question.validate?.("CPUUtilization")).toBeUndefined();
    });
  });

  // ── Threshold validation ──
  describe("Threshold validation", () => {
    const field = cloudWatchAlarmPlugin.commonFields.find(
      (f) => f.name === "Threshold",
    )!;

    it("is required", () => {
      expect(field.required).toBe(true);
    });

    it("rejects empty value", () => {
      expect(field.question.validate?.("")).toBeDefined();
    });

    it("rejects non-numeric value", () => {
      expect(field.question.validate?.("abc")).toBeDefined();
    });

    it("accepts numeric value", () => {
      expect(field.question.validate?.("80")).toBeUndefined();
    });

    it("accepts zero", () => {
      expect(field.question.validate?.("0")).toBeUndefined();
    });

    it("accepts negative values (valid for some metrics)", () => {
      expect(field.question.validate?.("-5")).toBeUndefined();
    });
  });

  // ── AlarmActions validation ──
  describe("AlarmActions validation", () => {
    const field = cloudWatchAlarmPlugin.commonFields.find(
      (f) => f.name === "AlarmActions",
    )!;

    it("accepts empty value", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid SNS ARN", () => {
      expect(
        field.question.validate?.(
          "arn:aws:sns:us-east-1:123456789012:my-topic",
        ),
      ).toBeUndefined();
    });

    it("rejects invalid ARN", () => {
      expect(field.question.validate?.("not-an-arn")).toBeDefined();
    });
  });

  // ── Period validation ──
  describe("Period validation", () => {
    const field = cloudWatchAlarmPlugin.advancedFields.find(
      (f) => f.name === "Period",
    )!;

    it("defaults to 300", () => {
      expect(field.question.initialValue).toBe("300");
    });

    it("rejects non-integer", () => {
      expect(field.question.validate?.("abc")).toBeDefined();
    });

    it("rejects period less than 10", () => {
      expect(field.question.validate?.("5")).toBeDefined();
    });

    it("accepts 60", () => {
      expect(field.question.validate?.("60")).toBeUndefined();
    });
  });

  // ── EvaluationPeriods validation ──
  describe("EvaluationPeriods validation", () => {
    const field = cloudWatchAlarmPlugin.advancedFields.find(
      (f) => f.name === "EvaluationPeriods",
    )!;

    it("defaults to 3", () => {
      expect(field.question.initialValue).toBe("3");
    });

    it("rejects non-integer", () => {
      expect(field.question.validate?.("abc")).toBeDefined();
    });

    it("accepts 1", () => {
      expect(field.question.validate?.("1")).toBeUndefined();
    });
  });

  // ── Dimensions validation ──
  describe("Dimensions validation", () => {
    const field = cloudWatchAlarmPlugin.advancedFields.find(
      (f) => f.name === "Dimensions",
    )!;

    it("accepts empty value", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid JSON array", () => {
      expect(
        field.question.validate?.('[{"Name":"InstanceId","Value":"i-123"}]'),
      ).toBeUndefined();
    });

    it("rejects invalid JSON", () => {
      expect(field.question.validate?.("not json")).toBeDefined();
    });

    it("rejects non-array JSON", () => {
      expect(field.question.validate?.('{"Name":"InstanceId"}')).toBeDefined();
    });

    it("rejects dimension missing Name", () => {
      expect(field.question.validate?.('[{"Value":"i-123"}]')).toBeDefined();
    });
  });

  // ── configHints ──
  describe("configHints", () => {
    it("has configHints defined", () => {
      expect(cloudWatchAlarmPlugin.configHints).toBeDefined();
      expect(cloudWatchAlarmPlugin.configHints!.length).toBeGreaterThan(0);
    });

    it("includes SQS DLQ pattern", () => {
      const hints = cloudWatchAlarmPlugin.configHints!;
      expect(hints.some((h) => h.includes("SQS") && h.includes("DLQ"))).toBe(
        true,
      );
    });

    it("includes Lambda error pattern", () => {
      const hints = cloudWatchAlarmPlugin.configHints!;
      expect(
        hints.some((h) => h.includes("Lambda") && h.includes("Errors")),
      ).toBe(true);
    });

    it("includes RDS CPU pattern", () => {
      const hints = cloudWatchAlarmPlugin.configHints!;
      expect(
        hints.some((h) => h.includes("RDS") && h.includes("CPUUtilization")),
      ).toBe(true);
    });

    it("includes ALB latency pattern", () => {
      const hints = cloudWatchAlarmPlugin.configHints!;
      expect(
        hints.some(
          (h) => h.includes("ALB") && h.includes("TargetResponseTime"),
        ),
      ).toBe(true);
    });

    it("includes Period/EvaluationPeriods relationship", () => {
      const hints = cloudWatchAlarmPlugin.configHints!;
      expect(
        hints.some(
          (h) => h.includes("Period") && h.includes("EvaluationPeriods"),
        ),
      ).toBe(true);
    });
  });
});
