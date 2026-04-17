/**
 * Live pricing lookup utilities for the option-elicitor node.
 *
 * Wave 6d F5: barrel after decomposition into ./pricing-lookup/*:
 *   - query.ts    — shared MCP invoke + cache + extractor
 *   - ec2.ts      — fetchEc2InstancePrices
 *   - rds.ts      — fetchRdsInstancePrices (with Aurora special-case)
 *   - lambda.ts   — fetchLambdaArchPrices (x86 + arm in parallel)
 *   - cw-logs.ts  — fetchCwLogsStoragePrice
 *
 * All fetchers dispatch to the Pricing MCP tool at runtime — zero hardcoded
 * prices anywhere in this path.
 */
export { fetchEc2InstancePrices } from "./pricing-lookup/ec2.js";
export { fetchRdsInstancePrices } from "./pricing-lookup/rds.js";
export { fetchLambdaArchPrices } from "./pricing-lookup/lambda.js";
export { fetchCwLogsStoragePrice } from "./pricing-lookup/cw-logs.js";
