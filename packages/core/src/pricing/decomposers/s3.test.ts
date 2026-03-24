/**
 * Tests for S3 pricing decomposer (Story 23.3).
 * Verifies line item generation for storage, PUT/GET requests, and data transfer.
 */

import { describe, it, expect } from "vitest";
import { s3PricingDecomposer } from "./s3.js";

describe("s3PricingDecomposer", () => {
  it("has correct resourceType", () => {
    expect(s3PricingDecomposer.resourceType).toBe("AWS::S3::Bucket");
  });

  it("returns all 4 usage-based line items for any desiredState", () => {
    const items = s3PricingDecomposer.decompose({
      BucketName: "my-test-bucket",
    });

    expect(items).toHaveLength(4);
    expect(items.map((i) => i.label)).toEqual([
      "Storage",
      "PUT requests",
      "GET requests",
      "Data transfer out",
    ]);
  });

  it("all items are usage_based with quantity 0", () => {
    const items = s3PricingDecomposer.decompose({});

    for (const item of items) {
      expect(item.kind).toBe("usage_based");
      expect(item.quantity).toBe(0);
    }
  });

  it("storage line item has correct filters", () => {
    const items = s3PricingDecomposer.decompose({});
    const storage = items.find((i) => i.label === "Storage")!;

    expect(storage.serviceCode).toBe("AmazonS3");
    expect(storage.unit).toBe("GB");
    expect(storage.priceUnit).toBe("/GB-mo");
    expect(storage.description).toBe("Standard");
    expect(storage.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Field: "productFamily", Value: "Storage" }),
        expect.objectContaining({
          Field: "usagetype",
          Value: "TimedStorage-ByteHrs",
        }),
      ]),
    );
  });

  it("PUT requests line item has Requests-Tier1 usagetype filter", () => {
    const items = s3PricingDecomposer.decompose({});
    const put = items.find((i) => i.label === "PUT requests")!;

    expect(put.serviceCode).toBe("AmazonS3");
    expect(put.unit).toBe("requests");
    expect(put.priceUnit).toBe("/1000 reqs");
    expect(put.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "API Request",
        }),
        expect.objectContaining({
          Field: "usagetype",
          Value: "Requests-Tier1",
        }),
      ]),
    );
  });

  it("GET requests line item has Requests-Tier2 usagetype filter", () => {
    const items = s3PricingDecomposer.decompose({});
    const get = items.find((i) => i.label === "GET requests")!;

    expect(get.serviceCode).toBe("AmazonS3");
    expect(get.unit).toBe("requests");
    expect(get.priceUnit).toBe("/1000 reqs");
    expect(get.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "API Request",
        }),
        expect.objectContaining({
          Field: "usagetype",
          Value: "Requests-Tier2",
        }),
      ]),
    );
  });

  it("data transfer out line item uses AWSDataTransfer service code", () => {
    const items = s3PricingDecomposer.decompose({});
    const dt = items.find((i) => i.label === "Data transfer out")!;

    expect(dt.serviceCode).toBe("AWSDataTransfer");
    expect(dt.unit).toBe("GB");
    expect(dt.priceUnit).toBe("/GB");
    expect(dt.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "Data Transfer",
        }),
        expect.objectContaining({
          Field: "transferType",
          Value: "AWS Outbound",
        }),
      ]),
    );
  });

  it("returns same line items regardless of desiredState contents", () => {
    const minimal = s3PricingDecomposer.decompose({});
    const full = s3PricingDecomposer.decompose({
      BucketName: "full-bucket",
      VersioningConfiguration: { Status: "Enabled" },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
      },
    });

    expect(minimal).toHaveLength(full.length);
    expect(minimal.map((i) => i.label)).toEqual(full.map((i) => i.label));
  });

  it("all filters use TERM_MATCH type", () => {
    const items = s3PricingDecomposer.decompose({});
    for (const item of items) {
      for (const filter of item.filters) {
        expect(filter.Type).toBe("TERM_MATCH");
      }
    }
  });
});
