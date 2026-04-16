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
