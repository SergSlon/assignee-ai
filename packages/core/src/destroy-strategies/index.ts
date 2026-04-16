/**
 * Barrel for the shared destroy-strategies module consumed by both
 * apps/cli and apps/mcp-server.
 *
 * @see Story 49.1 (Epic 49) — extraction from the duplicated per-app copies.
 */

export type {
  AwsConfig,
  DestroyStrategy,
  DestroyContext,
  DestroyHookOutcome,
  DestroyResourceInput,
} from "./types.js";
export { CCAPIStatus, CCAPI_NOT_FOUND_ERROR_CODE } from "./types.js";
export { DestroyStrategyRegistry } from "./registry.js";
export {
  arnIdentifierStrategies,
  slowDeleteStrategies,
} from "./default-strategies.js";
