// AUTO-GENERATED — split from monolith mcp-mock-responses.ts (story 48-10).
import type { StructuredTool } from "@langchain/core/tools";
import { vi } from "vitest";
import { ToolName } from "../../constants/tools.js";
import { McpMocks } from "./mcp-mocks-data.js";

export function createServicePricingDispatchTool(
  dispatchMap: Record<string, unknown>,
): StructuredTool {
  const parsedEntries = Object.entries(dispatchMap).map(([key, response]) => {
    const conditions = key.split("+").map((pair) => {
      const eqIdx = pair.indexOf("=");
      return { Field: pair.slice(0, eqIdx), Value: pair.slice(eqIdx + 1) };
    });
    return { conditions, response };
  });

  return {
    name: ToolName.GET_PRICING,
    description: "",
    invoke: vi.fn(
      async (args: {
        filters?: Array<{ Field: string; Value: string }>;
        service_code?: string;
      }) => {
        const filters = args.filters ?? [];

        for (const entry of parsedEntries) {
          const allMatch = entry.conditions.every((cond) =>
            filters.some(
              (f) => f.Field === cond.Field && f.Value === cond.Value,
            ),
          );
          if (allMatch) {
            return entry.response;
          }
        }

        return McpMocks.pricing.emptyData.success;
      },
    ),
  } as unknown as StructuredTool;
}

export function createS3PricingDispatchTool(): StructuredTool {
  return createServicePricingDispatchTool({
    "productFamily=Storage+usagetype=TimedStorage-ByteHrs":
      McpMocks.pricing.s3Storage.success,
    "productFamily=API Request+group=S3-API-Tier1":
      McpMocks.pricing.s3PutRequests.success,
    "productFamily=API Request+group=S3-API-Tier2":
      McpMocks.pricing.s3GetRequests.success,
    "productFamily=Data Transfer": McpMocks.pricing.s3DataTransfer.success,
  });
}

export function createEc2PricingDispatchTool(
  instanceType = "t3.micro",
  instanceMock = McpMocks.pricing.ec2T3Micro.success,
): StructuredTool {
  return createServicePricingDispatchTool({
    [`productFamily=Compute Instance+instanceType=${instanceType}`]:
      instanceMock,
    "productFamily=Storage+volumeApiName=gp3":
      McpMocks.pricing.ebsGp3Storage.success,
    "productFamily=IP Address": McpMocks.pricing.publicIpv4.success,
    "productFamily=Data Transfer": McpMocks.pricing.dataTransferOut.success,
  });
}

export function createRdsPricingDispatchTool(
  computeMock = McpMocks.pricing.rdsT3MicroPostgres.success,
): StructuredTool {
  return createServicePricingDispatchTool({
    "productFamily=Database Instance": computeMock,
    "productFamily=Database Storage": McpMocks.pricing.rdsStorageGp3.success,
    "productFamily=Storage Snapshot": McpMocks.pricing.rdsBackupStorage.success,
  });
}
