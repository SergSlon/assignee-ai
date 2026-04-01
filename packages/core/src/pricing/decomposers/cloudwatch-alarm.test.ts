import { describe, it, expect } from "vitest";
import { cloudWatchAlarmPricingDecomposer } from "./cloudwatch-alarm.js";

describe("cloudWatchAlarmPricingDecomposer", () => {
  it("has resourceType AWS::CloudWatch::Alarm", () => {
    expect(cloudWatchAlarmPricingDecomposer.resourceType).toBe(
      "AWS::CloudWatch::Alarm",
    );
  });

  it("default (no Period) returns 1 Standard alarm item", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({});
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Alarm");
    const alarmTypeFilter = items[0]!.filters.find(
      (f) => f.Field === "alarmType",
    );
    expect(alarmTypeFilter?.Value).toBe("Standard");
  });

  it("Period: 300 returns Standard alarm", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({ Period: 300 });
    const alarmTypeFilter = items[0]!.filters.find(
      (f) => f.Field === "alarmType",
    );
    expect(alarmTypeFilter?.Value).toBe("Standard");
  });

  it("Period: 10 returns High Resolution alarm", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({ Period: 10 });
    const alarmTypeFilter = items[0]!.filters.find(
      (f) => f.Field === "alarmType",
    );
    expect(alarmTypeFilter?.Value).toBe("High Resolution");
  });

  it("Period: 60 returns Standard (boundary)", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({ Period: 60 });
    const alarmTypeFilter = items[0]!.filters.find(
      (f) => f.Field === "alarmType",
    );
    expect(alarmTypeFilter?.Value).toBe("Standard");
  });

  it("Period: 59 returns High Resolution (boundary)", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({ Period: 59 });
    const alarmTypeFilter = items[0]!.filters.find(
      (f) => f.Field === "alarmType",
    );
    expect(alarmTypeFilter?.Value).toBe("High Resolution");
  });

  it("alarm is fixed with quantity 1", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({});
    expect(items[0]!.kind).toBe("fixed");
    expect(items[0]!.quantity).toBe(1);
  });

  it("all filters use TERM_MATCH", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({});
    for (const item of items) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("empty desiredState {} works", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({});
    expect(items).toHaveLength(1);
  });

  it("Period: 0 should NOT be high-res (Standard)", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({ Period: 0 });
    const alarmTypeFilter = items[0]!.filters.find(
      (f) => f.Field === "alarmType",
    );
    expect(alarmTypeFilter?.Value).toBe("Standard");
  });

  it("Period: null defaults to Standard (300)", () => {
    const items = cloudWatchAlarmPricingDecomposer.decompose({ Period: null });
    const alarmTypeFilter = items[0]!.filters.find(
      (f) => f.Field === "alarmType",
    );
    expect(alarmTypeFilter?.Value).toBe("Standard");
  });
});
