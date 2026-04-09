/**
 * Tests for Lambda pricing decomposer (Story 23.3).
 * Verifies line item generation for requests, duration, and CloudWatch Logs.
 */

import { describe, it, expect } from "vitest";
import { lambdaPricingDecomposer } from "./lambda.js";

describe("lambdaPricingDecomposer", () => {
  it("has correct resourceType", () => {
    expect(lambdaPricingDecomposer.resourceType).toBe("AWS::Lambda::Function");
  });

  it("returns 3 usage-based line items for minimal desiredState", () => {
    const items = lambdaPricingDecomposer.decompose({});

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.label)).toEqual([
      "Requests",
      "Duration",
      "CloudWatch Logs",
    ]);
  });

  it("all items are usage_based with quantity 0", () => {
    const items = lambdaPricingDecomposer.decompose({});

    for (const item of items) {
      expect(item.kind).toBe("usage_based");
      expect(item.quantity).toBe(0);
    }
  });

  it("requests line item has correct filters and scale", () => {
    const items = lambdaPricingDecomposer.decompose({});
    const requests = items.find((i) => i.label === "Requests")!;

    expect(requests.serviceCode).toBe("AWSLambda");
    expect(requests.unit).toBe("requests");
    expect(requests.priceUnit).toBe("/M reqs");
    expect(requests.description).toBe("per million");
    expect(requests.scale).toBe(1_000_000);
    expect(requests.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "Serverless",
        }),
        expect.objectContaining({ Field: "usagetype", Value: "Request" }),
      ]),
    );
  });

  it("duration line item defaults to 128 MB description", () => {
    const items = lambdaPricingDecomposer.decompose({});
    const duration = items.find((i) => i.label === "Duration")!;

    expect(duration.serviceCode).toBe("AWSLambda");
    expect(duration.unit).toBe("GB-second");
    expect(duration.priceUnit).toBe("/GB-s");
    expect(duration.description).toBe("128 MB, 100ms avg");
    expect(duration.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "Serverless",
        }),
        expect.objectContaining({
          Field: "usagetype",
          Value: "Lambda-GB-Second",
        }),
      ]),
    );
  });

  it("duration description uses specified MemorySize", () => {
    const items = lambdaPricingDecomposer.decompose({
      MemorySize: 512,
    });
    const duration = items.find((i) => i.label === "Duration")!;

    expect(duration.description).toBe("512 MB, 100ms avg");
  });

  it("duration description uses large MemorySize", () => {
    const items = lambdaPricingDecomposer.decompose({
      MemorySize: 3008,
    });
    const duration = items.find((i) => i.label === "Duration")!;

    expect(duration.description).toBe("3008 MB, 100ms avg");
  });

  it("CloudWatch Logs line item has correct filters", () => {
    const items = lambdaPricingDecomposer.decompose({});
    const cw = items.find((i) => i.label === "CloudWatch Logs")!;

    expect(cw.serviceCode).toBe("AmazonCloudWatch");
    expect(cw.unit).toBe("GB");
    expect(cw.priceUnit).toBe("/GB ingested");
    expect(cw.description).toBe("ingested");
    expect(cw.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "Data Payload",
        }),
        expect.objectContaining({
          Field: "usagetype",
          Value: "DataProcessing-Bytes",
        }),
      ]),
    );
  });

  it("returns same line item count regardless of other desiredState props", () => {
    const minimal = lambdaPricingDecomposer.decompose({});
    const full = lambdaPricingDecomposer.decompose({
      FunctionName: "my-fn",
      Runtime: "nodejs22.x",
      Role: "arn:aws:iam::123456789012:role/lambda-exec",
      MemorySize: 1024,
      Timeout: 30,
      Code: { ZipFile: "exports.handler=async()=>({})" },
    });

    expect(minimal).toHaveLength(3);
    expect(full).toHaveLength(3);
  });

  it("all filters use TERM_MATCH type", () => {
    const items = lambdaPricingDecomposer.decompose({});
    for (const item of items) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });

  // (f) 2026-04-09 — provisioned concurrency conditional line item.
  describe("provisioned concurrency", () => {
    it("adds a FIXED PC line when ProvisionedConcurrencyConfig.ProvisionedConcurrentExecutions > 0", () => {
      const items = lambdaPricingDecomposer.decompose({
        MemorySize: 1024,
        ProvisionedConcurrencyConfig: {
          ProvisionedConcurrentExecutions: 5,
        },
      });
      expect(items).toHaveLength(4);
      const pc = items.find((i) => i.label === "Provisioned concurrency")!;
      expect(pc.kind).toBe("fixed");
      // 5 warm instances × (1024 / 1024) = 5 GB-seconds committed
      expect(pc.quantity).toBe(5);
      expect(pc.unit).toBe("GB-second");
      expect(pc.priceUnit).toBe("/GB-s");
      expect(pc.serviceCode).toBe("AWSLambda");
      expect(pc.description).toContain("5 warm instances");
      expect(pc.description).toContain("1024 MB");
      expect(pc.description).toContain("committed");
      expect(pc.description).toContain("24/7");
      expect(pc.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Field: "productFamily",
            Value: "Serverless",
          }),
          expect.objectContaining({
            Field: "usagetype",
            Value: "Lambda-Provisioned-Concurrency-GB-Second",
          }),
        ]),
      );
    });

    it("uses singular 'instance' for a single warm executor", () => {
      const items = lambdaPricingDecomposer.decompose({
        MemorySize: 512,
        ProvisionedConcurrencyConfig: {
          ProvisionedConcurrentExecutions: 1,
        },
      });
      const pc = items.find((i) => i.label === "Provisioned concurrency")!;
      expect(pc.description).toContain("1 warm instance ");
      // 1 × 512/1024 = 0.5 GB committed
      expect(pc.quantity).toBe(0.5);
    });

    it("does NOT add a PC line when ProvisionedConcurrencyConfig is absent", () => {
      const items = lambdaPricingDecomposer.decompose({
        MemorySize: 512,
      });
      expect(items).toHaveLength(3);
      expect(
        items.find((i) => i.label === "Provisioned concurrency"),
      ).toBeUndefined();
    });

    it("does NOT add a PC line when ProvisionedConcurrentExecutions is 0", () => {
      const items = lambdaPricingDecomposer.decompose({
        MemorySize: 512,
        ProvisionedConcurrencyConfig: {
          ProvisionedConcurrentExecutions: 0,
        },
      });
      expect(items).toHaveLength(3);
    });

    it("does NOT add a PC line when ProvisionedConcurrentExecutions is missing from the config", () => {
      const items = lambdaPricingDecomposer.decompose({
        MemorySize: 512,
        ProvisionedConcurrencyConfig: {},
      });
      expect(items).toHaveLength(3);
    });
  });
});
