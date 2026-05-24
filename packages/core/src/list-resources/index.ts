/**
 * Barrel for the shared list-resources module — types, parseArn, and
 * provision-log loader used by both apps/cli and apps/mcp-server.
 *
 * @see Story 49.2 (Epic 49) — extraction from duplicated per-app copies.
 */

export type { ManagedResource, ProvisionLogEntry } from "./types.js";
export { parseArn } from "./parse-arn.js";
export {
  loadProvisionData,
  PROVISIONS_FILE,
  type ProvisionLookup,
} from "./provision-log.js";
export {
  fetchManagedResources,
  hasManagedByTag,
  type FetchManagedResourcesOptions,
  type RgtaFetcher,
  type RgtaMapping,
  type RgtaTag,
  type ManagedIamRole,
  type BillingEnricher,
  type PricingEnricher,
  type CreatedDateEnricher,
  type StorageEnricher,
  type ResourceUsage,
} from "./fetch-managed-resources.js";
export {
  createListCreatedDateEnricher,
  type CreatedDateEnricherCredentials,
} from "./created-date-enricher.js";
export { createListPricingEnricher } from "./pricing-enricher.js";
export { createCloudWatchStorageEnricher } from "../services/storage-enricher.js";
