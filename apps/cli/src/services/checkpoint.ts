/**
 * Checkpoint serialization service — save/load/find domain-level plan checkpoints.
 *
 * This file is a thin barrel; implementation lives in `checkpoint/`.
 * Decomposed in Wave-6c (per-module ≤300 LOC, SOLID OCP boundary).
 *
 * PRESERVES the `.assignee/checkpoints/checkpoint-<runId>.json` file format
 * and redaction allowlist semantics.
 *
 * @see Story 10.1
 * @see architecture.md#Checkpoint Serialization
 */

export { serializeCheckpoint } from "./checkpoint/serializer.js";
export { saveCheckpoint, loadCheckpoint } from "./checkpoint/store.js";
export { loadCheckpointFromPath } from "./checkpoint/loader.js";
export { pruneExpiredCheckpoints } from "./checkpoint/pruner.js";
export { findNewestValidCheckpoint } from "./checkpoint/auto-detect.js";
