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

    it("rejects empty value with 'required' error", () => {
      // Tier C: was toBeDefined() — strengthened to lock the user-visible
      // error message so future refactors can't accidentally degrade the
      // wording (e.g. an LLM-driven cleanup pass).
      expect(field.question.validate?.("")).toBe("Alarm name is required");
    });

    it("accepts valid alarm name", () => {
      expect(field.question.validate?.("my-cpu-alarm")).toBeUndefined();
    });

    it("rejects names longer than 255 chars with length error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("a".repeat(256))).toBe(
        "Alarm name must be 255 characters or fewer",
      );
    });

    it("accepts exactly 255 chars (boundary)", () => {
      // Tier C: new boundary test — Wave 14 found bugs in untested
      // boundary conditions.
      expect(field.question.validate?.("a".repeat(255))).toBeUndefined();
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

    it("rejects empty value with 'required' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("")).toBe("Metric name is required");
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

    it("rejects empty value with 'required' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("")).toBe("Threshold is required");
    });

    it("rejects non-numeric value with 'must be a number' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("abc")).toBe(
        "Threshold must be a number",
      );
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

    it("rejects invalid ARN with the offending value in the error", () => {
      // Tier C: strengthened from toBeDefined() — assert the error names
      // the bad value so users can find it in long ARN lists.
      const result = field.question.validate?.("not-an-arn");
      expect(result).toBe(
        "Invalid SNS topic ARN: not-an-arn. Must start with arn:aws:sns:",
      );
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

    it("rejects non-integer with positive-integer error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("abc")).toBe(
        "Period must be a positive integer (seconds)",
      );
    });

    it("rejects period less than 10 with minimum-period error", () => {
      // Tier C: strengthened from toBeDefined() — distinguishing from
      // the "not an integer" case is important because the user fix is
      // different (raise the value vs. use a number at all).
      expect(field.question.validate?.("5")).toBe(
        "Minimum period is 10 seconds",
      );
    });

    it("accepts 60", () => {
      expect(field.question.validate?.("60")).toBeUndefined();
    });

    it("accepts 10 (boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("10")).toBeUndefined();
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

    it("rejects non-integer with positive-integer error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("abc")).toBe(
        "Evaluation periods must be a positive integer",
      );
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

    it("rejects invalid JSON with 'Invalid JSON format' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("not json")).toBe("Invalid JSON format");
    });

    it("rejects non-array JSON with 'must be a JSON array' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.('{"Name":"InstanceId"}')).toBe(
        "Dimensions must be a JSON array",
      );
    });

    it("rejects dimension missing Name with shape error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.('[{"Value":"i-123"}]')).toBe(
        "Each dimension must have Name and Value",
      );
    });

    it("rejects dimension missing Value with shape error", () => {
      // Tier C: new symmetric case — Wave 14 lesson is to test BOTH
      // sides of a "must have X and Y" shape check.
      expect(field.question.validate?.('[{"Name":"InstanceId"}]')).toBe(
        "Each dimension must have Name and Value",
      );
    });
  });

  // ── configHints ──
  describe("configHints", () => {
    it("has at least 5 configHints (Tier C: was toBeDefined+>0)", () => {
      // Tier C: strengthened — assert a meaningful floor on count instead
      // of just "exists and >0". The plugin currently has 6 hints; if a
      // future change deletes most of them the LLM will have less
      // guidance and start hallucinating. 5 is the floor we want to
      // enforce.
      expect(cloudWatchAlarmPlugin.configHints).toBeInstanceOf(Array);
      expect(cloudWatchAlarmPlugin.configHints!.length).toBeGreaterThanOrEqual(
        5,
      );
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
