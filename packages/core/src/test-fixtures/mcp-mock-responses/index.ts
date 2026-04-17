// AUTO-GENERATED barrel (story 48-10). Re-exports the original public surface
// of mcp-mock-responses.ts: McpMocks, RawSchemas, RawSchemasByType, and all
// factory + builder functions.
export { McpMocks, RawSchemas, RawSchemasByType } from "./mcp-mocks-data.js";

export {
  createMockTool,
  createFailingMockTool,
  createHangingMockTool,
  createDelayedMockTool,
  createNullMockTool,
  createSequenceMockTool,
} from "./_factories-basic.js";

export {
  createIamMockTool,
  createSecurityMockTool,
  createBillingMockTool,
  createAllMockTools,
  createPricingMockTools,
  createCoreMockTools,
  createDocMockTools,
  createPricingLookupTool,
} from "./_factories-toolsets.js";

export {
  createServicePricingDispatchTool,
  createS3PricingDispatchTool,
  createEc2PricingDispatchTool,
  createRdsPricingDispatchTool,
} from "./_factories-pricing-dispatch.js";

export {
  buildPricingResponse,
  buildMultiTierPricingResponse,
  buildSchemaResponse,
  buildDocSearchResponse,
  buildDocReadResponse,
} from "./_builders.js";
