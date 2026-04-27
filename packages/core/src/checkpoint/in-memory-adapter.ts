/**
 * W4-01 (Epic 100 Round 3) — InMemoryCheckpointerAdapter.
 *
 * In-memory implementation of CheckpointerPort for development, testing,
 * and as the default adapter used by createGraph when no explicit
 * checkpointer is supplied. Wraps LangGraph's built-in MemorySaver.
 *
 * This adapter is NOT durable — all state is lost when the process exits.
 * For durable local storage use FileDurableCheckpointerAdapter.
 * For production cross-host storage (Epic 102) use the Postgres/DDB adapter.
 *
 * HMAC / 0o600 / atomic-write invariants: not applicable to the in-memory
 * adapter (no disk access). The MemorySaver used by createGraph is the
 * LangGraph interrupt-resume saver, separate from the PlanCheckpoint disk
 * format. This adapter implements the PlanCheckpoint port interface only.
 */

import type { CheckpointerPort } from "../ports/checkpoint-port.js";
import type { PlanCheckpoint } from "../schema/checkpoint.js";
import { isCheckpointExpired } from "./ttl.js";

/**
 * In-memory store keyed by runId.
 * Each adapter instance has its own isolated store (no global state).
 */
export class InMemoryCheckpointerAdapter implements CheckpointerPort {
  private readonly store = new Map<string, PlanCheckpoint>();

  /**
   * Save a checkpoint. Overwrites any existing checkpoint for the same runId.
   * Returns a synthetic reference string (no disk path; in-memory only).
   */
  async save(checkpoint: PlanCheckpoint): Promise<string> {
    this.store.set(checkpoint.runId, checkpoint);
    return `memory:${checkpoint.runId}`;
  }

  /**
   * Load a checkpoint by runId. Returns undefined when not found.
   */
  async load(runId: string): Promise<PlanCheckpoint | undefined> {
    return this.store.get(runId);
  }

  /**
   * List all stored checkpoints, newest-first by created_at.
   */
  async list(): Promise<PlanCheckpoint[]> {
    return [...this.store.values()].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }

  /**
   * Delete the checkpoint for runId. No-op when not found.
   */
  async delete(runId: string): Promise<void> {
    this.store.delete(runId);
  }

  /**
   * Prune expired checkpoints using each entry's ttl_hours + created_at.
   * Returns the number of checkpoints deleted.
   */
  async prune(): Promise<number> {
    let count = 0;
    for (const [runId, cp] of this.store.entries()) {
      if (isCheckpointExpired(cp)) {
        this.store.delete(runId);
        count++;
      }
    }
    return count;
  }
}
