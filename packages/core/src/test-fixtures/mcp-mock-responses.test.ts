import { describe, it, expect } from "vitest";
import {
  McpMocks,
  createServicePricingDispatchTool,
  createS3PricingDispatchTool,
} from "./mcp-mock-responses.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFilters(
  ...pairs: Array<[string, string]>
): Array<{ Field: string; Value: string }> {
  return pairs.map(([Field, Value]) => ({ Field, Value }));
}

// ── createServicePricingDispatchTool ─────────────────────────────────────────

describe("createServicePricingDispatchTool", () => {
  it("matches a single-condition dispatch key", async () => {
    const tool = createServicePricingDispatchTool({
      "productFamily=Storage": McpMocks.pricing.s3Storage.success,
    });

    const result = await tool.invoke({
      service_code: "AmazonS3",
      filters: makeFilters(["productFamily", "Storage"]),
    });

    expect(result).toBe(McpMocks.pricing.s3Storage.success);
  });

  it("matches a multi-condition dispatch key", async () => {
    const tool = createServicePricingDispatchTool({
      "productFamily=Storage+usagetype=TimedStorage-ByteHrs":
        McpMocks.pricing.s3Storage.success,
    });

    const result = await tool.invoke({
      service_code: "AmazonS3",
      filters: makeFilters(
        ["productFamily", "Storage"],
        ["usagetype", "TimedStorage-ByteHrs"],
      ),
    });

    expect(result).toBe(McpMocks.pricing.s3Storage.success);
  });

  it("returns emptyData when no dispatch key matches", async () => {
    const tool = createServicePricingDispatchTool({
      "productFamily=Storage": McpMocks.pricing.s3Storage.success,
    });

    const result = await tool.invoke({
      service_code: "AmazonS3",
      filters: makeFilters(["productFamily", "Nonexistent"]),
    });

    expect(result).toBe(McpMocks.pricing.emptyData.success);
  });

  it("returns emptyData when filters are empty", async () => {
    const tool = createServicePricingDispatchTool({
      "productFamily=Storage": McpMocks.pricing.s3Storage.success,
    });

    const result = await tool.invoke({
      service_code: "AmazonS3",
      filters: [],
    });

    expect(result).toBe(McpMocks.pricing.emptyData.success);
  });

  it("returns emptyData when filters are undefined", async () => {
    const tool = createServicePricingDispatchTool({
      "productFamily=Storage": McpMocks.pricing.s3Storage.success,
    });

    const result = await tool.invoke({ service_code: "AmazonS3" });

    expect(result).toBe(McpMocks.pricing.emptyData.success);
  });

  it("uses first-match-wins when multiple keys could match", async () => {
    const tool = createServicePricingDispatchTool({
      "productFamily=API Request": McpMocks.pricing.s3PutRequests.success,
      "productFamily=API Request+usagetype=Requests-Tier2":
        McpMocks.pricing.s3GetRequests.success,
    });

    // Both keys match, but the first entry should win
    const result = await tool.invoke({
      filters: makeFilters(
        ["productFamily", "API Request"],
        ["usagetype", "Requests-Tier2"],
      ),
    });

    expect(result).toBe(McpMocks.pricing.s3PutRequests.success);
  });

  it("matches when extra filters are present beyond dispatch key conditions", async () => {
    const tool = createServicePricingDispatchTool({
      "productFamily=Storage": McpMocks.pricing.s3Storage.success,
    });

    const result = await tool.invoke({
      filters: makeFilters(
        ["productFamily", "Storage"],
        ["usagetype", "TimedStorage-ByteHrs"],
        ["regionCode", "us-east-1"],
      ),
    });

    expect(result).toBe(McpMocks.pricing.s3Storage.success);
  });
});

// ── createS3PricingDispatchTool ──────────────────────────────────────────────

describe("createS3PricingDispatchTool", () => {
  it("returns s3Storage for Storage + TimedStorage-ByteHrs", async () => {
    const tool = createS3PricingDispatchTool();

    const result = await tool.invoke({
      service_code: "AmazonS3",
      filters: makeFilters(
        ["productFamily", "Storage"],
        ["usagetype", "TimedStorage-ByteHrs"],
      ),
    });

    expect(result).toBe(McpMocks.pricing.s3Storage.success);
  });

  it("returns s3PutRequests for API Request + group=S3-API-Tier1", async () => {
    const tool = createS3PricingDispatchTool();

    const result = await tool.invoke({
      service_code: "AmazonS3",
      filters: makeFilters(
        ["productFamily", "API Request"],
        ["group", "S3-API-Tier1"],
      ),
    });

    expect(result).toBe(McpMocks.pricing.s3PutRequests.success);
  });

  it("returns s3GetRequests for API Request + group=S3-API-Tier2", async () => {
    const tool = createS3PricingDispatchTool();

    const result = await tool.invoke({
      service_code: "AmazonS3",
      filters: makeFilters(
        ["productFamily", "API Request"],
        ["group", "S3-API-Tier2"],
      ),
    });

    expect(result).toBe(McpMocks.pricing.s3GetRequests.success);
  });

  it("returns s3DataTransfer for Data Transfer", async () => {
    const tool = createS3PricingDispatchTool();

    const result = await tool.invoke({
      service_code: "AWSDataTransfer",
      filters: makeFilters(["productFamily", "Data Transfer"]),
    });

    expect(result).toBe(McpMocks.pricing.s3DataTransfer.success);
  });

  it("returns emptyData for unknown filter combination", async () => {
    const tool = createS3PricingDispatchTool();

    const result = await tool.invoke({
      service_code: "AmazonS3",
      filters: makeFilters(["productFamily", "SomethingUnknown"]),
    });

    expect(result).toBe(McpMocks.pricing.emptyData.success);
  });

  it("s3DataTransfer response has correct service and price", () => {
    const raw = JSON.parse(
      (McpMocks.pricing.s3DataTransfer.success as { text: string }).text,
    );
    expect(raw.service_name).toBe("AWSDataTransfer");
    expect(raw.data[0].product.productFamily).toBe("Data Transfer");
    const dims =
      raw.data[0].terms.OnDemand["DTOUTSKU00000001.JRTCKXETXF"].priceDimensions;
    const priceKey = Object.keys(dims)[0]!;
    expect(dims[priceKey]!.pricePerUnit.USD).toBe("0.0900000000");
  });
});
