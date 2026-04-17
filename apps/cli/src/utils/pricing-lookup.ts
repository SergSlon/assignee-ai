/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/utils/pricing-lookup` (Story 50-4 Wave 5 Pass C-2).
 */
export {
  fetchEc2InstancePrices,
  fetchRdsInstancePrices,
  fetchLambdaArchPrices,
  fetchCwLogsStoragePrice,
} from "@assignee/core";
