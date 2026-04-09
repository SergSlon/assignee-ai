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

  it("returns 4 always-on usage-based line items for the default bucket shape", () => {
    // (f) 2026-04-09: the decomposer now also emits conditional
    // line items for IntelligentTieringConfigurations and
    // ReplicationConfiguration. The 4 always-on lines below are
    // the headline ones that fire for any S3 bucket.
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

  it("returns same line items for buckets that don't enable IT or replication", () => {
    // (f) 2026-04-09: this test is now scoped to fields that DON'T
    // toggle the new conditional lines. Adding
    // IntelligentTieringConfigurations or ReplicationConfiguration
    // would correctly extend the line-item list — those cases are
    // covered in the "Intelligent-Tiering" and "Replication" describe
    // blocks below.
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

  describe("Intelligent-Tiering conditional line item (f) 2026-04-09", () => {
    it("does NOT add an IT line when IntelligentTieringConfigurations is absent", () => {
      const items = s3PricingDecomposer.decompose({});
      expect(items).toHaveLength(4);
    });

    it("does NOT add an IT line when IntelligentTieringConfigurations is empty array", () => {
      const items = s3PricingDecomposer.decompose({
        IntelligentTieringConfigurations: [],
      });
      expect(items).toHaveLength(4);
    });

    it("adds an IT Frequent Access storage line when at least one IT config is set", () => {
      const items = s3PricingDecomposer.decompose({
        IntelligentTieringConfigurations: [
          { Id: "default-it", Status: "Enabled", Tierings: [] },
        ],
      });
      expect(items).toHaveLength(5);
      const itLine = items.find(
        (i) => i.description === "Intelligent-Tiering (Frequent Access)",
      );
      expect(itLine).toBeDefined();
      expect(itLine!.serviceCode).toBe("AmazonS3");
      expect(itLine!.kind).toBe("usage_based");
      expect(itLine!.unit).toBe("GB");
      expect(itLine!.priceUnit).toBe("/GB-mo");
    });

    it("uses the IT-FA-ByteHrs Pricing API usage type", () => {
      const items = s3PricingDecomposer.decompose({
        IntelligentTieringConfigurations: [{ Id: "x" }],
      });
      const itLine = items.find(
        (i) => i.description === "Intelligent-Tiering (Frequent Access)",
      )!;
      expect(itLine.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Field: "usagetype",
            Value: "TimedStorage-INT-FA-ByteHrs",
          }),
        ]),
      );
    });

    it("ignores non-array IntelligentTieringConfigurations values", () => {
      // Defensive guard: a malformed CFN object that's not an array
      // should NOT crash the decomposer or trigger the line item.
      expect(
        s3PricingDecomposer.decompose({
          IntelligentTieringConfigurations: "oops",
        }),
      ).toHaveLength(4);
      expect(
        s3PricingDecomposer.decompose({
          IntelligentTieringConfigurations: { Id: "single-not-array" },
        }),
      ).toHaveLength(4);
    });
  });

  describe("Replication conditional line items (f) 2026-04-09", () => {
    it("does NOT add replication lines when ReplicationConfiguration is absent", () => {
      const items = s3PricingDecomposer.decompose({});
      expect(items).toHaveLength(4);
    });

    it("does NOT add replication lines when Rules is empty", () => {
      const items = s3PricingDecomposer.decompose({
        ReplicationConfiguration: { Role: "arn:aws:iam::1:role/r", Rules: [] },
      });
      expect(items).toHaveLength(4);
    });

    it("adds 2 replication lines when at least one Rule is set", () => {
      const items = s3PricingDecomposer.decompose({
        ReplicationConfiguration: {
          Role: "arn:aws:iam::1:role/r",
          Rules: [
            {
              Id: "to-replica-bucket",
              Status: "Enabled",
              Destination: { Bucket: "arn:aws:s3:::replica" },
            },
          ],
        },
      });
      expect(items).toHaveLength(6);

      const replicationLines = items.filter((i) =>
        i.description?.includes("Replication"),
      );
      expect(replicationLines).toHaveLength(2);

      const putLine = replicationLines.find((i) =>
        i.description?.includes("PUT"),
      )!;
      expect(putLine.label).toBe("PUT requests");
      expect(putLine.priceUnit).toBe("/1000 reqs");

      const storageLine = replicationLines.find((i) =>
        i.description?.includes("storage"),
      )!;
      expect(storageLine.label).toBe("Storage");
      expect(storageLine.priceUnit).toBe("/GB-mo");
    });

    it("does NOT crash when ReplicationConfiguration is not an object", () => {
      expect(
        s3PricingDecomposer.decompose({
          ReplicationConfiguration: "oops",
        }),
      ).toHaveLength(4);
      expect(
        s3PricingDecomposer.decompose({
          ReplicationConfiguration: null,
        }),
      ).toHaveLength(4);
      expect(
        s3PricingDecomposer.decompose({
          ReplicationConfiguration: { Rules: "not-an-array" },
        }),
      ).toHaveLength(4);
    });

    it("composes correctly with IntelligentTieringConfigurations (5+1+2 = 7 lines)", () => {
      // Both conditional features at once: 4 always-on + 1 IT + 2
      // replication = 7 line items.
      const items = s3PricingDecomposer.decompose({
        IntelligentTieringConfigurations: [{ Id: "x" }],
        ReplicationConfiguration: {
          Role: "arn:aws:iam::1:role/r",
          Rules: [{ Id: "r1", Status: "Enabled", Destination: {} }],
        },
      });
      expect(items).toHaveLength(7);
    });
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
