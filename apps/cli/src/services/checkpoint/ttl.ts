/**
 * Checkpoint TTL arithmetic — single source of truth for the expiry check
 * shared by the loader, auto-detect, and pruner modules.
 *
 * Extracted from checkpoint.ts during Wave-6c decomposition.
 */

import type { PlanCheckpoint } from "@assignee/core";

/**
 * Checks whether a checkpoint has exceeded its TTL.
 */
export function isCheckpointExpired(checkpoint: PlanCheckpoint): boolean {
  const createdMs = new Date(checkpoint.created_at).getTime();
  const expiresMs = createdMs + checkpoint.ttl_hours * 60 * 60 * 1000;
  return Date.now() > expiresMs;
}
