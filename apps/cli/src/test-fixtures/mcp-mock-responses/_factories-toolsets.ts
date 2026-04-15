// AUTO-GENERATED — split from monolith mcp-mock-responses.ts (story 48-10).
import type { StructuredTool } from "@langchain/core/tools";
import { vi } from "vitest";
import { ToolName } from "../../constants/tools.js";
import { McpMocks } from "./mcp-mocks-data.js";
import { createMockTool } from "./_factories-basic.js";

export function createIamMockTool(
  response = McpMocks.iam.s3BucketAllowed.success,
): StructuredTool {
  return createMockTool(ToolName.SIMULATE_PRINCIPAL_POLICY, response);
}

export function createSecurityMockTool(
  response = McpMocks.security.noFindings.success,
): StructuredTool {
  return createMockTool(ToolName.GET_SECURITY_FINDINGS, response);
}

export function createBillingMockTool(
  response = McpMocks.billing.s3BucketCost.success,
): StructuredTool {
  return createMockTool(ToolName.COST_EXPLORER, response);
}

export function createAllMockTools(): StructuredTool[] {
  return [
    createMockTool(ToolName.GET_PRICING, McpMocks.pricing.s3Storage.success),
    createMockTool(
      ToolName.SEARCH_DOCUMENTATION,
      McpMocks.docSearch.s3BucketName.success,
    ),
    createMockTool(
      ToolName.READ_SECTIONS,
      McpMocks.docReadSections.s3BucketName.success,
    ),
    createMockTool(
      ToolName.READ_DOCUMENTATION,
      McpMocks.docReadFull.s3BucketFull.success,
    ),
    createMockTool(
      ToolName.SIMULATE_PRINCIPAL_POLICY,
      McpMocks.iam.s3BucketAllowed.success,
    ),
    createMockTool(
      ToolName.GET_SECURITY_FINDINGS,
      McpMocks.security.noFindings.success,
    ),
    createMockTool(
      ToolName.COST_EXPLORER,
      McpMocks.billing.s3BucketCost.success,
    ),
  ];
}

export function createPricingMockTools(
  pricingResponse = McpMocks.pricing.s3Storage.success,
): StructuredTool[] {
  return [createMockTool(ToolName.GET_PRICING, pricingResponse)];
}

/**
 * @deprecated Use createPricingMockTools() instead.
 */
export function createCoreMockTools(
  _schemaResponse?: unknown,
  pricingResponse = McpMocks.pricing.s3Storage.success,
): StructuredTool[] {
  return [createMockTool(ToolName.GET_PRICING, pricingResponse)];
}

export function createDocMockTools(
  searchResponse: unknown = McpMocks.docSearch.s3BucketName.success,
  readSectionsResponse: unknown = McpMocks.docReadSections.s3BucketName.success,
  readFullResponse: unknown = McpMocks.docReadFull.s3BucketFull.success,
): StructuredTool[] {
  return [
    createMockTool(ToolName.SEARCH_DOCUMENTATION, searchResponse),
    createMockTool(ToolName.READ_SECTIONS, readSectionsResponse),
    createMockTool(ToolName.READ_DOCUMENTATION, readFullResponse),
  ];
}

export function createPricingLookupTool(
  priceMap: Record<string, unknown>,
): StructuredTool {
  return {
    name: ToolName.GET_PRICING,
    description: "",
    invoke: vi.fn(
      async (args: { filters?: Array<{ Field: string; Value: string }> }) => {
        const instanceFilter = args.filters?.find(
          (f) => f.Field === "instanceType",
        );
        if (instanceFilter && instanceFilter.Value in priceMap) {
          return priceMap[instanceFilter.Value];
        }
        return McpMocks.pricing.emptyData.success;
      },
    ),
  } as unknown as StructuredTool;
}
