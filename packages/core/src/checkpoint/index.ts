/**
 * Checkpoint sub-barrel — reachable as `@assignee/core/checkpoint`.
 *
 * Lifted from apps/cli during Story 50-4 so apps/mcp-server and
 * apps/cli share a single serialise / load / redact / TTL / pruner
 * implementation. MCP-specific HMAC integrity lives in
 * apps/mcp-server/src/services/checkpoint-hmac.ts (secret is
 * per-process; server-only).
 */

export {
  CHECKPOINT_FILE_PREFIX,
  CHECKPOINT_DEFAULT_TTL_HOURS,
  CHECKPOINT_CLEANUP_SKIP_RECENT_MINUTES,
} from "./constants.js";
export {
  redactSensitiveFields,
  stripRedactedFields,
  REDACTED_VALUE,
} from "./redaction.js";
export { isCheckpointExpired } from "./ttl.js";
export {
  serializeCheckpoint,
  type SerializableGraphState,
} from "./serializer.js";
export { saveCheckpoint, loadCheckpoint } from "./store.js";
export { loadCheckpointFromPath, type CheckpointVerifier } from "./loader.js";
export { pruneExpiredCheckpoints } from "./pruner.js";
export { findNewestValidCheckpoint } from "./auto-detect.js";
