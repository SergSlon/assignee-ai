/**
 * W4-01 (Epic 100 Round 3) — CheckpointerPort: hexagonal port for
 * LangGraph HITL checkpoint adapters.
 *
 * Substrate for Epic 102's Postgres / DynamoDB adapters. Today's
 * adapters: InMemoryCheckpointerAdapter (development / test) and
 * FileDurableCheckpointerAdapter (production-local until Epic 102).
 *
 * Design: thin coordination interface only — save/load/list/delete/prune.
 * The existing `packages/core/src/checkpoint/{store,loader,serializer,
 * pruner}.ts` surface is the concrete file-backed implementation; both
 * the file-durable adapter and the rest of the checkpoint surface
 * co-locate here.
 *
 * HMAC + 0o600 + atomic-write invariants are preserved:
 *   - InMemoryCheckpointerAdapter: no disk writes (test/dev only).
 *   - FileDurableCheckpointerAdapter: delegates to `saveCheckpoint` /
 *     `loadCheckpoint` from `./store.ts`, which owns all three bolts.
 *
 * @see packages/core/src/checkpoint/in-memory-adapter.ts
 * @see packages/core/src/checkpoint/file-durable-adapter.ts
 */

import type { PlanCheckpoint } from "../schema/checkpoint.js";

// ── Port interface ────────────────────────────────────────────────────

/**
 * CheckpointerPort — the hexagonal port for HITL checkpoint storage.
 *
 * Implementations must be:
 *   - Safe for concurrent reads (multiple `load` calls may run in parallel).
 *   - Serialised for writes — callers should not issue concurrent `save`
 *     calls for the same `runId`; adapters may but are not required to
 *     serialize internally.
 *   - Idempotent for `save`: overwriting an existing checkpoint is valid.
 *   - Idempotent for `delete`: deleting a non-existent checkpoint is a no-op.
 */
export interface CheckpointerPort {
  /**
   * Persist a checkpoint. Overwrites any existing checkpoint for the same
   * `runId`. Must be atomic — a concurrent reader should never see a
   * partial write.
   *
   * @param checkpoint - Fully-populated PlanCheckpoint.
   * @returns The storage location reference (file path, DB row key, etc.)
   *   for diagnostic purposes. Callers MUST NOT treat this as a stable
   *   identifier across adapter swaps.
   */
  save(checkpoint: PlanCheckpoint): Promise<string>;

  /**
   * Load a checkpoint by `runId`. Returns `undefined` when not found —
   * callers should treat a missing checkpoint the same as a brand-new run.
   *
   * @param runId - The UUID that uniquely identifies the run.
   */
  load(runId: string): Promise<PlanCheckpoint | undefined>;

  /**
   * List all stored checkpoints, ordered newest-first by `created_at`.
   * Returns an empty array when no checkpoints exist.
   */
  list(): Promise<PlanCheckpoint[]>;

  /**
   * Delete the checkpoint for `runId`. No-op when the checkpoint does not
   * exist — callers should not need to check before calling.
   *
   * @param runId - The UUID of the run whose checkpoint to remove.
   */
  delete(runId: string): Promise<void>;

  /**
   * Remove expired checkpoints (TTL past). Implementations should use the
   * `ttl_hours` + `created_at` fields from each stored checkpoint.
   *
   * @returns The number of checkpoints deleted by the prune pass.
   */
  prune(): Promise<number>;
}
