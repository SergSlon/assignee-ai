/**
 * Public surface of the doctor module (Wave-6b F1 SOLID refactor).
 *
 * Each diagnostic check lives in `./checks/<name>.ts`. Adding a new
 * check = create a new file + register it in `runner.ts`; no edit to
 * the existing check modules (OCP).
 */

export {
  DEFAULT_CHECK_TIMEOUT_MS,
  type CheckStatus,
  type DoctorSubCheck,
  type DoctorSection,
  type DoctorReport,
  type CheckContext,
  type DoctorCheck,
} from "./types.js";

export { worse, rollup, maskKey, padPin, withTimeout } from "./util.js";

export {
  checkCredentials,
  type CredentialsCheckDeps,
} from "./checks/credentials.js";
export { checkBedrock, type BedrockCheckDeps } from "./checks/bedrock.js";
export { checkMcpServers, type McpCheckDeps } from "./checks/mcp-servers.js";
export { checkCache, type CacheCheckDeps } from "./checks/cache.js";
export { checkConfig, type ConfigCheckDeps } from "./checks/config.js";
export {
  checkBestPractices,
  type BpCheckDeps,
} from "./checks/best-practices.js";

export { runDoctor, type RunDoctorDeps } from "./runner.js";
export {
  renderReport,
  renderSection,
  buildSummary,
  statusToExit,
} from "./formatter.js";
