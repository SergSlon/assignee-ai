import { describe, it, expect } from "vitest";
import { logsPricingDecomposer } from "./logs.js";

describe("logsPricingDecomposer", () => {
  it("has resourceType AWS::Logs::LogGroup", () => {
    expect(logsPricingDecomposer.resourceType).toBe("AWS::Logs::LogGroup");
  });

  // Epic 92 u.e (D-14): the correct AWS Pricing API usagetypes are
  // `DataProcessing-Bytes` (ingestion) and `TimedStorage-ByteHrs`
  // (storage) — no `CW:` prefix, `ByteHrs` not `Bytes` for storage.
  // The old values produced zero matches in every region and every
  // Logs plan showed "unavailable".
  it("default returns 2 STANDARD items (ingestion + storage)", () => {
    const items = logsPricingDecomposer.decompose({});
    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("Log ingestion");
    expect(items[1]!.label).toBe("Log storage");
    const ingestionUsage = items[0]!.filters.find(
      (f) => f.Field === "usagetype",
    );
    expect(ingestionUsage?.Value).toBe("DataProcessing-Bytes");
    const storageUsage = items[1]!.filters.find((f) => f.Field === "usagetype");
    expect(storageUsage?.Value).toBe("TimedStorage-ByteHrs");
  });

  it('LogGroupClass: "STANDARD" returns same as default', () => {
    const items = logsPricingDecomposer.decompose({
      LogGroupClass: "STANDARD",
    });
    expect(items).toHaveLength(2);
    const ingestionUsage = items[0]!.filters.find(
      (f) => f.Field === "usagetype",
    );
    expect(ingestionUsage?.Value).toBe("DataProcessing-Bytes");
    const storageUsage = items[1]!.filters.find((f) => f.Field === "usagetype");
    expect(storageUsage?.Value).toBe("TimedStorage-ByteHrs");
  });

  it('LogGroupClass: "INFREQUENT_ACCESS" returns 2 items with infrequent access usagetypes', () => {
    const items = logsPricingDecomposer.decompose({
      LogGroupClass: "INFREQUENT_ACCESS",
    });
    expect(items).toHaveLength(2);
    const ingestionUsage = items[0]!.filters.find(
      (f) => f.Field === "usagetype",
    );
    expect(ingestionUsage?.Value).toBe(
      "LogInfrequentAccess-DataProcessing-Bytes",
    );
    const storageUsage = items[1]!.filters.find((f) => f.Field === "usagetype");
    expect(storageUsage?.Value).toBe(
      "LogInfrequentAccess-TimedStorage-ByteHrs",
    );
  });

  // Regression guard: neither the ingestion nor the storage usagetype
  // may ever carry the legacy `CW:` prefix (D-14). The old prefix
  // returned zero matches on the AWS Pricing API.
  it("D-14 regression: no filter carries the legacy CW: prefix", () => {
    for (const lgc of ["STANDARD", "INFREQUENT_ACCESS"]) {
      const items = logsPricingDecomposer.decompose({ LogGroupClass: lgc });
      for (const item of items) {
        const usagetypeFilter = item.filters.find(
          (f) => f.Field === "usagetype",
        );
        expect(usagetypeFilter).toBeDefined();
        expect(usagetypeFilter!.Value.startsWith("CW:")).toBe(false);
      }
    }
  });

  it("all items are usage_based with quantity 0", () => {
    const items = logsPricingDecomposer.decompose({});
    for (const item of items) {
      expect(item.kind).toBe("usage_based");
      expect(item.quantity).toBe(0);
    }
  });

  it("all items use AmazonCloudWatch serviceCode", () => {
    const items = logsPricingDecomposer.decompose({});
    for (const item of items) {
      expect(item.serviceCode).toBe("AmazonCloudWatch");
    }
  });

  it("all filters use TERM_MATCH", () => {
    const items = logsPricingDecomposer.decompose({});
    for (const item of items) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  it("empty desiredState {} works", () => {
    const items = logsPricingDecomposer.decompose({});
    expect(items).toHaveLength(2);
  });
});
